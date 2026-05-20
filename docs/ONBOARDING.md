# NR AI Observatory — New Developer Onboarding

Welcome! This guide walks you through everything you need to get productive in this repo. It covers what the project does, how to set up your environment, how the code is organized, and the conventions we follow.

---

## What Is This Project?

NR AI Observatory provides **observability for AI coding assistants**. When developers use tools like Claude Code, Cursor, Windsurf, or Copilot, this project captures what's happening — tool calls, token usage, costs, efficiency patterns — and sends it all to New Relic.

There are two main integration points:

1. **MCP Server** (`nr-ai-mcp-server`) — Hooks into Claude Code via the Model Context Protocol. It captures every tool call, computes metrics like efficiency scores and anti-pattern detection, and exposes MCP tools that Claude Code can query directly (e.g., "show me my session stats").

2. **SDK Agent** (`nr-ai-agent`) — Wraps Anthropic, Google Gemini, OpenAI, AWS Bedrock, Mistral, and Cohere SDK clients. Your application code uses the wrapped client exactly like the original, but every API call is automatically instrumented and sent to New Relic.

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

This is an npm workspaces monorepo with five main packages and an integration test app.

```
nr-ai-observatory/
  packages/
    shared/              # Transport, events, pricing, harvest scheduler
    nr-ai-agent/         # SDK wrapper for Anthropic/Gemini clients
    nr-ai-mcp-server/    # MCP server + metrics engine + HTTP proxy
    nr-ai-cicd/          # CI/CD integration — nr-ai-report CLI for PR cost reporting
    nr-ai-github-app/    # GitHub App webhook server for PR cost reports (Actions-free)
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

- **Metrics** (`src/metrics/`) — 18 analyzer classes that each receive tool call records and maintain running state. Session tracking, cost tracking, task detection, anti-pattern detection, efficiency scoring, trend analysis, collaboration profiling, proxy metrics, personal coaching, and more.

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

## Configuration Reference

For a complete annotated reference of every config option — including types, defaults, and env variable overrides — see [`packages/nr-ai-mcp-server/example.config.js`](../packages/nr-ai-mcp-server/example.config.js).

### Budget Thresholds

Control spending with optional session/daily/weekly budget caps:

```bash
export NEW_RELIC_AI_SESSION_BUDGET_USD=5.00      # Max spend per session
export NEW_RELIC_AI_DAILY_BUDGET_USD=10.00       # Max spend per day
export NEW_RELIC_AI_WEEKLY_BUDGET_USD=50.00      # Max spend per week
```

The server emits `AiBudgetWarning` events at 50%, 80%, and 100% of each threshold. Set thresholds to `null` (default) for unlimited spending.

### Developer Identity

Set your developer identifier for all NR events. If not set, the server will infer it from `$USER`, `$USERNAME`, or `git config user.name`:

```bash
export NEW_RELIC_AI_MCP_DEVELOPER=john_doe       # Your identifier on all NR events
```

The developer name is normalized to lowercase with underscores (e.g., "John Doe" → "john_doe", "my.user@host" → "my_user_host"). This normalized form is used for exact-match NRQL queries. Set this explicitly if your `$USER` environment variable differs between machines.

### Team and Organization

Tag all telemetry with team/project/org identifiers:

```bash
export NEW_RELIC_AI_TEAM_ID=backend-team         # Your team name
export NEW_RELIC_AI_PROJECT_ID=my-app            # Auto-derived from git remote if not set
export NEW_RELIC_AI_ORG_ID=mycompany             # Organization identifier
```

`projectId` is automatically inferred from your git remote URL (e.g., `github.com:mycompany/my-app.git` → `my-app`). Set explicitly to override.

### Data Retention

Auto-purge old session files to minimize storage:

```bash
export NEW_RELIC_AI_RETAIN_SESSIONS_DAYS=30      # Keep only sessions from last 30 days
```

Default: unlimited retention. Purge happens on server startup.

### Weekly Digest Subscription

Receive automated cost and efficiency summaries:

```bash
export NEW_RELIC_AI_DIGEST_WEBHOOK_URL=https://hooks.slack.com/services/...
export NEW_RELIC_AI_DIGEST_SCHEDULE="0 9 * * 1" # Cron: Mon 9am (default)
```

Or use the MCP tool:
```
nr_observe_subscribe_digest(webhookUrl: "https://hooks.slack.com/services/...")
```

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

## Platform Setup

The MCP server automatically detects and supports multiple AI coding platforms:

| Platform | Setup | Notes |
|----------|-------|-------|
| **Claude Code** | Built-in | Default platform; install hook via `nr-ai-observe install` |
| **Cursor** | Env var: `NEW_RELIC_AI_PLATFORM=cursor` | Auto-detected if Cursor config present |
| **Windsurf** | Env var: `NEW_RELIC_AI_PLATFORM=windsurf` | Auto-detected if Windsurf config present |
| **GitHub Copilot** | Env var: `NEW_RELIC_AI_PLATFORM=copilot` | Requires manual hook setup |
| **Zed** | Env var: `NEW_RELIC_AI_PLATFORM=zed` | Auto-detected from Zed config directory |
| **Continue.dev** | Env var: `NEW_RELIC_AI_PLATFORM=continue` | Auto-detected from Continue config |
| **Amazon Q Developer** | Env var: `NEW_RELIC_AI_PLATFORM=amazonq` | Requires AWS IDE plugin setup |

Each platform normalizes tool calls into the shared `AiToolCall` event schema, so dashboards and tools work uniformly across all platforms.

## Deploying to New Relic

### Deploy dashboards

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts --all
```

