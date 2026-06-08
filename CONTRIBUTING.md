# Contributing to NR AI Coding Observability

This guide covers everything you need to get productive in this repo: environment setup, project architecture, code conventions, testing, and how to verify your changes end-to-end.

---

## What Is This Project?

NR AI Coding Observability provides **observability for AI coding assistants**. When developers use tools like Claude Code, Cursor, Windsurf, or Copilot, this project captures what's happening — tool calls, token usage, costs, efficiency patterns — and sends it all to New Relic.

There are two main integration points:

1. **MCP Server (this repo)** — Hooks into Claude Code via the Model Context Protocol. Captures every tool call, computes metrics like efficiency scores and anti-pattern detection, and exposes MCP tools that Claude Code can query directly.

2. **SDK Agent** — Lives in the separate `nr-ai-typescript-agent` repo. Wraps Anthropic, Google Gemini, OpenAI, AWS Bedrock, Mistral, and Cohere SDK clients so every API call is automatically instrumented.

Both projects share a common transport layer (`src/shared/`, synced from `nr-ai-typescript-shared`) that handles event buffering, metric aggregation, and HTTP delivery to New Relic's APIs.

---

## Development Setup

### Prerequisites

- Node.js v24 (see `.nvmrc`)
- A New Relic account with a license key and account ID (for cloud-path testing)

### First-time setup

```bash
nvm install        # Install the right Node version (v24, from .nvmrc)
nvm use            # Activate it
npm install        # Install dependencies
npm run build      # Build TypeScript and chmod +x the CLI binaries
npm link           # Register nr-ai-observe on PATH (required for Claude Code hooks)
npm test           # Verify everything works
```

To pull the latest changes and rebuild later:

```bash
nr-ai-observe update
```

### Commands

| Command                             | What it does                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run build`                     | Build TypeScript (`tsc --build`) and chmod the CLI binaries                                       |
| `npm run build:clean`               | Remove build output                                                                               |
| `npm test`                          | Run the full Jest suite (`maxWorkers: 1`)                                                         |
| `npm run lint`                      | ESLint over `src/`                                                                                |
| `npm run format`                    | Prettier write                                                                                    |
| `npm run format:check`              | Prettier check (no writes)                                                                        |
| `npm run sync:shared`               | Pull latest source from `../nr-ai-typescript-shared` into `src/shared/` (warns on dirty upstream) |
| `npm run deploy:dashboard`          | Deploy the default NR dashboard                                                                   |
| `npm run deploy:dashboard:all`      | Deploy every pre-built dashboard                                                                  |
| `npm run deploy:dashboard:update`   | Sync every pre-built dashboard in place (preserves GUID/URL)                                      |
| `npm run deploy:dashboard:teardown` | Delete every pre-built dashboard (matches by name; missing = skipped)                             |
| `npm run deploy:alerts`             | Deploy the alert policy + conditions to NR                                                        |
| `npm run deploy:alerts:update`      | Sync conditions on the existing alert policy in place                                             |
| `npm run deploy:alerts:teardown`    | Delete the alert policy and all its conditions                                                    |
| `npm run backfill:sessions`         | Backfill local session JSON files from NR event history                                           |
| `npm run dev`                       | Start local dashboard server (`--local`); assumes `dist/` already built                           |
| `npm run dev:all`                   | Build then start local dashboard (`npm run build && npm run dev`)                                 |
| `npm run start:local`               | Alias for `npm run dev`                                                                           |

To run a single test file:

```bash
npx jest -- src/metrics/cost-tracker.test.ts
npx jest -- src/shared/harvest/harvest-scheduler.test.ts
```

To build directly without the chmod step:

```bash
npx tsc -b .
```

### Working with shared code

`src/shared/` is a **read-only mirror** — never edit it directly here. Make the change in the upstream `nr-ai-typescript-shared` repo, then run `npm run sync:shared` to pull it in and commit the regenerated tree. Only code consumed by **both** this MCP server and `nr-ai-typescript-agent` belongs in shared.

---

## Project Structure

This is a flat single-package repo. Source lives directly under `src/`. There is no `packages/` directory and no npm workspaces.

```
nr-ai-observatory/
  src/
    shared/        # Transport, events, pricing, harvest scheduler (synced from nr-ai-typescript-shared)
    hooks/         # Hook collector + pre/post event pairing
    metrics/       # 19 analyzer classes (session, cost, anti-patterns, efficiency, …)
    tools/         # MCP tool handlers
    proxy/         # HTTP proxy + upstream transports
    storage/       # JSON session and weekly summary persistence
    security/      # Audit trail + SSRF helpers
    tracing/       # OTel span lifecycle
    transport/     # NR ingest manager + log ingest
    platforms/     # 8 platform adapters (Claude Code, Cursor, Windsurf, …)
    digest/        # Slack digest formatter and sender
    install/       # nr-ai-observe install / setup CLI
    alerts/        # Alert TS types (JSON files live in alerts/ at repo root)
  alerts/          # Alert policy + condition JSON definitions
  dashboards/      # Pre-built NR dashboard JSON files
  scripts/         # sync-shared.ts, deploy-dashboard.ts, deploy-alerts.ts, backfill-sessions.ts
