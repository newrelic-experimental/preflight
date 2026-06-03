# New Relic AI Coding Observability

**Observability for AI coding assistants.** Captures every action your AI coding tool takes — file reads, edits, commands, searches — and sends the data to New Relic so you can see exactly what's happening, how much it costs, and where it's wasting time.

Think of it like Google Analytics for your AI pair programmer.

## What It Does

- **Tracks every action** — sees every file the AI reads, every command it runs, every edit it makes
- **Tracks costs** — calculates USD spend per session, day, and week, broken down by model
- **Detects waste** — catches inefficiencies like re-reading the same file repeatedly, making edits without reading first, or running the same failing command in a loop
- **Measures efficiency** — computes a 0-100 score per task based on how directly the AI worked toward the goal
- **Sends to New Relic** — all data lands in your NR account as queryable events and metrics, ready for dashboards and alerts

---

## Before You Start

You need three things before installation.

### 1. An AI coding tool

This works with **Claude Code**, Cursor, Windsurf, GitHub Copilot, Zed, Continue.dev, or Amazon Q Developer. The examples below use Claude Code, which has the deepest integration.

### 2. Node.js v24

Open a terminal and run:

```bash
node --version
```

If it shows `v24.x.x`, you're set. If not, install it from [nodejs.org](https://nodejs.org) or via nvm:

```bash
nvm install 24 && nvm use 24
```

### 3. A New Relic account with two keys

You use two different NR keys at different points:

| Key | What it does | Where to find it |
|-----|-------------|-----------------|
| **License key** | Sends telemetry data *into* NR | NR One → top-right menu → API keys → create a **License** key |
| **User API key** | Deploys dashboards and alerts *into* NR | NR One → top-right menu → API keys → create a **User** key (starts with `NRAK-`) |

You'll also need your **Account ID** — a number visible in the URL when you're logged into NR One: `https://one.newrelic.com/nr1-core?account=`**`12345`**.

---

## Quick Start

### Option A — Interactive setup wizard (recommended for first-time setup)

