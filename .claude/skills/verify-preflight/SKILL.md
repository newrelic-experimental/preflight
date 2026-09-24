---
name: verify-preflight
description: Launch an isolated Preflight instance built from this checkout and prove behavior on its real surfaces (the web dashboard, the dashboard HTTP API, hook capture through the collector, token cost from transcripts, and the stdio MCP tools). Use when shipping or reviewing any user-visible Preflight change, reproducing a dashboard or MCP bug, or when asked to "verify", "run", or "screenshot" Preflight.
---

# Verify Preflight

Preflight watches an AI coding agent. The Claude Code hooks pipe every tool call into `preflight-collector`, which appends to a per-session buffer. The Claude Code transcripts under `~/.claude/projects` carry the token usage. A `--local` server drains both and serves the dashboard and its `/api/*` routes. A `--stdio` server does the same for one session and answers MCP tool calls.

Verification drives those same inputs. You never call internal setters or test endpoints. Everything runs through one helper, `scripts/pf-verify`, which pins each process to a throwaway `HOME` and storage dir.

```bash
PF=.claude/skills/verify-preflight/scripts/pf-verify   # run from the repo or worktree root
```

## Isolation rules

- Never drive the developer's live dashboard on port 7777 or their `~/.newrelic-preflight`. It is the installed npm build, not this checkout, and its data is real.
- `pf-verify` defaults to port 7791. Port 7790 belongs to `npm run test:e2e` and 7788 to manual previews. Use `PF_PORT=<port>` for a second concurrent run. Each port gets its own run dir, so runs never share state.
- The helper overrides `HOME`. Without that, the transcript watchers read the real `~/.claude/projects` and import the developer's real sessions and cost into the run. The doctor checks this.
- The helper drops every inherited `CLAUDE*` variable. Without that, a stdio server started from inside Claude Code binds to the calling agent's own session through `CLAUDE_JOB_DIR`.
- It pins `NR_AI_MODE=local` and blanks the NR license key and account, so nothing reaches New Relic.

## Launch

Build once per code change. A fresh worktree needs `npm ci` first.

```bash
npm ci && npm run build          # dist/index.js, dist/hooks/collector-script.js, dist/web/
$PF up                           # prints: up pid=<pid> url=http://127.0.0.1:7791 run=<run dir>
```

`up` refuses to start when the port is held by anything else, or when this run is already up. It is ready when it prints the `up` line, which means `/api/health` answered.

## Doctor

Run this first, and again whenever anything looks off.

```bash
$PF doctor
```

It prints one `ok`/`FAIL` line per check and exits non-zero on any FAIL. The checks cover these conditions:

- The recorded PID is alive.
- The port's listener is that PID.
- `/api/health` reports the `package.json` version. On a mismatch, rebuild.
- The transcript watchers logged the run's own `projectsDir`.

It also counts error-level log lines.

## Drive

Mint a UUID session id first. The transcript watchers skip anything that isn't a UUID. The collector accepts any id, so a non-UUID id silently loses cost data.

```bash
SID=$($PF sid)
$PF hook $SID Read '{"file_path":"/tmp/pf-verify-project/src/app.ts"}'     # PreToolUse + PostToolUse
$PF hook $SID Bash '{"command":"npm test"}'
$PF hook $SID Edit '{"file_path":"/tmp/pf-verify-project/src/app.ts","old_string":"a","new_string":"b"}' --fail   # PostToolUseFailure
$PF turn $SID claude-sonnet-4-5-20250929 1200 300 5000                     # one assistant turn: in, out, cache-read tokens
sleep 5                                                                     # 100ms buffer poll, 2s transcript poll, 3s persist
```