```

For a complete annotated tree, see [CLAUDE.md](./CLAUDE.md).

### Shared transport layer (`src/shared/`)

The foundation layer is synced from `nr-ai-typescript-shared`. Provides:

- **Event creation** — `createAiRequest()`, `createAiResponse()`, serialization to NR format
- **Transport** — HTTP clients for New Relic's Events, Metric, and Logs APIs, plus an OTLP/HTTP exporter
- **Harvest scheduler** — Periodic flush of buffered events (5s) and metrics (60s) with bounded retry buffers
- **Token utilities** — Extract token counts from Anthropic/Gemini API responses
- **Pricing** — Calculate USD cost from token counts using model-specific pricing tables
- **Logger** — `createLogger('name')` writes structured JSON to stderr

### MCP server subsystems

- **Hooks** (`src/hooks/`) — Claude Code invokes a hook script on every tool use. The collector writes events to a local JSONL buffer. The event processor drains the buffer, pairs pre/post events, and emits `ToolCallRecord` objects.

- **Metrics** (`src/metrics/`) — 19 analyzer classes that each receive tool call records and maintain running state. Session tracking, cost tracking + forecasting, task detection, anti-pattern detection, efficiency scoring, trend analysis, collaboration profiling, and more.

- **Tools** (`src/tools/`) — MCP tool handlers that query the metric trackers and return results. Registered via `registerTools()` in `src/tools/session-stats.ts`.

- **Proxy** (`src/proxy/`) — HTTP proxy layer that forwards requests to upstream MCP servers while recording latency and tool call metrics.

- **Storage** (`src/storage/`) — Local file persistence for session summaries and weekly aggregations under `~/.nr-ai-observe/`.

- **Security** (`src/security/`) — Audit trail that classifies tool calls and flags sensitive file access or destructive commands; SSRF validation for outbound URLs.

- **Tracing** (`src/tracing/`) — OTel span management. Emits a session root span, intermediate task spans from `TaskDetector` boundaries, and a leaf span per `ToolCallRecord`.

---

## Key Concepts

### ToolCallRecord

The central data type. Every tool call captured by the hooks becomes a `ToolCallRecord` with fields like `toolName`, `durationMs`, `success`, `filePath`, `command`, `exitCode`, etc. This record flows through all metric trackers.

### HarvestScheduler

Events and metrics are buffered in memory and flushed to New Relic on a timer. Events flush every 5 seconds, metrics every 60 seconds. Failed batches are re-queued with a bounded retry buffer. The scheduler handles graceful shutdown by awaiting a final flush.

### Metric Trackers

All trackers follow the same pattern:

```typescript
tracker.recordToolCall(record); // feed data in
tracker.getMetrics(); // read state out
tracker.reset(sessionId); // clear for new session
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
- Never use `as any` — use `as unknown as T` for forced coercions
- Never add `eslint-disable` comments — fix the underlying issue

### File organization

- One module per file, co-located tests: `foo.ts` + `foo.test.ts`
- Files: `kebab-case` naming
- Classes: `PascalCase`, functions: `camelCase`, constants: `SCREAMING_SNAKE_CASE`

### Import order

1. Node.js builtins (`node:fs`, `node:path`)
2. External packages (`@modelcontextprotocol/sdk`, `zod`)
3. _(blank line)_
4. Shared imports (`../shared/index.js`)
5. Local imports (`./types.js`)

### Logging

Every module creates a scoped logger:

```typescript
import { createLogger } from '../shared/index.js';
const logger = createLogger('my-module');
```

Logger writes to **stderr** as JSON. Never write to stdout — it's reserved for the MCP stdio transport.

### Error handling

- Failed network sends re-queue batches for retry (bounded buffer)
- Graceful degradation: if a tracker is unavailable, tools return sensible defaults
- `try/catch` around file I/O operations with logger warnings
- Clock skew protection: `Math.max(0, ...)` on computed durations

