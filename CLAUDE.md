# NR AI Coding Observability: Preflight

Flat single-package repo providing observability for AI coding assistants (MCP server + metrics engine + HTTP proxy). Source lives directly in `src/`. Shared transport/events/pricing code lives in `src/shared/`. All telemetry flows to New Relic.

## Development Commands

```bash
npm run build              # TypeScript build
npm run build:clean        # Clean build output
npm test                   # Run all tests (Jest, maxWorkers: 1)
npm run lint               # ESLint across src/
npm run format             # Prettier (write)
npm run format:check       # Prettier (check only)
```

Build directly:

```bash
npx tsc -b .
```

Run tests for a single file:

```bash
npx jest -- src/metrics/cost-tracker.test.ts
npx jest -- src/shared/harvest/harvest-scheduler.test.ts
```

## Shared Code (`src/shared/`)

**`src/shared/` is a vendored snapshot — do not edit directly.**

**Rules:**

1. **Never edit files under `src/shared/` in this repo.** It is a vendored snapshot. If you find a bug there, open an issue.

## Architecture

### Data Flow (MCP Server — Stdio Mode)

```
Claude Code
  │
  ├─ PreToolUse / PostToolUse hooks
  │    └─> preflight (collector-script.ts)
  │         └─> writes to buffer.jsonl directly (raw fd append)
  │
  └─ MCP stdio connection
       └─> NrMcpServer (server.ts)
            ├─ HookEventProcessor reads buffer.jsonl on poll interval
            │    └─> pairs pre/post → ToolCallRecord
            │         └─> feeds to all metric trackers:
            │              SessionTracker, CostTracker, TaskDetector,
            │              AntiPatternDetector, AuditTrailManager
            │
            ├─ NrIngestManager (HarvestScheduler)
            │    ├─ Events → NR Events API (every 5s)
            │    └─ Metrics → NR Metric API (every 60s)
            │
            └─ MCP Tools (queried by Claude Code)
                 ├─ nr_observe_get_session_stats
                 ├─ nr_observe_get_efficiency_score
                 ├─ nr_observe_get_cost_breakdown
                 ├─ nr_observe_get_anti_patterns
                 ├─ nr_observe_get_recommendations
                 └─ ... (tools listed below)
```

## TypeScript Conventions

### Module System

- ESM throughout (`"type": "module"` in `package.json`)
- `NodeNext` module resolution
- All internal imports use `.js` extensions (required for ESM)
- Strict mode enabled

### Type Patterns

- `interface` for public API contracts and tracker return types
- `type` for unions, intersections, and local aliases
- `readonly` on all interface fields for immutable data shapes
- `Record<string, T>` for dynamic key maps (tool breakdowns, exit code maps)

### Naming

- Files: `kebab-case.ts` (e.g., `session-tracker.ts`, `cost-tracker.test.ts`)
- Classes: `PascalCase` (e.g., `SessionTracker`, `HookEventProcessor`)
- Interfaces: `PascalCase` (e.g., `McpServerConfig`, `FullSessionSummary`)
- Functions: `camelCase` (e.g., `buildSessionSummary`, `parseToolSpecificFields`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `DEFAULT_HARVEST_MS`, `TRACKED_METHODS`)
- Test helpers: `camelCase` with `make` prefix (e.g., `makeRecord`, `makeSummary`, `makeManager`)

### Import Order

1. Node.js builtins (`node:fs`, `node:path`, `node:crypto`)
2. External packages (`@modelcontextprotocol/sdk`, `zod`, `commander`)
3. Blank line
4. Shared module imports (`./shared/index.js` or `../shared/index.js`)
5. Local imports (`./types.js`, `../metrics/session-tracker.js`)

### Logger Pattern

Every module creates a scoped logger at module level:

```typescript
import { createLogger } from '../shared/index.js';
const logger = createLogger('module-name');
```

Logger writes to stderr as JSON. Never write to stdout (reserved for MCP stdio transport).

## Metric Tracker Pattern

Trackers in `src/metrics/` do not share one input shape — they fall into four families depending on how data reaches them:

- **Streaming push (void)** — `recordToolCall(record: ToolCallRecord): void`. The majority shape: `SessionTracker`, `TaskDetector`, `WorkflowRunTracker`, `ContextTracker`, `GitEfficiencyTracker`, and most others.
- **Streaming push (signaling)** — `recordToolCall(record: ToolCallRecord): T`, returning a value the caller acts on immediately instead of only accumulating: `TurnTracker` (returns the turn id), `RetryDetector` (returns `ThrashingAlert | null`). `TurnCostAttributor` fits this same shape but on its other input method — `recordTokenEvent(event: TokenEvent): ClosedTurn | null` — since a turn's cost closes on the token event, not the tool call.
- **Primitive accumulator** — a domain-named method taking specific values instead of a full `ToolCallRecord`, because the input is self-reported (tokens, cost) rather than a raw tool call: `ModelUsageTracker.recordUsage(model, inputTokens, outputTokens, costUsd)`, `CostTracker.recordTokenUsage(usage, model, ctx?)` / `recordEstimatedTokens(...)`, `BudgetTracker.updateCost(...)`.
- **Batch/pull analyzer** — invoked periodically over accumulated history rather than per-call: `AntiPatternDetector.analyze(toolCalls: ToolCallRecord[])`, `EfficiencyScorer.computeScore(task, antiPatterns?)` / `updateScore(...)`.

