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

| Key              | What it does                            | Where to find it                                                                                                         |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **License key**  | Sends telemetry data _into_ NR (ingest) | NR One → top-right menu → API keys → create a key of type **License**. Long hex string ending in `NRAL`. Not `NRAK-`.    |
| **User API key** | Deploys dashboards and alerts _into_ NR | NR One → top-right menu → API keys → create a key of type **User**. Starts with `NRAK-`. Only needed for deploy scripts. |

You'll also need your **Account ID** — a number visible in the URL when you're logged into NR One: `https://one.newrelic.com/nr1-core?account=`**`12345`**.

---

## Quick Start

### Option A — Interactive setup wizard (recommended for first-time setup)

After cloning the repo and running `npm install && npm run build` (see [setup below](#first-time-repository-setup)), run:

```bash
nr-ai-observe setup
```

The wizard asks for your license key, account ID, environment/region (US, EU, FedRAMP), and optionally a NR API key for team queries. It validates both keys live against New Relic before continuing, and pre-fills your developer name from the email on the API key. Most people are running in under 5 minutes.

If `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_ACCOUNT_ID`, or `NEW_RELIC_API_KEY` are already set in your shell environment, the wizard detects them and lets you press Enter to accept — no copy-paste needed.

### Option B — Manual setup

**Step 1 — Install the hooks**

```bash
nr-ai-observe install \
  --license-key YOUR_LICENSE_KEY \
  --account-id YOUR_ACCOUNT_ID
```

This registers a hook in your Claude Code settings so every tool call is captured automatically. You only run this once.

**Step 2 — Deploy dashboards** _(optional but recommended)_

Replace `NRAK-...` with your user API key and `12345` with your account ID:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all
```

This creates 7 dashboards in your NR account. Find them under **Dashboards** → search "AI Coding".

> **Staging vs production:** Use your account's license key and account ID from whichever environment you're targeting — both work. Add `--staging` if your account is on `staging-one.newrelic.com`, `--eu` for EU region accounts, or omit both flags for standard production (`one.newrelic.com`). Don't mix keys across environments (a production license key won't ingest to staging and vice versa).

**Step 3 — Restart Claude Code and verify**

Restart Claude Code, then type this into the chat:

> _Can you call the `nr_observe_get_session_stats` tool and show me the result?_

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
> _Quick fix — set a user-writable npm prefix (keeps your existing Node.js):_
>
> ```bash
> npm config set prefix ~/.npm-global
> export PATH="$HOME/.npm-global/bin:$PATH"   # also add to ~/.zshrc or ~/.bash_profile
> npm link
> ```
>
> _Recommended — use nvm (better if you switch Node versions):_
>
> ```bash
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
> # restart your shell, then:
> nvm install 24 && nvm use 24
> npm install && npm run build && npm link
> ```
>
> Do not use `sudo npm link` — it creates root-owned files that break future `npm install` runs.

---

## Talking to the Observatory

Once installed, Claude Code can query live session data on your behalf. Just ask it in plain English — or use the tool names directly:

| What to ask                                                           | What you get back                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| _"Show me my session stats"_ → `nr_observe_get_session_stats`         | Tool call counts, success rate, total duration                                              |
| _"What's my efficiency score?"_ → `nr_observe_get_efficiency_score`   | A 0-100 score with a breakdown of where points were lost                                    |
| _"How much has this session cost?"_ → `nr_observe_get_cost_breakdown` | USD cost broken down by tool type and AI model                                              |
| _"Any budget warnings?"_ → `nr_observe_get_budget_status`             | Current spend vs. your configured caps (if set)                                             |
| _"Any wasteful patterns?"_ → `nr_observe_get_anti_patterns`           | Detected inefficiencies — repeated reads, blind edits, stuck loops                          |
| _"Any recommendations?"_ → `nr_observe_get_recommendations`           | Personalized suggestions for this session                                                   |
| _"How am I doing this week?"_ → `nr_observe_get_personal_insights`    | A narrative coaching report vs. your own historical baseline (requires 2+ weeks of history) |

Everything also flows into your New Relic dashboards automatically — you don't have to ask Claude to see it there.

---

## Dashboards

After deploying, you'll have seven dashboards in NR One:

| Dashboard               | What it shows                                                   |
| ----------------------- | --------------------------------------------------------------- |
| **Overview**            | Session stats, efficiency score, cost summary, top tools        |
| **Session Detail**      | Every tool call in a specific session, in order                 |
| **Personal**            | 30-day self-reflection view scoped to one developer             |
| **Team View**           | Aggregated cost and efficiency across multiple developers       |
| **Manager View**        | Team-level cost by developer with no tool-call content visible  |
| **Platform Comparison** | Side-by-side metrics across Claude Code, Cursor, Windsurf, etc. |
| **Security Audit**      | Audit trail of sensitive file access and destructive commands   |

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

### Terraform (IaC alternative)

A Terraform module in `terraform/` deploys all 7 dashboards and the full alert policy as an alternative to the deploy scripts — useful for GitOps workflows or when you want state tracking. See [ADVANCED.md — Terraform Deployment](./docs/ADVANCED.md#terraform-deployment) for usage.

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
  "sessionBudgetUsd": 1.0,
  "dailyBudgetUsd": 5.0,
  "weeklyBudgetUsd": 20.0
}
```

### Key settings

| Setting              | What it does                                                                                                                                                                 | Default      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `developer`          | Your identifier on all NR events. Automatically normalized to lowercase with underscores — e.g., "John Doe" → "john_doe". Falls back to `$USER` or your git name if not set. | Inferred     |
| `collectorHost`      | Region override: `null` = US (default), `'eu'` = EU, `'gov'` = FedRAMP/GovCloud. The wizard auto-detects from your license key prefix and lets you confirm.                  | `null` (US)  |
| `nrApiKey`           | User API key (`NRAK-...`) for NerdGraph queries (team summaries, dashboard/alert deploy). The wizard prompts for it and validates it live.                                   | Not set      |
| `sessionBudgetUsd`   | Emits a warning event at 50%, 80%, 100% of this amount per session                                                                                                           | No limit     |
| `dailyBudgetUsd`     | Daily spend cap                                                                                                                                                              | No limit     |
| `weeklyBudgetUsd`    | Weekly spend cap                                                                                                                                                             | No limit     |
| `retainSessionsDays` | Auto-deletes local session files older than N days                                                                                                                           | Keep forever |
| `teamId`             | Tags all events with your team name for team dashboards                                                                                                                      | Not set      |
| `projectId`          | Tags all events with a project name (auto-derived from your git remote URL if not set)                                                                                       | Auto-derived |
| `digestWebhookUrl`   | Slack webhook URL for weekly cost and efficiency summaries                                                                                                                   | Not set      |

All settings can also be set via environment variables — see [example.config.js](./example.config.js) for the full annotated reference.

### OTLP Transport

To export telemetry to other OpenTelemetry-compatible backends (Datadog, Grafana Cloud, Honeycomb, or New Relic's OTLP endpoint), or to enable an inbound OTLP receiver in proxy mode, see [ADVANCED.md](./docs/ADVANCED.md#otlp-transport).

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

**With Claude Code** (default): the server runs via the MCP connection (`--stdio`). You don't launch it manually — Claude Code starts it automatically when you open a session, because `nr-ai-observe install` registered it as an MCP server. The dashboard stays alive as long as your Claude Code session is open.

**Standalone** (no Claude Code required): pass `--local` to run the dashboard server directly, without an MCP transport. This is useful for testing the dashboard, running it during a non-Claude session, or as a persistent background process.

```bash
npm run build          # build once
node dist/index.js --local
# or:
npm run dev            # shortcut: assumes dist/ already built
npm run dev:all        # build + start in one step
npm run start:local    # alias for npm run dev
```

Open `http://127.0.0.1:7777` in your browser. The process stays alive until you press Ctrl+C.

The dashboard has six views:

- **Today** — live KPIs, sparkline of tool latencies, recent calls, anti-pattern alerts.
- **Sessions** — list of past sessions with a per-session timeline of every tool call.
- **History** — weekly efficiency and daily spend trends.
- **Audit** — every classified tool call (sensitive file access, destructive commands, external network), with a JSONL export button.
- **Settings** — edit developer name, team ID, budget caps, and session retention from the browser (no config file editing required).
- **Alerts** — live budget spend vs. caps, editable personal alert thresholds, and Slack digest configuration.

Run `nr-ai-observe setup` to choose a mode interactively.

---

## Local Alerts

Local-mode users get threshold alerting evaluated in-process — no New Relic dependency. Rules live at `~/.nr-ai-observe/alerts/rules.json`; a starter set is copied into place by the setup wizard.

For the full list of rule types, channel options, alert log configuration, and live reload behavior, see [ADVANCED.md](./docs/ADVANCED.md#local-alerts).

---

## Weekly Digest

Register a Slack webhook to receive a weekly summary every Monday morning:

In Claude Code, ask: _"Call `nr_observe_subscribe_digest` with this webhook URL: `https://hooks.slack.com/services/...`"_

Or set it in your config file as `digestWebhookUrl`, or configure it directly from the **Alerts** tab in the local dashboard.

---

## Supported Platforms

| Platform           | How to enable                                          |
| ------------------ | ------------------------------------------------------ |
| Claude Code        | `nr-ai-observe install` (automatic)                    |
| Cursor             | Set `NEW_RELIC_AI_PLATFORM=cursor` in your environment |
| Windsurf           | Set `NEW_RELIC_AI_PLATFORM=windsurf`                   |
| GitHub Copilot     | Set `NEW_RELIC_AI_PLATFORM=copilot`                    |
| Zed                | Set `NEW_RELIC_AI_PLATFORM=zed`                        |
| Continue.dev       | Set `NEW_RELIC_AI_PLATFORM=continue`                   |
| Amazon Q Developer | Set `NEW_RELIC_AI_PLATFORM=amazonq`                    |

---

## Glossary

**MCP (Model Context Protocol)** — A standard that lets AI assistants like Claude Code discover and call external tools. The Observatory registers itself as an MCP server so Claude Code can call it directly.

**License key** — A NR credential for _sending_ data into New Relic. Looks like a long hex string (e.g., `175cae4b...`). Found under API Keys in NR One.

**User API key** — A NR credential for _reading_ data and managing resources (dashboards, alerts). Starts with `NRAK-`. Create one under API Keys in NR One.

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

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — Development setup, architecture, conventions, testing, and end-to-end verification
- **[ADVANCED.md](./docs/ADVANCED.md)** — OTLP export, local alerts, per-developer alerts, session backfill, Terraform deployment
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

| Command                | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `npm run build`        | Build TypeScript server + Vite web dashboard               |
| `npm run build:server` | Build only the TypeScript server (`tsc --build`)           |
| `npm run build:web`    | Build only the Vite web dashboard (output: `dist/web/`)    |
| `npm test`             | Run all tests                                              |
| `npm run lint`         | Check code style                                           |
| `npm run format`       | Auto-format code                                           |
| `npm run dev`          | Start local dashboard (assumes pre-built `dist/`)          |
| `npm run dev:all`      | Build then start local dashboard                           |
| `npm run dev:full`     | Build backend, then run backend + Vite dev server together |
| `npm run start:local`  | Alias for `npm run dev`                                    |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide, conventions, and architecture.

---

**Questions?** Start with [CONTRIBUTING.md](./CONTRIBUTING.md) or open an issue.