---

## Testing

Tests live next to the code they test (`foo.test.ts` alongside `foo.ts`).

### Writing tests

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

See [TEST_PATTERNS.md](./docs/TEST_PATTERNS.md) for the full testing guide.

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

This codebase sends telemetry to New Relic and can spawn child processes and proxy network requests:

- **Redact before you log or send.** Any string that might contain secrets must pass through `redact()` (agent) or `redactSensitive()` (MCP server) before it reaches a logger or NR event.
- **Validate external strings at the boundary.** `accountId` is validated as 1–12 decimal digits at config load. Tool names are truncated and stripped of control characters.
- **Subprocess commands need absolute paths.** `StdioUpstream` rejects relative command names and strips dangerous env vars (`LD_PRELOAD`, etc.) before spawning.
- **HTTP upstream URLs are SSRF-checked.** `HttpUpstream` rejects non-`http:`/`https:` schemes and RFC-1918/loopback hosts.
- **High security mode is absolute.** When `highSecurity=true`, `recordContent` is always `false`. Never bypass this.

See [SECURITY.md](./docs/SECURITY.md) for the full guidelines and code review checklist.

---

## Platform Support

The MCP server automatically detects and supports multiple AI coding platforms:

| Platform           | Setup                                     | Notes                                                      |
| ------------------ | ----------------------------------------- | ---------------------------------------------------------- |
| **Claude Code**    | Built-in                                  | Default platform; install hook via `nr-ai-observe install` |
| **Cursor**         | Env var: `NEW_RELIC_AI_PLATFORM=cursor`   | Auto-detected if Cursor config present                     |
| **Windsurf**       | Env var: `NEW_RELIC_AI_PLATFORM=windsurf` | Auto-detected if Windsurf config present                   |
| **GitHub Copilot** | Env var: `NEW_RELIC_AI_PLATFORM=copilot`  | Requires manual hook setup                                 |
| **Zed**            | Env var: `NEW_RELIC_AI_PLATFORM=zed`      | Auto-detected from Zed config directory                    |
| **Continue.dev**   | Env var: `NEW_RELIC_AI_PLATFORM=continue` | Auto-detected from Continue config                         |
| **Amazon Q**       | Env var: `NEW_RELIC_AI_PLATFORM=amazonq`  | Requires AWS IDE plugin setup                              |

---

## Deploying to New Relic

### Dashboards

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --all
```

Add `--staging` if your account is on the New Relic staging environment (`staging-one.newrelic.com`). Deploys all seven pre-built dashboards. Use `--print` to output JSON for manual import via the NR UI.

For a self-reflection dashboard pre-filtered to your identity:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer <your-name>
```

To replace existing dashboards in place (preserves GUID and URL), add `--update`:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --update
```

To remove all deployed dashboards:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --teardown
```

### Alert conditions

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts
```

Add `--staging` if your account is on the staging environment. Deploys the "AI Coding Assistant Alerts" policy with five NRQL conditions. Use `--dry-run` to preview without hitting the API.

To sync conditions in place on an existing policy (preserves policy ID; matches conditions by name to update, creates new ones, deletes removed ones):

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts --update
```

For per-developer alerts scoped to one identity:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --developer <your-name>
```

This creates a separate policy `AI Coding — Personal — <name>` from `alerts/conditions-personal/`, with `developer = '<name>'` injected into every NRQL query. Use `--teardown --developer <name>` to remove just the personal policy.

To remove all deployed alert conditions:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts --teardown
```

---

## Verifying Your Setup

After making changes, run through these checkpoints to confirm end-to-end behavior. Work through one path (cloud or local) at a time.

### Prerequisites

| Item                                                                     | Check                        |
| ------------------------------------------------------------------------ | ---------------------------- |
| Node.js v24                                                              | `node --version` → `v24.x.x` |
| npm v10+                                                                 | `npm --version` → `10.x.x`   |
| Claude Code (latest)                                                     | Opens and launches           |
| **Cloud path only:** New Relic account with a license key + user API key | See README                   |

> **Staging environment (internal):** The cloud path below targets `staging-one.newrelic.com`. Use staging keys and add `--staging` to every deploy command. Production keys return 401 against the staging API — don't mix them.

### 1. Build and link

```bash
git clone <repo-url>
cd nr-ai-observatory
nvm use
npm install
npm run build
npm link
```

**Checkpoint:** `nr-ai-observe --help` prints the command list. If you see `command not found`, the `npm link` step didn't work.

