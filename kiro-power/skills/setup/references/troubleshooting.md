# Preflight setup — troubleshooting detail

Background for when a `setup/SKILL.md` step doesn't behave as expected.

## Why `mcp.json` launches `preflight` directly, not via `npx`

A common MCP-server pattern is to fetch the package on demand with
`npx -y @newrelic/preflight@latest --stdio`. This power deliberately does
not: it uses `"command": "preflight"`, which requires a global install.

The reason is session-id resolution. Preflight's session resolver
(`src/hooks/session-resolver.ts`) matches the MCP server's own `process.ppid`
against a breadcrumb file the hook collector writes keyed by _its own_
`process.ppid` (`src/hooks/collector-script.ts`'s `writePpidBreadcrumb`) —
the two only line up when both processes share the same immediate parent
(Kiro itself). Routing the server's launch through `npx` inserts an
`npm exec` process in between, so the server's `ppid` points at that wrapper
rather than at Kiro, and the match fails.

Verified empirically on Kiro (macOS): under `npx` the process tree is
`Kiro Helper → npm exec → node preflight --stdio`, and the breadcrumb the
collector wrote sits at Kiro Helper's PID — one level above what the server
checks. The `resolveFromCwd()` fallback doesn't rescue it either, because
Kiro launches an Agent-Plugins MCP server with its `cwd` set to the power's
own installed directory (`~/.kiro/powers/installed/<power>`) rather than the
user's workspace, so it can never match a workspace-keyed cwd breadcrumb.
The result is `nr_observe_get_session_stats` reporting
`session_id not yet resolved` indefinitely.

Launching `preflight` directly avoids the extra hop — at the cost of
depending on a global install instead of always resolving the latest
published version the way `npx` would.

**Symptom if this ever regresses:** `nr_observe_health` connects fine but
`session_id` in `nr_observe_get_config`/`nr_observe_get_session_stats` never
resolves even after several tool calls.

## Hook exit-code semantics are documented inconsistently

kiro.dev/docs/hooks/ marks `PreToolUse` as a blocking trigger and
`PostToolUse` as non-blocking, but Kiro's IDE-tab and CLI-tab docs describe
the exact exit-code rules for what counts as a hook failure differently from
each other (one says any non-zero exit blocks a `PreToolUse` hook, the other
says only exit code 2 does). Treat any non-zero exit from
`preflight-collector` as something to avoid rather than relying on a
specific code. `preflight-collector` itself is designed to always exit `0`
even on internal errors (`src/hooks/collector-script.ts`'s own header
comment) — the only realistic failure mode is the binary not existing on
`PATH` at all, which `scripts/validate-deps.sh` rules out before the hook is
ever created.

## Hooks keep working even if this power's MCP connection drops

Kiro's Agent Plugins format activates a power's MCP server "dynamically
based on keywords in your conversation" rather than keeping it always
running — so `nr_observe_*` tools may not be available until the
conversation actually touches on cost/observability/efficiency/etc. This
does **not** affect capture: `.kiro/hooks/preflight-observability.json` is a
workspace-level file, independent of whether this power is currently
"active," so tool calls keep landing in
`~/.newrelic-preflight/buffer-*.jsonl` regardless. If a user asks "is it
still tracking?" while the power looks inactive, that's expected — the
answer is still yes as long as the hook file exists and the binaries
resolve.

## Verifying capture directly, without relying on `nr_observe_*`

```bash
ls -la ~/.newrelic-preflight/buffer-*.jsonl
tail -5 ~/.newrelic-preflight/buffer-*.jsonl
```

New lines should appear after every tool call once the hooks from Step 2 are
wired, even before `nr_observe_get_session_timeline` is called to confirm it
through the MCP tools.
