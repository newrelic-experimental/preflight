---
name: setup
description: Set up New Relic Preflight observability for Kiro — verify the
  preflight/preflight-collector binaries are installed, wire up hook-based
  tool-call capture, and choose local vs. cloud mode. Use right after this
  power connects for the first time, or whenever the user asks to set up,
  configure, or troubleshoot Preflight.
---

# Setup

Run this once, right after `preflight` connects. Run the install and
verification steps through your own tool calls (shell + `nr_observe_*`), but
let the user choose: if they would rather run a command (such as
`npm install -g @newrelic/preflight`) themselves, give them the command and
wait for them to confirm. Deep troubleshooting detail (session-id
resolution, hook exit-code semantics) lives in `references/troubleshooting.md`
— read it if a step below doesn't behave as expected.

## Step 1: Confirm the MCP server connected

Call `nr_observe_health`. If it errors or the tool isn't available, note that
this power's `mcp.json` launches `preflight` via `npx -y
@newrelic/preflight@<version> --stdio` — no global install is required for the
MCP tools themselves, so check that `npx` can resolve on `PATH` and reach the
npm registry rather than looking for a global `preflight` binary. (Step 2's
hook wiring is the part that does need a global install — see below.) Then
ask the user to reconnect MCP servers from the Kiro MCP panel, or restart
Kiro.

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
   - If the script reports the binary missing, ask the user to run
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
         "action": { "type": "command", "command": "MCP_CLIENT=kiro preflight-collector" },
         "timeout": 10
       },
       {
         "name": "Preflight: post tool call",
         "trigger": "PostToolUse",
         "action": { "type": "command", "command": "MCP_CLIENT=kiro preflight-collector" },
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

## Step 3: Set the environment variables, one question at a time

This power's `mcp.json` reads every setting from an environment variable, so
nothing is stored in the power itself. Do not edit `mcp.json` to put values in
it. The user sets each variable in the environment Kiro is launched from (for
example their shell profile). Walk through these in order and don't skip ahead.

**3a. Platform (always).** Ask the user to set:

```bash
export NEW_RELIC_AI_PLATFORM=kiro
```

Kiro exposes no ambient variable that identifies it. Without this the platform
falls through to the generic MCP adapter, Kiro's tool names are never
normalized, and every file/edit/shell metric silently reports zero while the
raw tool-call count still looks correct.

**3b. Mode.** Ask which mode they want:

- `local` (default): dashboard at `http://127.0.0.1:7777`, nothing leaves the
  machine. No account needed.
- `cloud`: send data to New Relic.

Have them set their choice:

```bash
export NR_AI_MODE=local   # or: cloud
```

**3c. Credentials (only if they chose `cloud`).** Before asking, tell them what
cloud sends: file paths, redacted shell commands, the developer ID and the repo
URL, not just aggregate counts (see
[PRIVACY.md](https://github.com/newrelic-experimental/preflight/blob/main/PRIVACY.md)).
If they still want it, two things are needed, because `mcp.json` ships with
only the mode and platform variables:

1. Ask them to add these two lines to the `env` block of this power's
   `mcp.json`. They are `${VAR}` references, not values, so no secret goes in
   the file:

   ```json
   "NEW_RELIC_LICENSE_KEY": "${NEW_RELIC_LICENSE_KEY}",
   "NEW_RELIC_ACCOUNT_ID": "${NEW_RELIC_ACCOUNT_ID}"
   ```

2. Ask them to set the real values in their own environment:

   ```bash
   export NEW_RELIC_LICENSE_KEY=...
   export NEW_RELIC_ACCOUNT_ID=...
   ```

**Never ask the user to paste a license key or account ID into chat, and never
write credentials to any file yourself, including `mcp.json`.** They fill in
their own values. If they chose `local`, skip this step.

**3d. Restart and verify.** Have them fully quit and relaunch Kiro so the
variables are picked up. Then call `nr_observe_get_config` and confirm
`platform` reads `kiro` (not `generic-mcp`) and `mode` matches their choice.

## Step 4: Mention optional feature flags

Once Steps 1-3 are done, briefly let the user know they can set more environment
variables (and add them to `mcp.json`'s `env` block as `${VAR}` references) to unlock specific tools — don't ask about
these proactively, just mention they exist:

- `NEW_RELIC_AI_SESSION_BUDGET_USD` / `_DAILY_` / `_WEEKLY_BUDGET_USD` — set a
  spend cap so `nr_observe_get_budget_status` reports non-null
  `remainingUsd`/`pctUsed` and fires 50/80/100% alerts. Works in `local` mode.
- `NEW_RELIC_AI_TEAM_ID` + `NEW_RELIC_API_KEY` (a NerdGraph **User** key,
  `NRAK-...` — distinct from `NEW_RELIC_LICENSE_KEY`) — both are required
  before `nr_observe_get_team_summary` will work at all; it errors with
  `"teamId or nrApiKey not configured"` otherwise.

Tell the user where to look for more — don't just say "check the docs" without
the link, since they may not have this repo cloned locally:

- Feature-flag table (includes `NEW_RELIC_AI_ORG_ID`/`_PROJECT_ID`/
  `_MCP_DEVELOPER` too): https://newrelic-experimental.github.io/preflight/kiro-power/#optional-feature-flags
- Every config field this server reads, env var and config-file key alike:
  https://newrelic-experimental.github.io/preflight/advanced/

Do not repeat this setup on every message — only run it once per Kiro
workspace, or when the user explicitly asks to check Preflight's setup.
