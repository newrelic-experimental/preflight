---
title: Kiro Power
description: Install Preflight as a Kiro Power — what it gives you, how to install it, and how to add automatic tool-call capture on top.
---

# Kiro Power

Preflight can be installed directly as a [Kiro](https://kiro.dev) Power, in
addition to the npm-based install (`npm install -g @newrelic/preflight` +
`preflight setup`) described in the main [README](../README.md). Both paths
are valid — the Power is an additional distribution channel, not a
replacement.

The Power gives you the `nr_observe_*` MCP tools with nothing pre-installed.
Automatic tool-call capture is the one part that still needs the global
install, because the hook binary runs on every single tool call and can't be
routed through `npx` — see
[Enable automatic tool-call capture](#enable-automatic-tool-call-capture).

`kiro-power/` uses Kiro's current
[Agent Plugins](https://agent-plugins.org) format (`plugin.json` + `mcp.json`

- `skills/`) rather than the legacy `POWER.md` format — this is a
  requirement, not a preference: Kiro's own submission page for the curated
  [kiro.dev/powers/](https://kiro.dev/powers/) directory states plainly,
  _"Please create your power using the Agent Plugins format... If your power
  is a good fit for our registry, we will reach out."_ The legacy format still
  installs fine via a direct folder/GitHub-URL import, but isn't eligible for
  that curated listing at all.

## What you get

- **MCP tools** — all `nr_observe_*` tools (session stats, cost breakdown,
  anti-patterns, recommendations, etc.).
- **Two Agent Skills** — `setup` (first-run onboarding: verify dependencies,
  wire up hooks, choose local/cloud mode) and `observability` (documents the
  `nr_observe_*` tools so Kiro's agent reaches for them when relevant).

### Activation is contextual, not always-on

Kiro's docs are explicit about this for the Agent Plugins format:
_"MCP servers are managed internally by Kiro... They activate and
deactivate with the power,"_ and _"powers activate dynamically based on
keywords in your conversation."_ So `nr_observe_*` tools aren't necessarily
available the instant this Power is installed — they become available once
the conversation touches on something in `plugin.json`'s `keywords` list
(cost, efficiency, observability, anti-patterns, etc.), or once the `setup`
skill has run. If you ask something entirely unrelated first, don't be
surprised if the tools aren't there yet — mention Preflight or ask about
session cost/efficiency to trigger activation.

This does **not** affect tool-call _capture_ — once
`.kiro/hooks/preflight-observability.json` exists (see below), Kiro fires it
on every tool call independent of whether this Power is currently "active."

### What this doesn't do automatically

Kiro Powers can't bundle hooks or executables — `plugin.json`'s schema has
no hooks field, and Kiro's own directory-tree example for a complete Power
(`plugin.json` + `mcp.json` + `skills/`) has no hooks file anywhere. So
installing this Power alone does **not** give you automatic
PreToolUse/PostToolUse capture — that's a one-time manual step, covered by the
`setup` skill (`kiro-power/skills/setup/SKILL.md`) and summarized again below.

## Install

**For local testing / peer-to-peer sharing (no review):**

1. Clone this repo (or download it) so you have a local copy of
   [`kiro-power/`](../kiro-power/).
2. In Kiro, open the **Powers** panel → **Add Custom Power** → **Import power
   from a folder** → select the `kiro-power/` directory.
3. Restart Kiro (or reconnect MCP servers from Kiro's MCP panel). Ask Kiro's
   agent to run Preflight setup (or mention cost/observability) to trigger
   the `setup` skill's onboarding — including wiring hooks for full
   tool-call capture (see below).

No prior install is needed for the MCP tools: `mcp.json` fetches the package
on demand with `npx`. Automatic tool-call capture is separate and does still
need a global install — see below.

Kiro also supports importing a Power directly from a GitHub repository URL.
Whether that flow supports pointing at a subdirectory of a larger repo (like
`kiro-power/` here) isn't documented, so the folder-import path above is the
one to rely on until that's confirmed.

**For the curated kiro.dev/powers/ directory:** submit the public GitHub
repo URL via [kiro.dev/powers/submit/](https://kiro.dev/powers/submit/).
Kiro's stated requirements include: the power is complete/tested/working;
`plugin.json` includes `$schema`/`name`/`version`/`description`/`author`/
`keywords`/`license` (all present in `kiro-power/plugin.json`); any MCP
server used isn't in beta/preview status; and the repo's README includes a
privacy policy link and a support contact. This repo's top-level README
doesn't currently have either of those last two — worth adding before
submitting.

## Enable automatic tool-call capture

This is Step 2 of the `setup` skill (`kiro-power/skills/setup/SKILL.md`) —
Kiro's agent should walk you through it, but you can also do it by hand:

1. Confirm `preflight-collector` resolves on `PATH`: `command -v
preflight-collector` (or run
   `kiro-power/skills/setup/scripts/validate-deps.sh`). If it doesn't, run
   `npm install -g @newrelic/preflight`, then re-check. Do this **before**
   creating the hook file below —
   [kiro.dev/docs/hooks](https://kiro.dev/docs/hooks) marks `PreToolUse` as
   a blocking trigger, so a hook command missing from `PATH` would block
   every tool call in the session, not just skip Preflight's own
   observability.
2. Add `.kiro/hooks/preflight-observability.json` in your project (not
   inside `kiro-power/` — hooks are workspace-scoped):

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

   Both entries run the same command — `preflight-collector` tells pre-
   from post-call apart from the hook payload's own `hook_event_name` field,
   not a CLI argument (`src/hooks/collector-script.ts`). Neither sets a
   `matcher`; per kiro.dev/docs/hooks, omitting it defaults to always-match.

3. Restart Kiro. Tool calls now land in
   `~/.newrelic-preflight/buffer-*.jsonl` and feed the `nr_observe_*` tools
   above the same way they do for Claude Code, Amazon Q, and Kiro's other
   `full-hooks` peers — see [ADAPTERS.md](./ADAPTERS.md#amazon-kiro-kiro).

Skipping this step silently downgrades the install to MCP-tool-only
visibility — `nr_observe_health` still succeeds, so it can look like
everything is working while most of the session goes unobserved.

## Cloud mode

This Power's `mcp.json` sets `NR_AI_MODE: "local"` explicitly, so it works
with no New Relic account (dashboard at `http://127.0.0.1:7777`, nothing
leaves the machine). To send telemetry to New Relic instead, edit
`kiro-power/mcp.json`'s own `env` block — add `NEW_RELIC_LICENSE_KEY` and
`NEW_RELIC_ACCOUNT_ID`, and change `NR_AI_MODE` to `cloud` or `both`. Edit
the file directly rather than exporting shell variables: it's the config
Kiro actually reads to launch this server, whereas whether Kiro's launcher
also layers in the host shell environment on top isn't documented. Never
commit real credentials into a shared copy of `mcp.json` — keep source
control on `local` mode with no credentials, same as this repo's copy. See
[ADVANCED.md](./ADVANCED.md) for the full field reference.

## Why `NEW_RELIC_AI_PLATFORM` is set

`mcp.json` also pins `NEW_RELIC_AI_PLATFORM: "kiro"`. This is load-bearing,
not decoration: Kiro exposes no ambient environment variable identifying
itself to a child process (a Power's MCP server gets 16 variables, none of
them Kiro-specific), so `KiroAdapter.isSupported()` cannot detect it and
`PlatformRegistry.detect()` falls through to the generic MCP adapter.

The failure that causes is quiet and easy to miss. Session resolution and the
raw tool-call count still work, so the install looks healthy — but Kiro's tool
names (`read_file`, `str_replace`, `execute_bash`) are never mapped to
Preflight's normalized vocabulary, and every metric keyed on a normalized name
reports zero: `unique_files_read`, `unique_files_modified`,
`bash_commands_run`, and the anti-pattern and cost-per-file analyses built on
them. Check `nr_observe_get_config` reports `platform: "kiro"` if those
numbers ever look implausibly empty.

## Packaging

`kiro-power/` ships no precompiled hook script and needs no bundle step — a
Power can't carry a hooks file or an executable at all, so there's nothing
to bundle; [Enable automatic tool-call capture](#enable-automatic-tool-call-capture)
reuses the already-published `preflight-collector` bin instead.

`kiro-power/mcp.json` fetches the package on demand
(`npx -y @newrelic/preflight@latest --stdio`) rather than requiring a global
install, so the `nr_observe_*` tools work on a first-time machine.

That was not always safe, and the reason is worth recording. `npx` does not
run the server directly — it execs an `npm exec` process which then runs the
server, so the server's parent is that wrapper rather than Kiro. Preflight
resolves its `session_id` by matching its own parent PID against a breadcrumb
the hook collector writes at _its_ parent PID, and the wrapper broke that
match: `session_id` never resolved, and every session-scoped tool failed while
the MCP connection itself looked perfectly healthy. Kiro's working-directory
fallback can't rescue it either, because a Power's server runs with `cwd` set
to the Power's install directory and never sees the workspace path.

`src/hooks/process-ancestry.ts` fixes this by walking a few levels up the
server's own ancestry instead of checking only its immediate parent, so the
breadcrumb one level above the wrapper is found. **This config therefore
depends on that fix being present in the published package** — pinning
`@latest` is what ties the two together. If you ever see `session_id: null`
on Kiro, check the installed version actually contains the ancestor walk
before looking anywhere else.

`kiro-power/` ships:

- **`kiro-power/plugin.json`** — the Power manifest.
- **`kiro-power/mcp.json`** — the MCP server declaration.
- **`kiro-power/skills/setup/`** — the `setup` Agent Skill
  (`SKILL.md` + `scripts/validate-deps.sh` + `references/troubleshooting.md`).
- **`kiro-power/skills/observability/`** — the `observability` Agent Skill
  (`SKILL.md`), documenting the `nr_observe_*` tools.

> **Note:** `plugin.json`'s `version` field is not auto-synced from
> `package.json` — bump both together when cutting a release.