After cloning the repo and running `npm install && npm run build` (see [setup below](#first-time-repository-setup)), run:

```bash
nr-ai-observe setup
```

The wizard asks for your license key, account ID, and a name for yourself, then installs the hooks and optionally deploys dashboards. Most people are running in under 5 minutes.

### Option B — Manual setup

**Step 1 — Install the hooks**

```bash
nr-ai-observe install \
  --license-key YOUR_LICENSE_KEY \
  --account-id YOUR_ACCOUNT_ID
```

This registers a hook in your Claude Code settings so every tool call is captured automatically. You only run this once.

**Step 2 — Deploy dashboards** *(optional but recommended)*

Replace `NRAK-...` with your user API key and `12345` with your account ID:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all
```

This creates 7 dashboards in your NR account. Find them under **Dashboards** → search "AI Coding". Add `--staging` if your account is on the New Relic staging environment, or `--eu` for accounts on the EU region.

**Step 3 — Restart Claude Code and verify**

Restart Claude Code, then type this into the chat:

> *Can you call the `nr_observe_get_session_stats` tool and show me the result?*

If you get back a response with tool call counts and timing data, it's working.

---

## First-Time Repository Setup

```bash
git clone <repo-url>
cd nr-ai-observatory
nvm use          # Switch to the right Node version
npm install      # Install all dependencies
npm run build    # Compile TypeScript
npm link         # Register nr-ai-observe binary on PATH (required for hooks)
```

> **`npm link` permission error?** If you see `EACCES: permission denied` pointing at `/usr/local/lib/node_modules`, your system Node.js is installed in a root-owned directory. Pick one fix:
>
> *Quick fix — set a user-writable npm prefix (keeps your existing Node.js):*
> ```bash
> npm config set prefix ~/.npm-global
> export PATH="$HOME/.npm-global/bin:$PATH"   # also add to ~/.zshrc or ~/.bash_profile
> npm link
> ```
> *Recommended — use nvm (better if you switch Node versions):*
> ```bash
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
> # restart your shell, then:
> nvm install 24 && nvm use 24
> npm install && npm run build && npm link
> ```
> Do not use `sudo npm link` — it creates root-owned files that break future `npm install` runs.

---

## Talking to the Observatory

Once installed, Claude Code can query live session data on your behalf. Just ask it in plain English — or use the tool names directly:

| What to ask | What you get back |
|-------------|------------------|
| *"Show me my session stats"* → `nr_observe_get_session_stats` | Tool call counts, success rate, total duration |
| *"What's my efficiency score?"* → `nr_observe_get_efficiency_score` | A 0-100 score with a breakdown of where points were lost |
| *"How much has this session cost?"* → `nr_observe_get_cost_breakdown` | USD cost broken down by tool type and AI model |
| *"Any budget warnings?"* → `nr_observe_get_budget_status` | Current spend vs. your configured caps (if set) |
| *"Any wasteful patterns?"* → `nr_observe_get_anti_patterns` | Detected inefficiencies — repeated reads, blind edits, stuck loops |
| *"Any recommendations?"* → `nr_observe_get_recommendations` | Personalized suggestions for this session |
| *"How am I doing this week?"* → `nr_observe_get_personal_insights` | A narrative coaching report vs. your own historical baseline (requires 2+ weeks of history) |

Everything also flows into your New Relic dashboards automatically — you don't have to ask Claude to see it there.

---

## Dashboards

After deploying, you'll have seven dashboards in NR One:

| Dashboard | What it shows |
|-----------|--------------|
| **Overview** | Session stats, efficiency score, cost summary, top tools |
| **Session Detail** | Every tool call in a specific session, in order |
| **Personal** | 30-day self-reflection view scoped to one developer |
| **Team View** | Aggregated cost and efficiency across multiple developers |
| **Manager View** | Team-level cost by developer with no tool-call content visible |
| **Platform Comparison** | Side-by-side metrics across Claude Code, Cursor, Windsurf, etc. |
| **Security Audit** | Audit trail of sensitive file access and destructive commands |

### Personal dashboard

Deploy a dashboard pre-filtered to your name (it opens already showing your data):

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts \
  ai-coding-assistant-personal.json --developer your-name
```

### Updating or removing dashboards

To replace existing dashboards in place after pulling new fixes (preserves the dashboard's GUID and URL), add `--update`:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --update
```

To delete the deployed dashboards, add `--teardown`. Dashboards are matched by name; missing ones are skipped:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --teardown
```

---

## Alert Conditions

Optional: get notified in NR when something goes wrong.

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts
```

Add `--staging` if your account is on the New Relic staging environment, or `--eu` for accounts on the EU region. This creates five alert conditions: daily cost spike, low efficiency score, stuck loop rate, anti-pattern rate, and session cost budget. To remove them, add `--teardown`.

To apply changes to alert JSONs without losing the existing policy, add `--update`. This syncs conditions in place (matched by name): updates existing ones, creates new ones, and deletes any that have been removed locally:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --update
```

For personal alerts scoped to your developer name:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --developer your-name
```

---

## Configuration

The easiest way to configure is through the setup wizard (`nr-ai-observe setup`). To edit manually, open `~/.nr-ai-observe/config.json`:

```json
{
  "licenseKey": "175cae4b...",
  "accountId": 12345,
  "developer": "your-name",
  "sessionBudgetUsd": 1.00,
  "dailyBudgetUsd": 5.00,
  "weeklyBudgetUsd": 20.00
}
```

### Key settings

| Setting | What it does | Default |
|---------|-------------|---------|
| `developer` | Your identifier on all NR events. Automatically normalized to lowercase with underscores — e.g., "John Doe" → "john_doe". Falls back to `$USER` or your git name if not set. | Inferred |
| `sessionBudgetUsd` | Emits a warning event at 50%, 80%, 100% of this amount per session | No limit |
| `dailyBudgetUsd` | Daily spend cap | No limit |
| `weeklyBudgetUsd` | Weekly spend cap | No limit |
| `retainSessionsDays` | Auto-deletes local session files older than N days | Keep forever |
| `teamId` | Tags all events with your team name for team dashboards | Not set |
| `projectId` | Tags all events with a project name (auto-derived from your git remote URL if not set) | Auto-derived |
| `digestWebhookUrl` | Slack webhook URL for weekly cost and efficiency summaries | Not set |

All settings can also be set via environment variables — see [example.config.js](./example.config.js) for the full annotated reference.

### OTLP Transport (Optional)

By default, the Observatory sends telemetry to New Relic's proprietary Events API and Metrics API. You can optionally export to **any OpenTelemetry-compatible backend** — Datadog, Grafana Cloud, Honeycomb, a self-hosted OpenTelemetry Collector, or New Relic's OTLP endpoint — without losing the NR path.

Add these settings to `~/.nr-ai-observe/config.json`:

```json
{
  "otlpEndpoint": "https://otlp.nr-data.net",
  "otlpHeaders": { "api-key": "YOUR_LICENSE_KEY" },
  "transport": "both"
}
```

| Setting | What it does | Options |
|---------|-------------|---------|
| `otlpEndpoint` | OTLP/HTTP endpoint URL | **New Relic**: US: `https://otlp.nr-data.net`, EU: `https://otlp.eu01.nr-data.net`. Or use any backend's OTLP URL (Datadog, Grafana, Honeycomb, etc.) |
| `otlpHeaders` | Extra HTTP headers for authentication | **New Relic**: `{ "api-key": "YOUR_LICENSE_KEY" }`. **Datadog**: `{ "dd-api-key": "YOUR_DATADOG_API_KEY" }`. Consult your backend's docs. |
| `transport` | How to send telemetry | `"nr-events-api"` (default, NR only), `"otlp"` (OTLP only), `"both"` (simultaneous export to NR and OTLP) |

#### Inbound OTLP Receiver (Proxy Mode)

When running in proxy mode, you can also enable an **inbound OTLP receiver** that acts as a local OpenTelemetry Collector. Any OTel-instrumented app pointing at `http://localhost:4318` will have its telemetry enriched with the current coding session context and forwarded to NR, linking application traces to the AI session that produced them.

```json
{
  "otlpReceiverEnabled": true,
  "otlpReceiverPort": 4318,
  "otlpForwardEndpoint": "https://otlp.nr-data.net",
  "otlpForwardHeaders": { "api-key": "YOUR_LICENSE_KEY" }
}
```

| Setting | What it does | Default |
|---------|-------------|---------|
| `otlpReceiverEnabled` | Enable the local OTLP/HTTP receiver | `false` |
| `otlpReceiverPort` | Port the receiver listens on | `4318` |
| `otlpForwardEndpoint` | Where enriched payloads are forwarded. Set to `null` to receive and enrich only. | `https://otlp.nr-data.net` (when `licenseKey` is set) |
| `otlpForwardHeaders` | HTTP headers added to every forwarded request | `{ "api-key": <licenseKey> }` |

---

## Updating

To pull the latest changes and rebuild in one step:

```bash
nr-ai-observe update
```

This runs `git pull` followed by `npm run build` in the repo directory. Restart Claude Code afterwards to pick up the new version.

---

## Uninstalling

To remove the Observatory hooks and MCP server from Claude Code:

```bash
nr-ai-observe uninstall
```

This removes the hooks from your user-level Claude Code settings and deregisters the MCP server. A timestamped backup of your settings is saved automatically before any changes are made.

If you installed at the project level, add `--project`:

```bash
nr-ai-observe uninstall --project
```

Restart Claude Code after uninstalling for the changes to take effect.

### Removing dashboards and alerts

If you deployed dashboards or alerts, tear them down separately:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --teardown

NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --teardown
```

### Removing local data

Session history and configuration are stored in `~/.nr-ai-observe/`. To remove everything:

```bash
rm -rf ~/.nr-ai-observe
```

### Unlinking the binary

If you registered the CLI globally via `npm link`, remove it with:

```bash
npm unlink -g nr-ai-observatory
```

---

## Local mode

If you'd rather not ship telemetry to New Relic, set `mode: 'local'` in your config:

```json
{
  "mode": "local"
}
```

In local mode:

- The MCP server does **not** construct `NrIngestManager` and never makes outbound HTTP calls to NR.
- An embedded dashboard boots at **http://127.0.0.1:7777** (configurable via `dashboard.port` or `NR_AI_DASHBOARD_PORT`).
- All telemetry stays in `~/.nr-ai-observe/` on your machine.
- `licenseKey` and `accountId` are not required.

The server still runs via Claude Code's MCP connection (`--stdio`). You don't launch it manually — Claude Code starts it automatically when you open a session, because `nr-ai-observe install` registered it as an MCP server. The dashboard stays alive as long as your Claude Code session is open.

The dashboard has four views:

- **Today** — live KPIs, sparkline of tool latencies, recent calls, anti-pattern alerts.
- **Sessions** — list of past sessions with a per-session timeline of every tool call.
- **History** — weekly efficiency and daily spend trends.
- **Audit** — every classified tool call (sensitive file access, destructive commands, external network), with a JSONL export button.

Run `nr-ai-observe setup` to choose a mode interactively.

---

## Local Alerts

Local-mode users get the same threshold alerting as cloud users — evaluated in-process, no New Relic dependency. The engine reads rules from `~/.nr-ai-observe/alerts/rules.json`, evaluates them on a fixed cadence (default 30 s), and surfaces firing/clearing events through the embedded dashboard.

**Setting up rules.** The `nr-ai-observe setup` wizard offers to copy a starter rule set from `examples/local-alert-rules.json` into place when you choose local or both mode. Re-running setup never overwrites a user-edited rules file.

**Eight rule types are supported:**

| Type | What it checks |
|------|----------------|
| `cost.window` | Cumulative spend in the named period (`session` / `today` / `week`) crosses a USD threshold. |
| `efficiency.below` | Efficiency score has stayed under N for `windowSeconds` continuously. |
| `antipattern.count` | More than N anti-patterns of a chosen type (or any type) in `windowSeconds`. |
| `latency.percentile` | p50/p95/p99 latency for a tool exceeds N ms. |
| `budget.session` / `budget.daily` / `budget.weekly` | Budget threshold reached for the named period (uses configured budget caps). |
| `tool.failure` | Failure rate for a tool exceeds N% in `windowSeconds`. |

**Channels.** Each rule has a `channels` array — `["banner"]` (default) shows a dismissible banner in the dashboard; `["banner", "os"]` also fires a native OS notification (macOS/Linux/Windows) when `alerts.osNotifications` is enabled in config. `[]` is silent (logged only).

**Alert log.** Every fire/clear is appended to `~/.nr-ai-observe/alerts/log.jsonl` (rotated at the configured retention size). The dashboard's "Recent alerts" panel reads this file.

**Live reload.** Editing `rules.json` reloads the rule set within ~200 ms — no server restart needed. One malformed rule is logged and skipped; the rest of the rule set keeps evaluating.

**Configuration knobs** (under `alerts` in the config file or via env vars):

| Field | Env var | Default |
|-------|---------|---------|
| `alerts.enabled` | `NR_AI_ALERTS_ENABLED` | `true` outside cloud-only mode |
| `alerts.evaluationIntervalSeconds` | `NR_AI_ALERTS_INTERVAL_SECONDS` | `30` (5–300) |
| `alerts.osNotifications` | `NR_AI_ALERTS_OS_NOTIFICATIONS` | `false` |
| `alerts.logRetentionMb` | `NR_AI_ALERTS_LOG_RETENTION_MB` | `10` (1–1024) |
| `alerts.rulesPath` | `NR_AI_ALERTS_RULES_PATH` | `~/.nr-ai-observe/alerts/rules.json` |

---

## Weekly Digest

Register a Slack webhook to receive a weekly summary every Monday morning:

In Claude Code, ask: *"Call `nr_observe_subscribe_digest` with this webhook URL: `https://hooks.slack.com/services/...`"*

Or set it in your config file as `digestWebhookUrl`.

---

## Supported Platforms

| Platform | How to enable |
|----------|--------------|
| Claude Code | `nr-ai-observe install` (automatic) |
| Cursor | Set `NEW_RELIC_AI_PLATFORM=cursor` in your environment |
| Windsurf | Set `NEW_RELIC_AI_PLATFORM=windsurf` |
| GitHub Copilot | Set `NEW_RELIC_AI_PLATFORM=copilot` |
| Zed | Set `NEW_RELIC_AI_PLATFORM=zed` |
| Continue.dev | Set `NEW_RELIC_AI_PLATFORM=continue` |
| Amazon Q Developer | Set `NEW_RELIC_AI_PLATFORM=amazonq` |

---

## Glossary

**MCP (Model Context Protocol)** — A standard that lets AI assistants like Claude Code discover and call external tools. The Observatory registers itself as an MCP server so Claude Code can call it directly.

**License key** — A NR credential for *sending* data into New Relic. Looks like a long hex string (e.g., `175cae4b...`). Found under API Keys in NR One.

**User API key** — A NR credential for *reading* data and managing resources (dashboards, alerts). Starts with `NRAK-`. Create one under API Keys in NR One.

**Anti-pattern** — A detected waste pattern. Examples: re-reading the same file multiple times without making changes between reads (the AI lost context and is reloading it), making edits to a file without reading it first (blind edit), running the same failing command in a loop (stuck loop).

**Efficiency score** — A 0-100 number per task. High means the AI worked directly toward the goal. Low means wasted tool calls — repeated reads, blind edits, unnecessary backtracking.

**Token** — The unit AI models use to measure text length for billing. Roughly 3-4 characters per token. One page of text ≈ 500 tokens.

**Hook** — A script that Claude Code calls automatically before and after every tool call. The Observatory uses this to capture tool call data without interrupting your workflow.

---

## Requirements

- **Node.js**: v24 (see `.nvmrc`)
- **New Relic account**: free tier works; you need a license key and a user API key
- **An AI coding tool**: Claude Code, Cursor, Windsurf, Copilot, Zed, Continue.dev, or Amazon Q

---

## Documentation

- **[ONBOARDING.md](./docs/ONBOARDING.md)** — Detailed setup guide and architecture overview
- **[COMMANDS_TABLE.md](./docs/COMMANDS_TABLE.md)** — All MCP tools with parameters and return values
- **[METRICS_TABLE.md](./docs/METRICS_TABLE.md)** — Every event and metric sent to New Relic
- **[SECURITY.md](./docs/SECURITY.md)** — Security practices and audit trail

---

## For Contributors

### Development setup

```bash
nvm install && nvm use
npm install
npm run build
npm test
```

### Common tasks

| Command | Purpose |
|---------|---------|
| `npm run build` | Build TypeScript server + Vite web dashboard |
| `npm run build:server` | Build only the TypeScript server (`tsc --build`) |
| `npm run build:web` | Build only the Vite web dashboard (output: `dist/web/`) |
| `npm test` | Run all tests |
| `npm run lint` | Check code style |
| `npm run format` | Auto-format code |

See [ONBOARDING.md](./docs/ONBOARDING.md) for the full development guide, conventions, and architecture.

---

**Questions?** Start with [ONBOARDING.md](./docs/ONBOARDING.md) or open an issue.