Add `--staging` if your account is on the New Relic staging environment. Deploys all seven pre-built dashboards (overview, security, platform comparison, team view, session detail, manager view, personal). Use `--print` to output JSON for manual import via the New Relic UI.

For a self-reflection dashboard pre-filtered to your identity, deploy the personal dashboard with `--developer <name>`:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer <your-name>
```

### Deploy alert conditions

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts
```

Add `--staging` if your account is on the New Relic staging environment. Deploys the "AI Coding Assistant Alerts" policy with five NRQL conditions. Use `--dry-run` to preview without hitting the API. Conditions 1–4 are enabled by default; condition 05 (session budget) is disabled and requires adjusting the threshold in `packages/nr-ai-mcp-server/alerts/conditions/05-session-cost-budget.json`.

To remove all deployed alert conditions:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts --teardown
```

For per-developer alerts scoped to one identity (lower personal thresholds, separate policy from the team one), pass `--developer <name>`:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts --developer <your-name>
```

This creates a separate policy `AI Coding — Personal — <name>` from the JSON files in `packages/nr-ai-mcp-server/alerts/conditions-personal/`, with `developer = '<name>'` injected into every NRQL query. The flag is additive — running without it deploys only the team policy; running with it deploys only the personal policy. Use `--teardown` alongside `--developer` to remove just the personal policy.

Override the personal thresholds in `~/.nr-ai-observe/config.json`:

```json
{
  "alerts": {
    "personal": {
      "dailyCostUsd": 3,
      "sessionCostUsd": 0.75,
      "efficiencyScoreMin": 35,
      "stuckLoopCountMax": 3
    }
  }
}
```

Defaults are `dailyCostUsd: 2`, `sessionCostUsd: 0.50`, `efficiencyScoreMin: 40`, `stuckLoopCountMax: 2`.

### Backfilling session history

If you have existing NR telemetry but no local session files (e.g. because you updated from a version that didn't persist sessions at shutdown), run the backfill script to seed your local history so `nr_observe_get_personal_insights` and the weekly summary tools have data:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx packages/nr-ai-mcp-server/scripts/backfill-sessions.ts \
  --developer <your-name> [--days 90] [--dry-run] [--staging]
```

The script queries NR for your past sessions, reconstructs session summaries, writes them to `~/.nr-ai-observe/sessions/`, and regenerates weekly summaries. Sessions already present locally are skipped. Run `--dry-run` first to see what would be written.

---

## Where to Go for Help

- **[CLAUDE.md](./CLAUDE.md)** — The full technical reference for this repo. Architecture, conventions, every pattern in detail. This is your cheat sheet once you're up to speed.
- **[SECURITY.md](./SECURITY.md)** — Security practices, invariants, and a code review checklist. Read this before your first PR that touches config loading, network requests, subprocess execution, or telemetry fields.
- **[TEST_PATTERNS.md](./TEST_PATTERNS.md)** — Testing conventions, factory patterns, mock strategies. Read this before writing your first test.
- **The code itself** — The best examples of our patterns are in `packages/nr-ai-mcp-server/src/metrics/` (tracker pattern), `packages/shared/src/harvest/` (scheduler/buffer pattern), and the test files alongside them.

Welcome to the project!
