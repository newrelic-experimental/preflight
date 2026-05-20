# NR AI Observatory

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
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts --all
```

This creates 7 dashboards in your NR account. Find them under **Dashboards** → search "AI Coding". Add `--staging` if your account is on the New Relic staging environment.

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
npm run build    # Build all packages
```

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
| **Security** | Audit trail of sensitive file access and destructive commands |

### Personal dashboard

Deploy a dashboard pre-filtered to your name (it opens already showing your data):

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts \
  ai-coding-assistant-personal.json --developer your-name
```

---

## Alert Conditions

Optional: get notified in NR when something goes wrong.

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts
```

Add `--staging` if your account is on the New Relic staging environment. This creates five alert conditions: high error rate, session timeout, efficiency drop, cost spike, and budget warning. To remove them, add `--teardown`.

For personal alerts scoped to your developer name:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx packages/nr-ai-mcp-server/scripts/deploy-alerts.ts --developer your-name
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

All settings can also be set via environment variables — see [packages/nr-ai-mcp-server/README.md](./packages/nr-ai-mcp-server/README.md) for the full list.

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
- **[ROADMAP.md](./docs/ROADMAP.md)** — What's been built and what's planned

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
| `npm run build` | Build all packages |
| `npm test` | Run all tests |
| `npm run lint` | Check code style |
| `npm run format` | Auto-format code |

See [ONBOARDING.md](./docs/ONBOARDING.md) for the full development guide, conventions, and architecture.

---

**Questions?** Start with [ONBOARDING.md](./docs/ONBOARDING.md) or open an issue.