- `hook <sid> <tool> [input-json] [--fail] [--cwd DIR]` pipes a real Claude Code hook payload pair through the built `dist/hooks/collector-script.js`. The default cwd `/tmp/pf-verify-project` sets the API's `sessionName` to `pf-verify-project`. The dashboard labels the session by the first 8 characters of its id.
- `turn <sid> <model> <in> <out> [cache-read]` appends a Claude Code transcript line under the run's `HOME`. The real `ParentTranscriptWatcher` picks it up.
- `api <path>` runs a GET against the run. The routes live in `src/dashboard/routes/api-handler.ts` (`routes.set('GET /api/...')`) plus `GET /api/health`.
- `shot <route> <name> [--expect TEXT]... [--click TEXT]...` loads a dashboard route in headless Playwright Chromium, waits for the page `h1`, and clicks or asserts each text in order. It saves `<name>.png` and `<name>.txt` to the evidence dir and exits 1 if any `--expect` text is missing.
- `mcp [--session <sid>] <tool> [args-json]` spawns `dist/index.js --stdio`, runs the MCP handshake, calls one tool, and prints its text result. Run it against a port with no `up` server (see Gotchas).

The feature map in [`features/README.md`](features/README.md) holds the per-feature recipes, their stable handles, and the end states that prove each one.

## Evidence

- Proof artifacts live in `$($PF where | sed -n 's/^evidence=//p')`. That is `$CLAUDE_JOB_DIR/tmp/preflight-verify/evidence` inside a Claude Code job, and `$TMPDIR/preflight-verify/evidence` otherwise. `shot` writes there, and `down` copies the server log there before it removes the run.
- Capture the action and the result. A hook call plus the API or UI state that changed because of it is a proof. A screenshot alone is not.
- Check side effects alongside the visible state. `ls <run>/store/sessions` shows persisted `YYYY-MM-DD_<sid>.json` files. `api /api/cost` shows the token math.
- Mock nothing. The collector, the watchers, and the server are the production binaries. The only substitutes are the inputs Claude Code would write (hook stdin and transcript lines), and they match its formats.
- Do not trust "local mode sends nothing" on faith. A local-mode run logs no `harvest` or `ingest` component at all. `grep -ciE 'harvest|ingest' <run>/server.log` should print `0`, and any other number means the run is sending.

## Cleanup

```bash
$PF down        # kills only the PID this run recorded, after checking its argv names this run's config
```

`down` refuses to kill a PID whose command line doesn't match the run. It copies `server.log` into the evidence dir, then deletes the run dir. It never touches the evidence dir. `mcp` children exit before `mcp` returns, and it SIGKILLs any child still alive after 5s. Run `down` after every failed iteration too, so no stray server keeps holding the port.

## Helpers

`scripts/pf-verify` is the only helper, and it is executable. `$PF` with no arguments prints its subcommands. `$PF where` prints the repo, URL, run dir, and evidence dir for the current `PF_PORT`. Two knobs exist. `PF_PERSIST_MS` (default `3000`) sets `NR_AI_SESSION_PERSIST_INTERVAL_MS`, which is 30s in production. `PF_MCP_SETTLE_MS` (default `5000`) sets how long `mcp` waits after the handshake before calling the tool. The stdio transcript watcher first polls 2s after start, so shorter settles miss seeded turns.

## Gotchas

- A `--local` server drains every session's buffer. A stdio `mcp` call on the same port then finds nothing for its session and reports `tool_calls: 0`. Put MCP proofs on their own port with no `up`, like `PF_PORT=7792 $PF hook ...` and then `PF_PORT=7792 $PF mcp --session $SID ...`. `hook`, `turn`, and `mcp` create the run dir themselves.
- `/api/sessions` returns a thin stub for a live session that hasn't been persisted yet. Read `/api/session/current`, `/api/cost`, or `/api/sessions/today/aggregate` for live numbers. The Today aggregate counts only persisted sessions, so wait for one persist interval.
- Tool calls with no transcript get an estimated cost at the default model (`claude-sonnet-4-6` at a few dozen tokens). Seed a `turn` whenever a proof depends on the model or token counts.
- The Claude in Chrome extension refuses `127.0.0.1` URLs ("Could not verify this site's safety category"). Use `http://localhost:<port>` there. `shot` needs no extension.
- The collector's `highSecurity` check reads `~/.newrelic-preflight/config.json` under the run's `HOME`, which is empty. To prove high-security behavior, write `{"highSecurity":true}` to `<run>/home/.newrelic-preflight/config.json` before the hooks.
