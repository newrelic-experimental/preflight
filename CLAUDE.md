# NR AI Observatory

An npm workspaces monorepo providing observability for AI coding assistants. Three packages: `@nr-ai-observatory/shared` (transport, events, pricing), `nr-ai-agent` (SDK client wrappers for Anthropic/Gemini), and `nr-ai-mcp-server` (MCP server + metrics engine + HTTP proxy). All telemetry flows to New Relic.

## Development Commands

```bash
npm run build              # TypeScript build (all packages via project references)
npm run build:clean        # Clean build output
npm test                   # Run all tests (Jest, maxWorkers: 1)
npm run lint               # ESLint across all packages
npm run format             # Prettier (write)
npm run format:check       # Prettier (check only)
```

Build a single package (shared must be built first — it's a project reference):

```bash
npx tsc -b packages/shared && npx tsc -b packages/nr-ai-mcp-server
npx tsc -b packages/shared && npx tsc -b packages/nr-ai-agent
```

Run tests for a single file:

```bash
npx jest -- src/metrics/cost-tracker.test.ts
npx jest -- packages/shared/src/harvest/harvest-scheduler.test.ts
```

## Project Structure

```
nr-ai-observatory/
  packages/
    shared/                             # @nr-ai-observatory/shared
      src/
        config.ts                       # AgentConfig loader (env > file > defaults)
        logger.ts                       # createLogger() — stderr JSON logger
        pricing.ts / pricing-data.ts    # Token pricing tables (Anthropic, Gemini)
        tokens.ts                       # Token extraction/accumulation
        timing.ts                       # RequestTimer for latency measurement
        errors.ts                       # Error classification, retry logic
        events/                         # NR event creation and serialization
        harvest/                        # EventBuffer, MetricAggregator, HarvestScheduler
        transport/                      # HTTP clients for Events, Metric, and Logs APIs

    nr-ai-agent/                        # nr-ai-agent
      src/
        agent.ts                        # NrAiAgent class + singleton init()
        wrappers/
          anthropic.ts                  # Wraps Anthropic client (messages.create/stream)
          gemini.ts                     # Wraps Google Gemini client (generateContent)

    nr-ai-mcp-server/                   # nr-ai-mcp-server
      src/
        index.ts                        # CLI entry point (parseArgs, stdio vs proxy mode)
        server.ts                       # NrMcpServer — MCP server over stdio transport
        config.ts                       # McpServerConfig loader
        hooks/
          collector-script.ts           # nr-ai-observe binary (hook event collector)
          event-processor.ts            # Pairs pre/post hook events into ToolCallRecords
          tool-parsers.ts               # INPUT_PARSERS / OUTPUT_PARSERS for tool fields
        metrics/                        # 11 analyzer classes
          session-tracker.ts            # Per-session tool call tracking
          cost-tracker.ts               # Token cost calculation (per-model)
          task-detector.ts              # Task boundary detection
          anti-patterns.ts              # Thrashing, re-reads, blind edits, stuck loops
          efficiency-score.ts           # Composite efficiency score
          trend-analyzer.ts             # Weekly trend analysis
          collaboration-profile.ts      # Developer collaboration patterns
          claudemd-tracker.ts           # CLAUDE.md change impact tracking
          cost-per-outcome.ts           # Cost breakdown by outcome type
          prompt-feedback.ts            # Feedback collection engine
          recommendation-engine.ts      # Personalized optimization recommendations
        platforms/                      # Platform adapters
          claude-code-adapter.ts        # Claude Code
          cursor-adapter.ts             # Cursor IDE
          windsurf-adapter.ts           # Windsurf IDE
          copilot-adapter.ts            # GitHub Copilot
          generic-mcp-adapter.ts        # Generic MCP
          platform-registry.ts          # Registry + factory
        proxy/                          # HTTP proxy layer
          proxy-manager.ts              # HTTP server, routing, interception
          upstream-http.ts              # HTTP upstream transport
          upstream-stdio.ts             # Stdio upstream transport (child process)
        storage/                        # Local file persistence
          local-store.ts                # JSONL buffer file + atomic drain
          session-store.ts              # Session history (YYYY-MM-DD_sessionId.json)
          weekly-summary.ts             # Cross-session weekly aggregation
        security/
          audit-trail.ts                # Security audit trail (sensitive files, destructive commands)
        tools/                          # MCP tool handlers
          session-stats.ts              # registerTools() + session stat tools
          cost-tools.ts                 # Cost analysis tools
          workflow-tools.ts             # Workflow analysis + feedback tools
          cross-session-tools.ts        # Cross-session analysis tools
        transport/
          nr-ingest.ts                  # NrIngestManager (events + metrics + logs)
          log-ingest.ts                 # Log ingestion with buffering
        install/                        # Claude Code hook installation CLI
        dashboards/                     # Pre-built NR dashboard JSON files

    test-app/                           # E2E integration test for nr-ai-agent
      src/index.ts                      # Exercises full agent pipeline
```

## Architecture

### Data Flow (MCP Server — Stdio Mode)

```
Claude Code
  │
  ├─ PreToolUse / PostToolUse hooks
  │    └─> nr-ai-observe (collector-script.ts)
  │         └─> writes to buffer.jsonl (LocalStore)
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
                 └─ ... (20+ tools total)
```

### Data Flow (Agent — SDK Wrapper)

```
Application code
  └─> agent.wrapAnthropicClient(client) / agent.wrapGeminiClient(client)
       └─> intercepted SDK calls
            ├─> token extraction + cost calculation
            ├─> event creation (AiRequest, AiResponse, AiMessage)
            └─> HarvestScheduler → NR Events API / Metric API
```

### Package Dependencies

- `shared` has zero runtime dependencies (pure TypeScript)
- `nr-ai-agent` depends on `shared`; peer-depends on `@anthropic-ai/sdk` and `@google/genai`
- `nr-ai-mcp-server` depends on `shared`, `@modelcontextprotocol/sdk`, `zod`, `commander`

## TypeScript Conventions

### Module System
- ESM throughout (`"type": "module"` in all package.json files)
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
4. Internal package imports (`@nr-ai-observatory/shared`)
5. Local imports (`./types.js`, `../metrics/session-tracker.js`)

### Logger Pattern
Every module creates a scoped logger at module level:
```typescript
import { createLogger } from '@nr-ai-observatory/shared';
const logger = createLogger('module-name');
```
Logger writes to stderr as JSON. Never write to stdout (reserved for MCP stdio transport).

## Metric Tracker Pattern

All 11 metric trackers in `src/metrics/` follow the same shape:

```typescript
class XxxTracker {
  constructor(options?: XxxOptions);
  recordToolCall(record: ToolCallRecord): void;  // or similar input method
  getMetrics(): XxxMetrics;                       // returns current state
  reset(sessionId: string): void;                 // clears state for new session
}
```

Each tracker:
- Receives `ToolCallRecord` objects from the event processor
- Maintains internal state (maps, counters, arrays)
- Exposes a `getMetrics()` method returning a typed snapshot
- Has a corresponding `*.test.ts` file with factory helpers

## MCP Tool Registration

Tools are registered in `src/tools/session-stats.ts` via `registerTools()`, which receives all tracker instances and calls `server.tool()` for each MCP tool. Each tool handler:
1. Reads current state from the relevant tracker(s) via `getMetrics()`
2. Formats the result as a text content block
3. Returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`

Tools are conditionally registered based on available dependencies (e.g., cross-session tools only register when `SessionStore` + `WeeklySummaryGenerator` are available).

## Configuration

Config loading priority: **CLI > environment variables > config file > defaults**.

The config file path defaults to `~/.nr-ai-observe/config.json` or can be passed via `--config`.

Key config interfaces:
- `McpServerConfig` in `nr-ai-mcp-server/src/config.ts`
- `AgentConfig` in `shared/src/config.ts`

## Storage

All local persistence lives under `~/.nr-ai-observe/` by default:

| Path | Format | Purpose |
|------|--------|---------|
| `buffer.jsonl` | JSONL | Hook event buffer (written by collector, drained by processor) |
| `sessions/` | JSON files | Session summaries (`YYYY-MM-DD_sessionId.json`) |
| `weekly_summaries/` | JSON files | Cross-session weekly aggregations |

`LocalStore` handles atomic buffer operations (append, drain with rename-then-read pattern).

## Harvest and Ingestion

`HarvestScheduler` (in `shared`) manages periodic flush of events and metrics to New Relic:
- Events flush every 5 seconds (configurable)
- Metrics flush every 60 seconds (configurable)
- Failed batches are re-queued with bounded retry buffers
- `stop()` is idempotent — concurrent callers await the same flush promise

`NrIngestManager` (in `nr-ai-mcp-server`) wraps `HarvestScheduler` and adds log ingestion.

## Security

See [SECURITY.md](./SECURITY.md) for the full guidelines, invariants, and code review checklist. Key points:

- **Redaction** — `DEFAULT_REDACTION_PATTERNS` in `nr-ai-mcp-server/src/config.ts` covers API keys, Bearer tokens, AWS/Google/npm/Slack secrets, JWTs, and PEM blocks. Apply `redact()` / `redactSensitive()` before any string reaches a log or NR event field.
- **Input validation** — `accountId` is validated as `/^\d{1,12}$/` at config load. `envInt` callers supply `{ min, max }` bounds. Tool names are truncated to 256 chars with control chars stripped.
- **SSRF protection** — `HttpUpstream` rejects non-`http:`/`https:` schemes and RFC-1918/loopback hosts before connecting.
- **Process safety** — `StdioUpstream` requires an absolute command path and strips `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, and related keys from the child env.
- **Storage permissions** — Directories created with `0o700`, files with `0o600`.
- **High security mode** — `highSecurity=true` forces `recordContent=false`; this must never be bypassed.
- **Audit trail** — `AuditTrailManager` classifies every tool call (sensitive file access, destructive commands, external network requests) and persists records to disk in real time.

## Testing Conventions

- Co-located test files: `foo.ts` → `foo.test.ts` (same directory)
- Jest with `ts-jest/presets/default-esm` preset, `node` environment
- `maxWorkers: 1` to avoid stdio deadlocks
- Tests mock `process.stderr.write` to suppress logger output
- Factory helpers (`makeRecord`, `makeSummary`, etc.) use optional `Partial<T>` overrides
- Fake timers (`jest.useFakeTimers()`) for harvest scheduler and poll interval tests
- Temp directories via `os.tmpdir()` + cleanup in `afterEach` for storage tests
- See [TEST_PATTERNS.md](./TEST_PATTERNS.md) for full conventions

## Git Commit Conventions

- Format: `Type: Short description` (e.g., `Fix #13: Re-queue events on send failure`)
- Types: `Fix`, `Feat`, `Refactor`, `Chore`, `Test`, `Docs`
- Include `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` when AI-assisted
- One logical change per commit

## Pull Requests

- Title: short, under 72 characters
- Body: Summary (bullet points), Test plan (checklist)
- Always run `npm run build && npm test` before opening
