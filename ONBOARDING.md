# NR AI Observatory — New Developer Onboarding

Welcome! This guide walks you through everything you need to get productive in this repo. It covers what the project does, how to set up your environment, how the code is organized, and the conventions we follow.

---

## What Is This Project?

NR AI Observatory provides **observability for AI coding assistants**. When developers use tools like Claude Code, Cursor, Windsurf, or Copilot, this project captures what's happening — tool calls, token usage, costs, efficiency patterns — and sends it all to New Relic.

There are two main integration points:

1. **MCP Server** (`nr-ai-mcp-server`) — Hooks into Claude Code via the Model Context Protocol. It captures every tool call, computes metrics like efficiency scores and anti-pattern detection, and exposes MCP tools that Claude Code can query directly (e.g., "show me my session stats").

2. **SDK Agent** (`nr-ai-agent`) — Wraps the Anthropic and Google Gemini SDK clients. Your application code uses the wrapped client exactly like the original, but every API call is automatically instrumented and sent to New Relic.

Both share a common transport layer (`@nr-ai-observatory/shared`) that handles event buffering, metric aggregation, and HTTP delivery to New Relic's APIs.

---

## Getting Started

### Prerequisites

- Node.js v24 (check `.nvmrc`)
- A New Relic account with a license key and account ID
- Access to New Relic's private npm registry ([setup guide](https://source.datanerd.us/commune/npm-setup))

### First-time setup

```bash
nvm install        # Install the right Node version
nvm use            # Activate it
npm install        # Install all workspace dependencies
npm run build      # Build all packages
npm test           # Verify everything works
```

### Useful commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Build all packages (TypeScript) |
| `npm test` | Run the full test suite |
| `npm run lint` | Check for code style issues |
| `npm run format` | Auto-format with Prettier |
| `npm run format:check` | Check formatting without writing |

To build or test a single package:

```bash
npx tsc -b packages/shared && npx tsc -b packages/nr-ai-mcp-server
npx jest -- src/metrics/cost-tracker.test.ts
```

**Important:** Always build `packages/shared` before building any other package — it's a TypeScript project reference that the others depend on.

---

## Project Structure

This is an npm workspaces monorepo with three main packages and an integration test app.

```
nr-ai-observatory/
  packages/
    shared/              # Transport, events, pricing, harvest scheduler
    nr-ai-agent/         # SDK wrapper for Anthropic/Gemini clients
    nr-ai-mcp-server/    # MCP server + metrics engine + HTTP proxy
    test-app/            # E2E integration test for nr-ai-agent
```

### `@nr-ai-observatory/shared`

The foundation layer. Provides:
- **Event creation** — `createAiRequest()`, `createAiResponse()`, serialization to NR format
- **Transport** — HTTP clients for New Relic's Events, Metric, and Logs APIs
- **Harvest scheduler** — Periodic flush of buffered events (5s) and metrics (60s) with retry
- **Token utilities** — Extract token counts from Anthropic/Gemini API responses
- **Pricing** — Calculate USD cost from token counts using model-specific pricing tables
- **Logger** — `createLogger('name')` writes structured JSON to stderr

### `nr-ai-agent`

A lightweight agent that wraps SDK clients:

```typescript
import { init } from 'nr-ai-agent';
const agent = init({ licenseKey: '...', accountId: '12345' });
const client = agent.wrapAnthropicClient(rawAnthropicClient);
// Use client normally — agent captures everything in the background
await agent.shutdown();
```

### `nr-ai-mcp-server`

The largest package. It has several subsystems:

- **Hooks** (`src/hooks/`) — Claude Code invokes a hook script on every tool use. The collector writes events to a local JSONL buffer. The event processor drains the buffer, pairs pre/post events, and emits `ToolCallRecord` objects.

- **Metrics** (`src/metrics/`) — 11 analyzer classes that each receive tool call records and maintain running state. Session tracking, cost tracking, task detection, anti-pattern detection, efficiency scoring, trend analysis, collaboration profiling, and more.

- **Tools** (`src/tools/`) — MCP tool handlers that query the metric trackers and return results. These are the tools that Claude Code can call (e.g., `nr_observe_get_session_stats`).

- **Proxy** (`src/proxy/`) — HTTP proxy layer that forwards requests to upstream MCP servers while recording latency and tool call metrics.

- **Storage** (`src/storage/`) — Local file persistence for session summaries and weekly aggregations.

- **Security** (`src/security/`) — Audit trail that classifies tool calls and flags sensitive file access or destructive commands.

---

## Key Concepts

### ToolCallRecord

The central data type. Every tool call captured by the hooks becomes a `ToolCallRecord` with fields like `toolName`, `durationMs`, `success`, `filePath`, `command`, `exitCode`, etc. This record flows through all metric trackers.

### HarvestScheduler

Events and metrics are buffered in memory and flushed to New Relic on a timer. Events flush every 5 seconds, metrics every 60 seconds. Failed batches are re-queued with a bounded retry buffer. The scheduler handles graceful shutdown by awaiting a final flush.

### Metric Trackers

