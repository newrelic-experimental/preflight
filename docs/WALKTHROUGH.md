# NR AI Coding Observability — Installation Walkthrough

> **Internal dogfood guide.** The cloud path targets the **New Relic staging environment** (`staging-one.newrelic.com`). Use staging keys and add `--staging` to every deploy command.

End-to-end testing guide for both the **New Relic (cloud/staging)** and **local** happy paths. Work through one path at a time. Each section ends with a verification checkpoint — don't proceed until it passes.

---

## Before You Start

### Requirements

| Item                                                                     | Check                           |
| ------------------------------------------------------------------------ | ------------------------------- |
| Node.js v24                                                              | `node --version` → `v24.x.x`    |
| npm v10+                                                                 | `npm --version` → `10.x.x`      |
| Claude Code (latest)                                                     | Open it and confirm it launches |
| **Cloud path only:** New Relic account with a license key + user API key | See below                       |

**New Relic keys (cloud path only — use staging keys):**

- **License key** — [staging-one.newrelic.com](https://staging-one.newrelic.com) → top-right menu → **API keys** → create a key of type **License**. Looks like a long hex string ending in `NRAL`.
- **User API key** — same screen, create a key of type **User**. Starts with `NRAK-`. **Must be a staging key** — production keys return 401 against the staging API.
- **Account ID** — visible in the staging URL: `https://staging-one.newrelic.com/nr1-core?account=`**`12345`**

---

## Setup: Clone and Build (both paths)

These steps are identical for both paths. Run them once before testing either path.

```bash
# 1. Clone
git clone <repo-url>
cd nr-ai-coding-observability

# 2. Switch to the right Node version
nvm use          # reads .nvmrc; installs if needed

# 3. Install dependencies
npm install

# 4. Build
npm run build

# 5. Register the binary on your PATH
npm link
```

**Checkpoint:** `nr-ai-observe --help` should print the command list without errors:

```
Usage: nr-ai-observe [options] [command]

Commands:
  install    Configure Claude Code hooks and MCP server...
  uninstall  Remove nr-ai-observe hooks and MCP server...
  setup      Interactive first-run setup...
  update     Pull the latest changes and rebuild...
  schedule   Configure daily auto-updates via launchd (macOS only)
```

If you see `command not found`, the `npm link` step didn't work — retry it, or confirm `node_modules/.bin` is on your PATH.

If you see `EACCES: permission denied` pointing at `/usr/local/lib/node_modules`, your system Node.js is installed in a root-owned directory. Pick one fix:

**Option A — set a user-writable npm prefix** (quick, keeps your existing Node.js):

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add this line to ~/.zshrc or ~/.bash_profile too
npm link
```

**Option B — use nvm** (recommended if you switch Node versions regularly):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# restart your shell, then:
nvm install 24 && nvm use 24
npm install && npm run build && npm link
```

Do **not** use `sudo npm link` — it creates root-owned files that break future `npm install` runs.

---

## Path A — Cloud (New Relic Staging)

### A1. Run the setup wizard

```bash
nr-ai-observe setup
```

Answer the prompts:

| Prompt                                  | What to enter                                    |
| --------------------------------------- | ------------------------------------------------ |
| `Which mode? [local]:`                  | Type `cloud` and press **Enter**                 |
| `New Relic Account ID:`                 | Your account ID (digits only, e.g. `12345`)      |
| `New Relic License Key:`                | Your license key                                 |
| `Developer name [your-username]:`       | Your name or alias — it appears on all NR events |
| `Team ID [optional]:`                   | Press **Enter** to skip                          |
| `Project ID [auto-detect from git]:`    | Press **Enter** to auto-detect                   |
| `Session budget USD [no limit]:`        | Press **Enter** to skip                          |
| `Install Claude Code hooks now? [Y/n]:` | Press **Enter** (yes)                            |
| `Enable daily auto-updates? [Y/n]:`     | Press **Enter** (yes, macOS only)                |
| `Update time (24h HH:MM) [08:00]:`      | Press **Enter** to accept default, or enter time |

**Expected output after hook install:**

```
✓ Claude Code hooks updated: ~/.claude/settings.json
  - Added PreToolUse and PostToolUse hooks
✓ MCP server registered: ~/.mcp.json
  - Added nr-ai-observability MCP server
✓ nr-ai-observe is on your PATH

✓ Setup complete.
  Open Claude Code in a project — the MCP server starts automatically.
  Metrics will appear in your New Relic dashboard within a few minutes.
```

The wizard also prints the dashboard and alerts deploy commands. Copy them — you'll need them in A3.

**Checkpoint:** Confirm the config was written:

```bash
cat ~/.nr-ai-observe/config.json
```

Should show `licenseKey`, `accountId`, `developer`, and `mode: "cloud"`.

---

### A2. Restart Claude Code

Quit Claude Code completely and reopen it. The MCP server starts automatically when Claude Code loads — it reads the `.mcp.json` entry the wizard just wrote.

**Do not** run `nr-ai-mcp-server --stdio` manually. That would start a second process competing with the auto-launched one.

**Checkpoint:** Open a new Claude Code session (in any project directory) and type:

> _Call `nr_observe_health` and show me the result._

Expected response (values will differ):

```json
{
  "status": "ok",
  "version": "1.x.x",
  "developer": "your-name",
  "session_id": "some-uuid",
  "connected_at": "2026-06-03T...",
  "uptime_seconds": 3
}
```

If you see `tool not found` or `MCP server unavailable`, the server didn't start. Check Claude Code's MCP output panel (View → Output → MCP) for errors, then re-run `nr-ai-observe install` and restart again.

---

### A3. Deploy dashboards

Use your **staging** User API key and add `--staging` (required — production keys return 401 against the staging API):

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --staging
```

> **Re-deploying?** Running the command above a second time creates duplicate dashboards. Use `--update` instead to update the existing ones in-place:
>
> ```bash
> NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
>   npx tsx scripts/deploy-dashboard.ts --all --update --staging
> ```

**Expected output:**

```
Targeting staging API: https://staging-api.newrelic.com/graphql
Deploying 7 dashboards...
  ✓ AI Coding — Overview
  ✓ AI Coding — Session Detail
  ✓ AI Coding — Personal
  ✓ AI Coding — Team View
  ✓ AI Coding — Manager View
  ✓ AI Coding — Platform Comparison
  ✓ AI Coding — Security Audit
Done.
```

Optional — deploy alerts:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --staging
```

**Checkpoint:** Open [staging-one.newrelic.com](https://staging-one.newrelic.com) → **Dashboards** → search `AI Coding`. You should see the 7 dashboards listed.

---

### A4. Generate activity and verify data

Back in Claude Code, run a few tool calls to generate telemetry:

> _Read the file README.md and summarize it in one sentence._

Then verify the data is flowing:

**In Claude Code**, ask:

> _Call `nr_observe_get_session_stats` and show me the result._

You should see `tool_calls` > 0 and a non-zero `session_duration_ms`.

**In staging NR One**, open the **AI Coding — Overview** dashboard. Within 1–2 minutes of your first tool call, you should see:

- `AiToolCall` events in the event table
- Tool call count ticking up
- Your developer name in the developer filter

Run a NRQL query to confirm events are landing:

```sql
SELECT count(*) FROM AiToolCall WHERE developer = 'your-name' SINCE 5 minutes ago
```

Expected: a non-zero count.

---

### A5. Verify cost tracking

Ask Claude Code to self-report token usage:

> _Call `nr_observe_report_tokens` with input_tokens=1000, output_tokens=500, model="claude-sonnet-4-6"_

Then check:

> _Call `nr_observe_get_cost_breakdown` and show me the result._

Expected: `total_usd` > 0, `by_model` showing the model you just reported.

---

### A6. Verify anti-pattern detection (optional smoke test)

To confirm anti-pattern detection is live:

> _Read the file README.md. Now read it again. And again. Now call `nr_observe_get_anti_patterns`._

Expected: a `re_reading` pattern for `README.md` with `read_count: 3`.

---

## Path B — Local

### B1. Run the setup wizard

If you already ran Path A, either use a fresh machine or reset first:

```bash
rm ~/.nr-ai-observe/config.json
nr-ai-observe uninstall
```

Then run:

```bash
nr-ai-observe setup
```

Answer the prompts:

| Prompt                                         | What to enter                     |
| ---------------------------------------------- | --------------------------------- |
| `Which mode? [cloud]:`                         | Type `local` and press **Enter**  |
| `Developer name [your-username]:`              | Your name or alias                |
| `Team ID [optional]:`                          | Press **Enter** to skip           |
| `Project ID [auto-detect from git]:`           | Press **Enter** to skip           |
| `Session budget USD [no limit]:`               | Press **Enter** to skip           |
| `Local dashboard port (loopback only) [7777]:` | Press **Enter** (accept default)  |
| `Copy starter alert rules? [Y/n]:`             | Press **Enter** (yes)             |
| `Install Claude Code hooks now? [Y/n]:`        | Press **Enter** (yes)             |
| `Enable daily auto-updates? [Y/n]:`            | Press **Enter** (yes, macOS only) |
| `Update time (24h HH:MM) [08:00]:`             | Press **Enter** to accept default |

**Expected output:**

```
Config written to ~/.nr-ai-observe/config.json
Starter alert rules copied to ~/.nr-ai-observe/alerts/rules.json

✓ Claude Code hooks updated: ~/.claude/settings.json
✓ MCP server registered: ~/.mcp.json
✓ nr-ai-observe is on your PATH

Local mode: open the dashboard at http://127.0.0.1:7777 once Claude Code starts.

✓ Setup complete.
  Open Claude Code in a project — the MCP server starts automatically.
  Metrics will appear at http://127.0.0.1:7777 within ~30 seconds of your first tool call.
```

**Checkpoint:** Confirm the config:

```bash
cat ~/.nr-ai-observe/config.json
```

Should show `"mode": "local"` and `"dashboard": { "port": 7777, ... }`. No `licenseKey` or `accountId` fields.

---

### B2. Restart Claude Code

Quit and reopen Claude Code. The MCP server and embedded dashboard start automatically.

**Checkpoint — MCP:** In a new Claude Code session, type:

> _Call `nr_observe_health` and show me the result._

Expected:

```json
{
  "status": "ok",
  "developer": "your-name",
  "session_id": "some-uuid",
  "connected_at": "...",
  "uptime_seconds": 2
}
```

**Checkpoint — Dashboard:** In a terminal:

```bash
curl -s http://127.0.0.1:7777/api/health
```

Expected:

```json
{"ok":true,"uptime":...}
```

If the port is unreachable: check `lsof -i:7777` for conflicts, or set a different port in `~/.nr-ai-observe/config.json` under `dashboard.port`.

---

### B3. Generate activity and verify the dashboard

In Claude Code, do a few things to create data:

> _Read the file README.md and summarize it in one sentence._

Then open **http://127.0.0.1:7777** in a browser. You should see the dashboard with four tabs:

| Tab          | What to look for                                                 |
| ------------ | ---------------------------------------------------------------- |
| **Today**    | Tool call count > 0, efficiency score visible, recent calls list |
| **Sessions** | At least one session row (the current one)                       |
| **History**  | May be empty on first run — needs multiple sessions              |
| **Audit**    | Entries for the Read call you just made                          |

**Verify MCP stats match:**

In Claude Code:

> _Call `nr_observe_get_session_stats` and show me the result._

The `tool_calls` field should match (approximately) what the Today dashboard shows.

---

### B4. Verify local alerts

The setup wizard copied a starter rule set. Confirm it loaded:

> _Call `nr_observe_get_anti_patterns` after reading the same file three times._

In Claude Code:

> _Read README.md. Read it again. Read it a third time. Now call `nr_observe_get_anti_patterns`._

Expected: a `re_reading` entry. The dashboard's Today view should show an alert banner if the re-reading count exceeds the rule threshold.

---

## Updating

To pull the latest changes and rebuild:

```bash
nr-ai-observe update
```

Then restart Claude Code.

---

## Teardown / Reset (for re-testing)

To remove all hooks and start fresh:

```bash
# Remove hooks from Claude Code settings
nr-ai-observe uninstall

# Clear local data (sessions, config, buffer)
rm -rf ~/.nr-ai-observe

# Cloud (staging): dashboards and alerts stay in NR until deleted.
# Replace NRAK-... with your staging User API key and 12345 with your account ID:
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts --all --teardown --staging
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --teardown --staging
```

Then restart Claude Code.

---

## Quick Troubleshooting

| Symptom                                       | Likely cause                                          | Fix                                                                                       |
| --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `nr-ai-observe: command not found`            | `npm link` not run                                    | Run `npm link` in the repo root                                                           |
| `nr_observe_health` returns tool-not-found    | MCP server not started                                | Restart Claude Code; check MCP output panel                                               |
| No data in NR after 5 minutes                 | Wrong license key or account ID                       | Re-run `nr-ai-observe setup` with correct credentials                                     |
| Dashboard at 7777 unreachable                 | Port in use or mode is not local                      | Check `lsof -i:7777`; confirm `config.json` has `"mode": "local"`                         |
| Hook not firing                               | `nr-ai-observe` not on PATH when Claude Code launched | Run `npm link`, then restart Claude Code                                                  |
| `Invalid account ID` in wizard                | Entered a non-numeric value                           | Account IDs are digits only (e.g. `3456789`)                                              |
| `HTTP 401: authentication required` on deploy | Using a production key against staging                | Use a key created at `staging-one.newrelic.com` and add `--staging` to the deploy command |
