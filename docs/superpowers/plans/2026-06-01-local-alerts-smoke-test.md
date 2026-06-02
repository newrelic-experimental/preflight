# Local-alerts v1.1 — smoke test

Run before opening the PR.

## Setup

```bash
mkdir -p ~/nr-ai-smoke/.nr-ai-observe
cat > ~/nr-ai-smoke/.nr-ai-observe/config.json <<'JSON'
{
  "mode": "local",
  "sessionBudgetUsd": 0.01,
  "alerts": {
    "enabled": true,
    "evaluationIntervalSeconds": 5
  }
}
JSON
cp examples/local-alert-rules.json ~/nr-ai-smoke/.nr-ai-observe/alerts/rules.json
HOME=~/nr-ai-smoke node dist/index.js --stdio &
SERVER_PID=$!
sleep 1
```

## Initial state

- [ ] `curl -s http://127.0.0.1:7777/api/alerts/recent | jq 'length'` returns `0` (or a small number — no firing alerts yet).
- [ ] Open http://127.0.0.1:7777/ in a browser. The Today view loads with NO banner stack at the top.
- [ ] Sidebar "Today" nav has NO red badge.

## Force a banner

In another terminal, drive a session over the $0.01 budget:

- [ ] Use Claude Code attached to this MCP server briefly. Cost ticks up past $0.01 within a few tool calls.
- [ ] Within ~30 s of the threshold breach, an alert banner appears at the top of the dashboard SPA.
- [ ] The Today nav badge shows `1`.
- [ ] The "Recent alerts" panel on Today shows the firing event with severity color, time, value vs threshold.
- [ ] `~/nr-ai-smoke/.nr-ai-observe/alerts/log.jsonl` contains a `"state":"firing"` line for the rule.

## Resolve the threshold

- [ ] Stop Claude Code; restart in a fresh session (cost resets to $0).
- [ ] Within one evaluation interval, the banner disappears and a `"state":"cleared"` line is appended to `alerts/log.jsonl`.

## Live reload

- [ ] Edit `~/nr-ai-smoke/.nr-ai-observe/alerts/rules.json` — change one rule's `"enabled": true` → `false`.
- [ ] Within ~200 ms, the server logs `Alert rules loaded` on stderr.
- [ ] Verify the disabled rule does not re-fire even when its condition would match.

## OS notifications (macOS)

- [ ] Update the config:
  ```json
  { "alerts": { "osNotifications": true } }
  ```
- [ ] Restart the server.
- [ ] Force a critical alert (e.g. drive 4 stuck-loop anti-patterns within 5 min using a busy script) — a native macOS notification appears in the upper-right with the rule name as title.
- [ ] Notifier failures (e.g. revoked Notification permission) log a warning on stderr but DO NOT crash the server.

## Cloud-mode privacy proof

- [ ] Stop the server. Update the config to `"mode": "cloud"` (and add real `licenseKey` / `accountId` for that case to load).
- [ ] Restart the server with `--log-level debug`.
- [ ] `grep -i 'local-alert-engine\|alert rules loaded' <stderr>` returns NO matches — the engine is not constructed in cloud mode.
- [ ] `~/.nr-ai-observe/alerts/log.jsonl` is NOT touched (mtime stays at the previous run).

## Cleanup

```bash
kill $SERVER_PID
rm -rf ~/nr-ai-smoke
```