Whichever family a tracker belongs to, it still:

- Maintains internal state (maps, counters, arrays)
- Exposes a `getMetrics()` method returning a typed snapshot
- Has a corresponding `*.test.ts` file with factory helpers

### `reset()` and the `Resettable` interface

`reset(sessionId: string): void` (the `Resettable` interface, `src/metrics/tracker-contracts.ts`) has no production caller today — no dispatch loop currently calls it. It exists so a future session-boundary dispatcher can clear tracker state without type-checking against each tracker individually, and so tests can reset a tracker between cases. Trackers that implement it: `SessionTracker`, `CostTracker`, `TaskDetector`, `ModelUsageTracker`, `WorkflowRunTracker`, `AntiPatternDetector`, `TaskCompletionTracker`, `TurnTracker`, `RetryDetector`, `EfficiencyScorer`.

### Cross-tracker reads require dispatch order

`TaskDetector` reads `CostTracker.getMetrics()` at task-start and task-close to compute a per-task cost/token delta; `CostTracker` reads `SessionTracker.getMetrics().uniqueFilesWritten` for `costPerFileModified`. Both assume the read-from tracker's cumulative totals only move forward between reads — resetting one tracker independently of the other (e.g. `CostTracker.reset()` while a `TaskDetector` task is active) is logged as a warning rather than allowed to fail silently, but the delta is still clamped to 0 in that case. See the JSDoc on `TaskDetectorOptions.costTracker` and `CostTracker`'s constructor.

## Platform Adapter Pattern

Each adapter in `src/platforms/` implements `PlatformAdapter` (`types.ts`): `normalizeToolCall()`, `mapToolName()`, `getSessionMetadata()`, `getHookInstallInstructions()`, `isSupported()`. `PlatformRegistry.detect()` (`platform-registry.ts`) returns the first registered adapter whose `isSupported()` is `true` — registration order matters, and the generic MCP fallback is always registered last with `isSupported()` hardcoded `true`.

Platform capabilities are not uniform: Claude Code, Kiro, Amazon Q, GitHub Copilot, and GitHub Copilot SDK expose a uniform hook shape that `src/hooks/collector-script.ts` parses into every built-in tool call (Copilot with camelCase `tool_input` keys and VS Code tool names); Cursor and Windsurf expose their own platform-specific hook events, handled by dedicated branches in the same file — all seven are `full-hooks` platforms with real, automatic capture. Zed and Continue.dev have no hook/callback mechanism at all, so Preflight can observe calls made to its own MCP tools but never the platform's built-in file/shell tools (`mcp-tools-only`). The generic-mcp fallback is `self-reported` — observable in principle, but only when the calling MCP client actually reports them. Never invent a tool-name map or setup instructions — every entry must trace to the platform's own documentation or source, cited in a comment. See [ADAPTERS.md](./docs/ADAPTERS.md) for the full per-platform reference (mechanism, detection env vars, tool-map sourcing, known gaps, setup steps).

## MCP Tool Registration

Tools are registered in `src/tools/session-stats.ts` via `registerTools()`, which receives all tracker instances and calls `server.tool()` for each MCP tool. Each tool handler:

