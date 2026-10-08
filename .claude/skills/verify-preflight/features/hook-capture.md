# Hook capture

Every tool call Claude Code makes fires PreToolUse and then PostToolUse or PostToolUseFailure. The hooks pipe the payload into `preflight-collector`. Preflight pairs them into one tool call on the session, counts successes and failures per tool, names the session after its working directory, and persists the session to disk.

## Sub-features

- `capture-pair` turns a Pre and Post pair into one counted tool call.
- `capture-failure` counts a PostToolUseFailure as a failed call.
- `capture-live` lists the session as live while it is active.
- `capture-name` names the session from the hook `cwd`.
- `capture-persist` writes `YYYY-MM-DD_<sid>.json` to storage.

## How to get to it (user POV)

- Use Claude Code with Preflight's hooks installed. Every tool call is captured with no user action.
- Read the result on the dashboard's Today and Sessions pages, or through the `nr_observe_get_session_stats` MCP tool.

## Driving it with pf-verify

Preconditions:

- `$PF up` has run and `$PF doctor` passes.
- `SID=$($PF sid)` holds a fresh id.

- **Successful calls.** Run `$PF hook $SID Read '{"file_path":"/tmp/pf-verify-project/src/app.ts"}'` and `$PF hook $SID Bash '{"command":"npm test"}'`. Each prints `hook <sid> <tool> PostToolUse`.
- **Failed call.** Run `$PF hook $SID Edit '{"file_path":"/tmp/pf-verify-project/src/app.ts","old_string":"a","new_string":"b"}' --fail`. It prints `PostToolUseFailure`.
- **Live session.** After 1s, run `$PF api /api/sessions/live`. The array contains `"sessionId":"<sid>"` with `"sessionName":"pf-verify-project"` and `"sessionNameSource":"cwd"`.
- **Counts.** Run `$PF api /api/session/current`. It shows `"toolCallCount":3`, `"toolCallCountByTool":{"Read":1,"Bash":1,"Edit":1}`, and `toolSuccessRate` near `0.67`.
- **Persistence.** After 5s, run `ls "$($PF where | sed -n 's/^run=//p')/store/sessions"`. It lists `<today>_<sid>.json`. Then `$PF api /api/sessions/today/aggregate` reports `sessionCount` 1 and `toolCallCount` 3.
- **Proof.** Save the three API bodies with `$PF api <path> > "$EVIDENCE/capture-<step>.json"` next to the command lines that produced them.

## Gotchas

- `/api/session/current` is the server's own rollup across live sessions, and its `sessionId` is `local-<ts>`, not your id. Check `liveSessions` in the same body for your id.
- `/api/sessions` shows a thin stub for an unpersisted session. `toolBreakdown` and `model` are missing until the first persist.
- The collector silently rewrites an id that fails `^[a-zA-Z0-9_-]{1,128}$` to `unknown`. Ids with dots or spaces vanish from the session views.
- A `hook` with no input JSON sends `{}`. Tool-specific parsing, like file paths and bash categories, then has nothing to read.
