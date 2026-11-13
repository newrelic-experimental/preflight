# MCP tools

Claude Code launches `preflight --stdio` as an MCP server for each session. The agent calls `nr_observe_*` tools to read its own session's stats, cost, anti-patterns, and history. The server scopes itself to one session and reports only that session's calls.

## Sub-features

- `mcp-session-stats` returns the session's tool calls and per-tool counts from `nr_observe_get_session_stats`.
- `mcp-cost` returns cost by model and token totals from `nr_observe_get_cost_breakdown`.
- `mcp-scope` binds the server to the session named by the job state, never to another session.
- `mcp-catalog` lists every tool in `docs/COMMANDS_TABLE.md`.

## How to get to it (user POV)

- An agent calls the tool mid-session, or a user asks Claude Code "what has this session cost".
- Each tool name and its arguments are listed in `docs/COMMANDS_TABLE.md`.

## Driving it with pf-verify

Preconditions:

- `export PF_PORT=7792`, a port with no `up` server.
- `SID=$($PF sid)` holds a fresh UUID.

- **Seed.** Run `$PF hook $SID Bash '{"command":"ls"}'`, `$PF hook $SID Read '{"file_path":"/tmp/x"}'`, and `$PF turn $SID claude-sonnet-4-5-20250929 1200 300 5000`.
- **Session stats.** Run `$PF mcp --session $SID nr_observe_get_session_stats`. The JSON has `"session_id":"<sid>"`, `"tool_calls": 2`, and `tool_calls_by_type` with `Bash` 1 and `Read` 1.
- **Cost.** Run `$PF mcp --session $SID nr_observe_get_cost_breakdown`. `by_model` contains `"claude-sonnet-4-5-20250929": 0.0096`, and `tokens.cache_read` is 5000.
- **Scope.** Run `$PF mcp nr_observe_get_session_stats` without `--session`. It prints `{"error":"session_id not yet resolved",...}`. The server never invents an id and never borrows your agent's own `CLAUDE_CODE_SESSION_ID`.
- **Cleanup.** Run `$PF down`, then `lsof -nP -iTCP:$PF_PORT -sTCP:LISTEN` prints nothing.
- **Proof.** Redirect each `mcp` output to `"$EVIDENCE/mcp-<tool>.json"`.

## Gotchas

- With a `--local` server up on the same port, that server drains the buffer first and `mcp` reports `tool_calls: 0`. That is the multi-instance design working, not a bug in the tool.
- The stdio server only sees events it drains after it starts. Seed before calling `mcp`, because each call is a fresh process.
- A tool that needs cross-session data (`nr_observe_get_session_history`, `nr_observe_get_weekly_summary`) reads persisted sessions. Seed a session and let it persist on a separate `up` run first, then `down` that server before calling `mcp` on the same port.
- The stdio server binds the dashboard port when it is free. `mcp` kills its child before returning, so the port frees again.
