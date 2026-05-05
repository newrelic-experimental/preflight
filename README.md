# nr-ai-observatory

Observability for AI coding assistants. Captures tool calls, token usage, cost, and developer workflow patterns from Claude Code, Cursor, Windsurf, and Copilot — and sends everything to New Relic.

## Documentation

- [Requirements](#requirements)
- [Installing the MCP server](#installing-the-mcp-server)
  - [Step 1: Install the package](#step-1-install-the-package)
  - [Step 2: Run the installer](#step-2-run-the-installer)
  - [Step 3: Restart Claude Code](#step-3-restart-claude-code)
  - [Step 4: Verify the install](#step-4-verify-the-install)
  - [Manual install](#manual-install)
  - [Uninstall](#uninstall)
- [Installing the dashboards](#installing-the-dashboards)
  - [Available dashboards](#available-dashboards)
  - [Import via New Relic UI](#import-via-new-relic-ui)
  - [Import via NerdGraph API](#import-via-nerdgraph-api)
- [Configuration](#configuration)
  - [Config file](#config-file)
  - [Environment variables](#environment-variables)
  - [Advanced: proxy upstreams](#advanced-proxy-upstreams)
- [Building from source](#building-from-source)
- [Testing](#testing)
- [Packages](#packages)
- [Resources](#resources)

---

## Requirements

- **Node.js**: v24 (install via `nvm install && nvm use`)
- **Claude Code**: installed and working
- **New Relic account**: a [license key](https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/#license-key) (40-character ingest key starting with your region prefix) and your account ID (the number shown in the URL bar on one.newrelic.com)

---

## Installing the MCP server

The installer registers two things in your Claude Code configuration:

1. **Hook scripts** — `nr-ai-observe pre-tool` / `nr-ai-observe post-tool` run before and after every tool call, writing events to a local buffer file.
2. **MCP server** — `nr-ai-mcp-server --stdio` is added as an MCP tool provider, giving Claude Code access to 16 observability tools like `nr_observe_get_session_stats`.

### Step 1: Install the package

```bash
npm install -g nr-ai-mcp-server
```

Verify the binaries are available:

```bash
nr-ai-observe --version
nr-ai-mcp-server --version
```

> **Building from source?** See [Building from source](#building-from-source) and use `npm link` or full paths instead of the global install.

### Step 2: Run the installer

Pass your New Relic license key and account ID to write credentials and configure Claude Code in one step:

```bash
nr-ai-observe install \
  --license-key YOUR_LICENSE_KEY \
  --account-id YOUR_ACCOUNT_ID
```

This command:

- Writes `~/.claude/settings.json` — adds `PreToolUse` and `PostToolUse` hooks
- Writes `~/.mcp.json` — registers the `nr-ai-observability` MCP server
- Writes `~/.nr-ai-observe/config.json` — stores your New Relic credentials

If you prefer to scope the install to a single project instead of your whole user account:

```bash
nr-ai-observe install \
  --license-key YOUR_LICENSE_KEY \
  --account-id YOUR_ACCOUNT_ID \
  --project
```

The `--project` flag writes to `.claude/settings.json` and `.mcp.json` in the current working directory, so only that project is instrumented.

The installer is idempotent — it's safe to run again if you need to update credentials or if a prior run was interrupted. It will not duplicate hooks or MCP entries.

### Step 3: Restart Claude Code

Close and reopen Claude Code (or the terminal session running it). The new hooks and MCP server take effect on the next startup.

### Step 4: Verify the install

In a new Claude Code session, ask:

> "Can you call `nr_observe_get_session_stats` and show me the result?"

Claude Code should invoke the MCP tool and return a JSON summary of the current session. If the tool isn't found, check that `~/.mcp.json` contains the `nr-ai-observability` entry (see [Manual install](#manual-install) below).

To confirm events are reaching New Relic, run a NRQL query in your account after a few minutes of usage:

```sql
SELECT count(*) FROM AiToolCall SINCE 30 minutes ago
```

---

### Manual install

If you prefer to configure things yourself — or if you need to audit exactly what the installer does — here are the equivalent manual steps.

#### 1. Create the config file

Create `~/.nr-ai-observe/config.json` (create the directory if it doesn't exist):

```json
{
  "licenseKey": "YOUR_LICENSE_KEY",
  "accountId": "YOUR_ACCOUNT_ID"
}
```

Protect the file so only your user can read it:

```bash
chmod 600 ~/.nr-ai-observe/config.json
```

#### 2. Register the hook scripts

Edit `~/.claude/settings.json` (create it if it doesn't exist) and add the `hooks` block. If you already have a `hooks` key, merge the entries rather than replacing them:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "nr-ai-observe pre-tool" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "nr-ai-observe post-tool" }
        ]
      }
    ]
  }
}
```

The empty `matcher` string matches every tool, so all tool calls are captured.

#### 3. Register the MCP server

Edit `~/.mcp.json` (create it if it doesn't exist) and add the `nr-ai-observability` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "nr-ai-observability": {
      "command": "nr-ai-mcp-server",
      "args": ["--stdio"]
    }
  }
}
```

For project-scoped installs, use `.mcp.json` in your project root and `.claude/settings.json` in `.claude/settings.json` within your project root instead.

#### 4. Restart Claude Code

---

### Uninstall

Remove the hooks and MCP server entry:

```bash
nr-ai-observe uninstall
```

For a project-scoped install:

```bash
nr-ai-observe uninstall --project
```

This removes the hook entries and `nr-ai-observability` MCP server from the relevant config files. It does not delete `~/.nr-ai-observe/` — remove that directory manually if you want to clear stored credentials and session data.

---

## Installing the dashboards

Five pre-built New Relic dashboards are included in `packages/nr-ai-mcp-server/dashboards/`. Import whichever ones are relevant to your use case.

### Available dashboards

| File | Title | What it shows |
|------|-------|---------------|
| `ai-coding-assistant-overview.json` | AI Coding Assistant — Overview | Session-level summary: tool call counts, success rates, duration, cost, efficiency score, anti-patterns, top tools |
| `ai-coding-assistant-team-view.json` | AI Coding Assistant — Team View | Cross-developer cost, efficiency scores, task completion, anti-pattern trends — requires multiple developers reporting to the same NR account |
| `ai-coding-assistant-security.json` | AI Coding Assistant — Security Audit | Audit trail of sensitive file access, destructive commands, external network requests, and security alerts |
| `ai-coding-assistant-platform-comparison.json` | AI Coding Assistant — Platform Comparison | Side-by-side comparison of Claude Code, Cursor, Windsurf, Copilot — all widgets faceted by `platform` |
| `ai-coding-assistant-session-detail.json` | AI Coding Assistant — Session Detail | Per-session drill-down: tool call timeline, cost, task attribution, files read/modified, anti-pattern breakdown |

All dashboards use `accountIds: []` in their NRQL queries, which tells New Relic to use the account ID from the import context. You do not need to edit the JSON files before importing.

### Import via New Relic UI

This is the simplest method — no extra tools required.

1. Log in to [one.newrelic.com](https://one.newrelic.com).
2. Click **Dashboards** in the left nav.
3. Click the **Import dashboard** button in the top-right corner.
4. Copy the full contents of the dashboard JSON file and paste it into the import dialog.
5. Click **Import**.

Repeat for each dashboard you want to install.

To find your imported dashboards later, go to **Dashboards** and search for "AI Coding Assistant".

### Import via NerdGraph API

Use this method to automate imports, import multiple dashboards at once, or integrate with CI/CD.

You need a [User API Key](https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/#user-key) (not the license key — this is the key starting with `NRAK-`).

#### Prepare the mutation

The NerdGraph `dashboardCreate` mutation takes the dashboard JSON as its `dashboard` argument. Open the [NerdGraph API Explorer](https://api.newrelic.com/graphiql) and run:

```graphql
mutation($accountId: Int!, $dashboard: DashboardInput!) {
  dashboardCreate(accountId: $accountId, dashboard: $dashboard) {
    entityResult {
      guid
      name
    }
    errors {
      description
      type
    }
  }
}
```

With variables:

```json
{
  "accountId": YOUR_ACCOUNT_ID_AS_INTEGER,
  "dashboard": <contents of the JSON file>
}
```

> The dashboard JSON files are already in the correct `DashboardInput` shape — paste the file contents directly as the `dashboard` variable value.

#### Import all dashboards with curl

```bash
ACCOUNT_ID="YOUR_ACCOUNT_ID"
API_KEY="YOUR_USER_API_KEY"
DASHBOARDS_DIR="packages/nr-ai-mcp-server/dashboards"

for file in "$DASHBOARDS_DIR"/*.json; do
  name=$(basename "$file")
  dashboard=$(cat "$file")
  query='mutation($accountId: Int!, $dashboard: DashboardInput!) { dashboardCreate(accountId: $accountId, dashboard: $dashboard) { entityResult { guid name } errors { description } } }'

  echo "Importing $name..."
  curl -s -X POST https://api.newrelic.com/graphql \
    -H "Content-Type: application/json" \
    -H "API-Key: $API_KEY" \
    -d "$(jq -nc --argjson accountId "$ACCOUNT_ID" --argjson dashboard "$dashboard" --arg query "$query" \
      '{query: $query, variables: {accountId: $accountId, dashboard: $dashboard}}')" \
    | jq '.data.dashboardCreate'
done
```

This requires `curl` and `jq`. For EU accounts, replace `api.newrelic.com` with `api.eu.newrelic.com`.

---

## Configuration

Configuration is loaded with the following priority: **CLI arguments > environment variables > config file > defaults**.

### Config file

Default location: `~/.nr-ai-observe/config.json`

Override with: `nr-ai-mcp-server --config /path/to/config.json`

All fields are optional except `licenseKey` and `accountId`. Example with every field:

```json
{
  "licenseKey": "YOUR_LICENSE_KEY",
  "accountId": "YOUR_ACCOUNT_ID",
  "developer": "alice",
  "appName": "my-project",
  "enabled": true,
  "recordContent": false,
  "storagePath": "/home/alice/.nr-ai-observe",
  "port": 9847,
  "logLevel": "info",
  "harvestEventsMs": 5000,
  "harvestMetricsMs": 60000,
  "proxyUpstreams": []
}
```

Field reference:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `licenseKey` | string | **required** | New Relic ingest license key |
| `accountId` | string | **required** | New Relic account ID (digits only, 1–12 chars) |
| `developer` | string | `$USER` or git user.name | Label attached to all events from this machine |
| `appName` | string | `"nr-ai-mcp-server"` | `app_name` attribute on NR events |
| `enabled` | boolean | `true` | Set `false` to disable all data collection without removing hooks |
| `recordContent` | boolean | `false` | Record raw tool input/output content in events. Off by default for privacy |
| `storagePath` | string | `~/.nr-ai-observe` | Directory for local session storage and buffer file |
| `port` | number | `9847` | HTTP port used in proxy mode (ignored in `--stdio` mode) |
| `logLevel` | string | `"info"` | `debug`, `info`, `warn`, or `error` — logs go to stderr |
| `harvestEventsMs` | number | `5000` | How often (ms) to flush buffered events to New Relic |
| `harvestMetricsMs` | number | `60000` | How often (ms) to flush aggregated metrics to New Relic |
| `proxyUpstreams` | array | `[]` | Upstream MCP servers for proxy mode — see [Advanced: proxy upstreams](#advanced-proxy-upstreams) |

### Environment variables

Environment variables override config file values:

| Variable | Config key | Notes |
|----------|-----------|-------|
| `NEW_RELIC_LICENSE_KEY` | `licenseKey` | |
| `NEW_RELIC_ACCOUNT_ID` | `accountId` | |
| `NEW_RELIC_AI_MCP_DEVELOPER` | `developer` | |
| `NEW_RELIC_AI_MCP_APP_NAME` | `appName` | |
| `NEW_RELIC_AI_MCP_ENABLED` | `enabled` | `true`/`1` or `false`/`0` |
| `NEW_RELIC_AI_MCP_RECORD_CONTENT` | `recordContent` | `true`/`1` or `false`/`0` |
| `NEW_RELIC_AI_MCP_STORAGE_PATH` | `storagePath` | |
| `NEW_RELIC_AI_MCP_PORT` | `port` | |
| `NEW_RELIC_AI_MCP_LOG_LEVEL` | `logLevel` | |
| `NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS` | `harvestEventsMs` | |
| `NEW_RELIC_AI_MCP_HARVEST_METRICS_MS` | `harvestMetricsMs` | |
| `NEW_RELIC_HOST` | `collectorHost` | Override NR collector host. Auto-detects EU if license key starts with `eu01` |
| `NEW_RELIC_AI_MCP_PROXY_UPSTREAMS` | `proxyUpstreams` | JSON string of upstream array |

### Advanced: proxy upstreams

In proxy mode (`nr-ai-mcp-server --port 9847`), the server forwards requests to upstream MCP servers while recording latency and tool call metrics. This is useful for instrumenting Cursor, Windsurf, or any client that connects to MCP via HTTP.

Each upstream entry needs a `name`, a `transportType` (`"http"` or `"stdio"`), and either a `url` or `command`:

```json
{
  "proxyUpstreams": [
    {
      "name": "filesystem",
      "transportType": "stdio",
      "command": "/usr/local/bin/mcp-filesystem-server",
      "args": ["/home/alice/projects"]
    },
    {
      "name": "github",
      "transportType": "http",
      "url": "http://localhost:8080"
    }
  ]
}
```

> **Security note:** `stdio` upstreams require an absolute command path and will refuse to start if a relative path is provided.

---

## Building from source

### Prerequisites

- Node.js v24 via nvm (defined in `.nvmrc`)

### First-time setup

```bash
nvm install && nvm use   # activate the right Node version
npm install              # install all workspace dependencies
npm run build            # compile all packages
npm test                 # verify everything works
```

### Rebuild after changes

The `shared` package must be built before `nr-ai-mcp-server` or `nr-ai-agent`:

```bash
npx tsc -b packages/shared
npx tsc -b packages/nr-ai-mcp-server
```

Or rebuild everything:

```bash
npm run build
```

Clean and rebuild from scratch:

```bash
npm run build:clean && npm run build
```

### Using your local build with Claude Code

After building, use the full path to the compiled binaries in your Claude Code config instead of the globally installed versions.

In `~/.mcp.json`:

```json
{
  "mcpServers": {
    "nr-ai-observability": {
      "command": "node",
      "args": ["/absolute/path/to/nr-ai-observatory/packages/nr-ai-mcp-server/dist/index.js", "--stdio"]
    }
  }
}
```

In `~/.claude/settings.json`, use the full path to the collector script:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/nr-ai-observatory/packages/nr-ai-mcp-server/dist/hooks/collector-script.js pre-tool"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/nr-ai-observatory/packages/nr-ai-mcp-server/dist/hooks/collector-script.js post-tool"
          }
        ]
      }
    ]
  }
}
```

---

## Testing

```bash
npm test                                          # Run all tests
npx jest -- packages/shared/                      # Run tests for a single package
npx jest -- src/metrics/cost-tracker.test.ts      # Run a single test file
```

Jest runs with `maxWorkers: 1` to avoid deadlocks in stdio integration tests.

---

## Packages

This is an npm workspaces monorepo with five packages:

| Package | Path | Description |
|---------|------|-------------|
| `@nr-ai-observatory/shared` | `packages/shared` | Transport layer, event buffer, pricing table, harvest scheduler, and configuration utilities shared across all packages |
| `nr-ai-agent` | `packages/nr-ai-agent` | SDK wrapper agent — wraps Anthropic Claude, Google Gemini, and OpenAI clients to automatically capture and report AI usage to New Relic |
| `nr-ai-mcp-server` | `packages/nr-ai-mcp-server` | MCP server + observability platform — hooks into Claude Code to capture tool calls, computes efficiency/cost/anti-pattern metrics, and exposes MCP tools for querying session data |
| `nr-ai-cicd` | `packages/nr-ai-cicd` | CI/CD integration — posts AI coding cost reports to pull requests |
| `test-app` | `packages/test-app` | End-to-end integration test harness for `nr-ai-agent` |

### Dependency graph

```
test-app
  └─> nr-ai-agent
        └─> @nr-ai-observatory/shared

nr-ai-mcp-server
  └─> @nr-ai-observatory/shared

nr-ai-cicd
  └─> @nr-ai-observatory/shared
```

---

## Resources

- [ONBOARDING.md](./ONBOARDING.md) — Start here if you're new to the project
- [CLAUDE.md](./CLAUDE.md) — Full technical reference (architecture, conventions, patterns)
- [SECURITY.md](./SECURITY.md) — Security practices, invariants, and code review checklist
- [TEST_PATTERNS.md](./TEST_PATTERNS.md) — Testing conventions, mock patterns, and exemplary test files
- [METRICS_TABLE.md](./METRICS_TABLE.md) — Every event, metric, and log entry sent to New Relic
- [COMMANDS_TABLE.md](./COMMANDS_TABLE.md) — All MCP tools: parameters, return structure, and computation logic
- [New Relic Docs](https://docs.newrelic.com/)