All trackers follow the same pattern:
```typescript
tracker.recordToolCall(record);    // feed data in
tracker.getMetrics();               // read state out
tracker.reset(sessionId);           // clear for new session
```

Each tracker has a corresponding test file with factory helpers.

### MCP (Model Context Protocol)

The server communicates with Claude Code over stdio using JSON-RPC. It registers tools that Claude Code can discover and invoke. The `@modelcontextprotocol/sdk` package handles the protocol; our code registers tool handlers and implements the business logic.

---

## Code Conventions

### TypeScript

- ESM modules with `.js` import extensions (required for NodeNext resolution)
- Strict mode enabled
- `readonly` on all interface fields
- `interface` for API contracts, `type` for unions and local aliases

### File Organization

- One module per file, co-located tests: `foo.ts` + `foo.test.ts`
- Files use `kebab-case` naming
- Classes use `PascalCase`, functions use `camelCase`
- Module-level constants use `SCREAMING_SNAKE_CASE`

### Logging

Every module creates a scoped logger:
```typescript
import { createLogger } from '@nr-ai-observatory/shared';
const logger = createLogger('my-module');
```
Logger writes to **stderr** as JSON. Never write to stdout — it's reserved for the MCP stdio transport.

### Error Handling

- Failed network sends re-queue batches for retry (bounded buffer)
- Graceful degradation: if a tracker is unavailable, tools return sensible defaults
- `try/catch` around file I/O operations with logger warnings
- Clock skew protection: `Math.max(0, ...)` on computed durations

---

## Testing

Tests live next to the code they test (`foo.test.ts` alongside `foo.ts`).

### Writing tests

Most test files follow this pattern:

```typescript
let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return { id: 'rec-001', toolName: 'Read', /* sensible defaults */ ...overrides };
}
```

- Suppress logger output by mocking `process.stderr.write`
- Use `make*` factory functions with optional `Partial<T>` overrides
- Use `jest.useFakeTimers()` for anything time-dependent
- Create temp directories for storage tests, clean up in `afterEach`

See [TEST_PATTERNS.md](./TEST_PATTERNS.md) for the full testing guide.

### Before opening a PR

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] You've reviewed your own diff

---

## Git Workflow

### Commit messages

```
Type: Short description

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

Types: `Fix`, `Feat`, `Refactor`, `Chore`, `Test`, `Docs`

### Branches

Use descriptive branch names: `yourname/short-description` or `fix/issue-description`.

---

## Security

This codebase sends telemetry to New Relic and can spawn child processes and proxy network requests. A few things to be aware of before your first contribution:

- **Redact before you log or send.** Any string that might contain secrets — error messages from upstream APIs, tool output, file content — must pass through `redact()` (agent) or `redactSensitive()` (MCP server) before it reaches a logger or NR event. The patterns cover API keys, tokens, PEM blocks, JWTs, and more.
- **Validate external strings at the boundary.** `accountId` is validated as 1–12 decimal digits at config load. Tool names are truncated and stripped of control characters. Any new field that goes into a URL path or NR event should get the same treatment.
- **Subprocess commands need absolute paths.** `StdioUpstream` rejects relative command names and strips dangerous dynamic-linker env vars (`LD_PRELOAD`, etc.) before spawning a child process.
- **HTTP upstream URLs are SSRF-checked.** `HttpUpstream` rejects non-`http:`/`https:` schemes and RFC-1918/loopback hosts. Don't bypass this for convenience.
- **High security mode is absolute.** When `highSecurity=true`, `recordContent` is always `false`. This invariant must never be bypassed.

See [SECURITY.md](./SECURITY.md) for the full guidelines, code examples, and a code review checklist.

---

## Deploying to New Relic

### Deploy dashboards

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts --all
```

Deploys all five pre-built dashboards (overview, security, platform comparison, team view, session detail). Use `--print` to output JSON for manual import via the New Relic UI.

### Deploy alert conditions

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts
```

Deploys the "AI Coding Assistant Alerts" policy with five NRQL conditions. Use `--dry-run` to preview without hitting the API. Conditions 1–4 are enabled by default; condition 05 (session budget) is disabled and requires adjusting the threshold in `packages/nr-ai-mcp-server/src/alerts/conditions/05-session-cost-budget.json`.

To remove all deployed alert conditions:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts --teardown
```

---

## Where to Go for Help

- **[CLAUDE.md](./CLAUDE.md)** — The full technical reference for this repo. Architecture, conventions, every pattern in detail. This is your cheat sheet once you're up to speed.
- **[SECURITY.md](./SECURITY.md)** — Security practices, invariants, and a code review checklist. Read this before your first PR that touches config loading, network requests, subprocess execution, or telemetry fields.
- **[TEST_PATTERNS.md](./TEST_PATTERNS.md)** — Testing conventions, factory patterns, mock strategies. Read this before writing your first test.
- **The code itself** — The best examples of our patterns are in `packages/nr-ai-mcp-server/src/metrics/` (tracker pattern), `packages/shared/src/harvest/` (scheduler/buffer pattern), and the test files alongside them.

Welcome to the project!