1. Reads current state from the relevant tracker(s) via `getMetrics()`
2. Formats the result as a text content block
3. Returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`

Tools are conditionally registered based on available dependencies (e.g., cross-session tools only register when `SessionStore` + `WeeklySummaryGenerator` are available).

### MCP Tools

See [COMMANDS_TABLE.md](./docs/COMMANDS_TABLE.md) for the complete tool catalog (session, cost/budget, workflow/anti-pattern, analytics, cross-session, and digest tools).

## Configuration

Config loading priority: **CLI > environment variables > config file > defaults**.

The config file path defaults to `~/.newrelic-preflight/config.json` or can be passed via `--config`.

Key config interfaces:

- `McpServerConfig` in `src/config.ts`
- `AgentConfig` in `src/shared/config.ts`

### Additional Configuration Fields

Beyond the fields above: per-developer/team/org identifiers, budget caps, digest delivery, session retention, the 8 `otlp.*` OTLP export/receiver fields, and `companionMode` (suppresses `ai.cost.*` gauges and tags cost-bearing Claude Code events when the same org also runs Claude Code's built-in OTel export). See [ADVANCED.md](./docs/ADVANCED.md) for the full field reference, including the legacy flat-key backward-compatibility behavior and the `configVersion` convention.

### Event Types

| Event Type        | Emitted By           | Use Case                                    |
| ----------------- | -------------------- | ------------------------------------------- |
| `AiBudgetWarning` | `BudgetTracker`      | Budget threshold crossed (50%, 80%, 100%)   |
| `AiTurnCost`      | `TurnCostAttributor` | Cost and tokens per tool call and per skill |

### Team Attribution Fields

All MCP server events (`AiToolCall`, `AiCodingTask`, `AiAntiPattern`, `AiMcpToolCall`, `AiProxyRequest`, `AiAuditEvent`) include team attribution fields:

- `team_id` — team identifier (from config)
- `project_id` — project identifier (auto-derived or configured)
- `org_id` — organization identifier (from config)

## Storage

All local persistence lives under `~/.newrelic-preflight/` by default:

| Path                | Format     | Purpose                                                        |
| ------------------- | ---------- | -------------------------------------------------------------- |
| `buffer.jsonl`      | JSONL      | Hook event buffer (written by collector, drained by processor) |
| `sessions/`         | JSON files | Session summaries (`YYYY-MM-DD_sessionId.json`)                |
| `weekly_summaries/` | JSON files | Cross-session weekly aggregations                              |

`collector-script.ts` appends hook events to `buffer.jsonl` directly (raw `openSync`/`writeFileSync`/`closeSync` with `O_APPEND`). `LocalStore` handles the drain side (rename-then-read pattern) and session/weekly-summary persistence.

## Harvest and Ingestion

`HarvestScheduler` (in `src/shared/harvest/`) manages periodic flush of events and metrics to New Relic:

- Events flush every 5 seconds (configurable)
- Metrics flush every 60 seconds (configurable)
- Failed batches are re-queued with bounded retry buffers
- `stop()` is idempotent — concurrent callers await the same flush promise

`NrIngestManager` (in `src/transport/`) wraps `HarvestScheduler` and adds log ingestion.

## Security

See [SECURITY.md](./SECURITY.md) for the full guidelines, invariants, and code review checklist. Key points:

- **Redaction** — `DEFAULT_REDACTION_PATTERNS` in `src/config.ts` covers API keys, Bearer tokens, AWS/Google/npm/Slack secrets, JWTs, and PEM blocks. Apply `redact()` / `redactSensitive()` before any string reaches a log or NR event field.
- **Input validation** — `accountId` is validated as `/^\d{1,12}$/` at config load. `envInt` callers supply `{ min, max }` bounds. Tool names are truncated to 256 chars with control chars stripped.
- **SSRF protection** — `HttpUpstream` rejects non-`http:`/`https:` schemes and RFC-1918/loopback hosts before connecting.
- **Process safety** — `StdioUpstream` requires an absolute command path and strips `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, and related keys from the child env.
- **Storage permissions** — Directories created with `0o700`, files with `0o600`.
- **High security mode** — `highSecurity=true` forces `recordContent=false`; this must never be bypassed.
- **Audit trail** — `AuditTrailManager` classifies every tool call (sensitive file access, destructive commands, external network requests) and persists records to disk in real time.

## Linting

The codebase targets **0 ESLint errors and 0 warnings**. Do not introduce new lint issues when writing or modifying code:

- Never add `eslint-disable` comments to suppress warnings — fix the underlying issue instead
- Never use `as any` — use `as unknown as T` for forced type coercions, or define a typed mock interface
- Never use `: any` as a type annotation — use a concrete type, `unknown`, or a generic
- For jest mock args, use `unknown[]` instead of `any[]` (e.g. `jest.fn<Promise<T>, unknown[]>()`)
- For unused required parameters, prefix with `_` (e.g. `_config`) — configured in `eslint.config.mjs`

Run `npm run lint` before committing to verify the lint target is still met.

## Testing Conventions

- Co-located test files: `foo.ts` → `foo.test.ts` (same directory)
- Jest with `ts-jest/presets/default-esm` preset, `node` environment
- `maxWorkers: 1` to avoid stdio deadlocks
- Tests mock `process.stderr.write` to suppress logger output
- Factory helpers (`makeRecord`, `makeSummary`, etc.) use optional `Partial<T>` overrides
- Fake timers (`jest.useFakeTimers()`) for harvest scheduler and poll interval tests
- Temp directories via `os.tmpdir()` + cleanup in `afterEach` for storage tests
- See [TEST_PATTERNS.md](./docs/TEST_PATTERNS.md) for full conventions

## Git Commit Conventions

- Format: `Type: Short description` (e.g., `Fix #13: Re-queue events on send failure`)
- Types: `Fix`, `Feat`, `Refactor`, `Chore`, `Test`, `Docs`
- Include `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` when AI-assisted
- One logical change per commit

## Pull Requests

- Title: short, under 72 characters
- Body: Summary (bullet points), Test plan (checklist)
- Always run `npm run build && npm test` before opening