### 2. Run the setup wizard

```bash
nr-ai-observe setup
```

For cloud path, choose `cloud` and supply your license key, account ID, and (optionally) your user API key. For local path, choose `local`.

**Checkpoint:** `cat ~/.nr-ai-observe/config.json` shows the values you entered.

### 3. Restart Claude Code

Quit and reopen Claude Code. The MCP server starts automatically.

**Checkpoint — MCP connection:** In a new Claude Code session, ask:

> _Call `nr_observe_health` and show me the result._

Expected:

```json
{
  "status": "ok",
  "version": "1.x.x",
  "developer": "your-name",
  "session_id": "some-uuid",
  "uptime_seconds": 3
}
```

If you see `tool not found` or `MCP server unavailable`, the server didn't start. Check Claude Code's MCP output panel (View → Output → MCP) for errors, then re-run `nr-ai-observe install` and restart.

**Checkpoint — local dashboard (local path only):**

```bash
curl -s http://127.0.0.1:7777/api/health
# Expected: {"ok":true,"uptime":<number>}
```

### 4. Generate activity and verify

In Claude Code:

> _Read the file README.md and summarize it in one sentence._

Then:

> _Call `nr_observe_get_session_stats` and show me the result._

Expected: `tool_calls` > 0, non-zero `session_duration_ms`.

**Cloud path:** Open your NR account → Dashboards → search "AI Coding". Within 1–2 minutes:

```sql
SELECT count(*) FROM AiToolCall WHERE developer = 'your-name' SINCE 5 minutes ago
```

Expected: a non-zero count.

**Local path:** Open `http://127.0.0.1:7777` and confirm the Today tab shows tool call count > 0.

### 5. Smoke test anti-pattern detection

> _Read README.md. Read it again. Read it a third time. Now call `nr_observe_get_anti_patterns`._

Expected: a `re_reading` entry for `README.md` with `read_count: 3`.

### Deploy dashboards and alerts (cloud path)

```bash
# Dashboards
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --staging

# Alerts (optional)
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --staging
```

> Re-deploying? Use `--update` to sync in place and avoid creating duplicates.

**Checkpoint:** Open staging NR → Dashboards → search `AI Coding`. You should see 7 dashboards listed.

### Teardown / reset

To remove all hooks and start fresh:

```bash
nr-ai-observe uninstall
rm -rf ~/.nr-ai-observe

# Cloud: remove dashboards and alerts from NR
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --teardown --staging
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --teardown --staging
```

Then restart Claude Code.

---

## Troubleshooting

| Symptom                                    | Likely cause                                          | Fix                                                                                 |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `nr-ai-observe: command not found`         | `npm link` not run                                    | Run `npm link` in the repo root                                                     |
| `nr_observe_health` returns tool-not-found | MCP server not started                                | Restart Claude Code; check MCP output panel                                         |
| No data in NR after 5 minutes              | Wrong license key or account ID                       | Re-run `nr-ai-observe setup` with correct credentials                               |
| Dashboard at 7777 unreachable              | Port in use or mode is not local                      | Check `lsof -i:7777`; confirm `config.json` has `"mode": "local"`                   |
| Hook not firing                            | `nr-ai-observe` not on PATH when Claude Code launched | Run `npm link`, then restart Claude Code                                            |
| `Invalid account ID` in wizard             | Entered a non-numeric value                           | Account IDs are digits only (e.g. `3456789`)                                        |
| `HTTP 401` on deploy                       | Using a production key against staging                | Use a key from `staging-one.newrelic.com` and add `--staging` to the deploy command |

---

## Where to Get Help

- **[CLAUDE.md](./CLAUDE.md)** — Full technical reference: architecture, conventions, every pattern in detail.
- **[SECURITY.md](./docs/SECURITY.md)** — Security practices, invariants, and code review checklist. Read before any PR touching config loading, network requests, subprocess execution, or telemetry fields.
- **[TEST_PATTERNS.md](./docs/TEST_PATTERNS.md)** — Testing conventions, factory patterns, mock strategies.
- **[COMMANDS_TABLE.md](./docs/COMMANDS_TABLE.md)** — All 36 MCP tools with parameters and return schemas.
- **[METRICS_TABLE.md](./docs/METRICS_TABLE.md)** — Every NR event and metric, field definitions, delivery mechanism.
- **The code itself** — Best examples of our patterns: `src/metrics/` (tracker pattern), `src/shared/harvest/` (scheduler/buffer pattern).
