---
name: setup
description: Set up New Relic Preflight observability for Kiro — verify the
  preflight/preflight-collector binaries are installed, wire up hook-based
  tool-call capture, and choose local vs. cloud mode. Use right after this
  power connects for the first time, or whenever the user asks to set up,
  configure, or troubleshoot Preflight.
---

# Setup

Run this once, right after `preflight` connects. Everything here happens
through your own tool calls (shell + `nr_observe_*`) — never ask the user to
open a terminal themselves. Deep troubleshooting detail (session-id
resolution, hook exit-code semantics) lives in `references/troubleshooting.md`
— read it if a step below doesn't behave as expected.

## Step 1: Confirm the MCP server connected

Call `nr_observe_health`. If it errors or the tool isn't available, run
`scripts/validate-deps.sh` (or `command -v preflight`) — this power's
`mcp.json` launches the globally-installed `preflight` binary directly
rather than through `npx`, so it needs `npm install -g @newrelic/preflight`
run once first. Then ask the user to reconnect MCP servers from the Kiro MCP
panel, or restart Kiro.

## Step 2: Wire up full tool-call visibility (hooks)

Without this step, `preflight` can only see calls routed to its own
`nr_observe_*` MCP tools — it never sees Read/Write/shell/other-MCP-server
calls. Kiro has a real hook mechanism
([kiro.dev/docs/hooks](https://kiro.dev/docs/hooks)) that fires
`PreToolUse`/`PostToolUse` for every tool call, built-in or MCP — wiring it
up is what makes this power's cost, anti-pattern, and efficiency metrics
reflect the whole session instead of just the `nr_observe_*` calls.

1. **Run `scripts/validate-deps.sh` first, before creating the hook.** A
   `PreToolUse` hook can block the tool call it's guarding
   ([kiro.dev/docs/hooks](https://kiro.dev/docs/hooks) marks `PreToolUse` as
   blocking, `PostToolUse` as not) — a hook command that isn't found on
   `PATH` would fail every tool call in the user's session, not just skip
   Preflight's own observability.
   - If the script reports either binary missing, ask the user to run
     `npm install -g @newrelic/preflight`, then re-run the script. **Do not
     proceed to step 2 until it passes.**
2. Create `.kiro/hooks/preflight-observability.json` in the user's workspace
   (not inside this power's own directory — hooks are workspace-scoped):
   ```json
   {
     "version": "v1",
     "hooks": [
       {
         "name": "Preflight: pre tool call",
         "trigger": "PreToolUse",
         "action": { "type": "command", "command": "preflight-collector" },
         "timeout": 10
       },
       {
         "name": "Preflight: post tool call",
         "trigger": "PostToolUse",
         "action": { "type": "command", "command": "preflight-collector" },
         "timeout": 10
       }
     ]
   }
   ```
   `preflight-collector` tells pre- from post-call apart by reading the hook
   payload's own `hook_event_name` field on stdin, not by a CLI argument —
   the same command works for both entries. Neither hook sets a `matcher`;
   per kiro.dev/docs/hooks, omitting it defaults to always-match, so both
   fire for every tool name. Leave it that way unless the user explicitly
   asks to scope collection down.
3. Verify it's working: make any tool call, then call
   `nr_observe_get_session_timeline` and confirm the call shows up.

## Step 3: Ask which mode and credentials

This power's `mcp.json` sets `NR_AI_MODE: "local"` so it works out of the box
with no New Relic account (dashboard at `http://127.0.0.1:7777`, nothing
leaves the machine). Ask the user, conversationally, whether they'd rather
send data to New Relic instead (`cloud`) or do both.

If `cloud` or `both`, ask for their license key and account ID, then edit
this power's own `mcp.json` directly — add `NEW_RELIC_LICENSE_KEY` and
`NEW_RELIC_ACCOUNT_ID` to the same `env` block, and change `NR_AI_MODE` to
`cloud` or `both`. Edit `mcp.json` itself rather than relying on
shell-profile exports: it's literally the config Kiro reads to launch this
server. Never hardcode real credentials into a shared/source-controlled copy
of `mcp.json` — keep it on `local` mode with no credentials there, and only
fill in real values in the user's own local install. Tell the user to fully
quit and relaunch Kiro so the change is picked up, then verify with
`nr_observe_get_config`.

Leave `NEW_RELIC_AI_PLATFORM: "kiro"` in that `env` block alone. Kiro exposes
no ambient environment variable that identifies it, so without this the
platform auto-detection falls through to the generic MCP adapter, Kiro's tool
names are never normalized, and every file/edit/shell metric silently reports
zero while the raw tool-call count still looks correct. Verify with
`nr_observe_get_config` that `platform` reads `kiro`, not `generic-mcp`.

Do not repeat this setup on every message — only run it once per Kiro
workspace, or when the user explicitly asks to check Preflight's setup.
