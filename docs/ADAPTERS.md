# Platform Adapters

Preflight supports 9 named AI coding platforms plus a generic MCP fallback, each via a `PlatformAdapter` in `src/platforms/`. Adapters differ in one fundamental way: **what the platform actually exposes to a third-party observer.** Some platforms have a real hook/callback mechanism that fires on every built-in tool call; others only support MCP as a client, which means Preflight can see calls the platform's agent chooses to make to Preflight's own tools, but never a callback for the platform's _built-in_ tools (file reads, edits, terminal commands, etc).

This doc is the canonical reference for what each adapter can and can't observe, how detection and setup actually work, and where the gaps are. It mirrors `src/platforms/*.ts` and the hook-event handling in `src/hooks/collector-script.ts` — if you change either, update this doc in the same PR.

> **Maintenance note:** every adapter implements `getHookInstallInstructions()`, which returns the setup text reproduced below. That method is not currently called from any CLI command (`preflight doctor --platform <x>` explicitly skips it and tells the user to verify manually) — this document is presently the only place that text is surfaced to a user. If a CLI surface is added later, keep this doc and the adapter methods in sync, or replace the relevant section here with a pointer to the command output.

## Integration mechanisms

| Mechanism                                                                                                      | Platforms                          | What's captured                                                                        | `visibilityLevel` |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- | ----------------- |
| **Uniform hook events** (`tool_name`/`tool_input`, PreToolUse/PostToolUse-shaped, case-insensitive event name) | Claude Code, Kiro, Amazon Q, Droid | All built-in tool calls                                                                | `full-hooks`      |
| **Platform-specific hook events** (own field vocabulary, own branches in `collector-script.ts`)                | Cursor, Windsurf                   | All built-in tool calls                                                                | `full-hooks`      |
| **MCP-client-only** (no hook/callback mechanism exists)                                                        | Zed, Continue.dev                  | Only calls routed to Preflight's own MCP tools — **not** the platform's built-in tools | `mcp-tools-only`  |
| **HTTP push from an extension**                                                                                | GitHub Copilot                     | Whatever the (user-supplied) extension forwards                                        | `self-reported`   |
| **Self-report via MCP tools**                                                                                  | Generic MCP fallback               | Whatever the caller reports via `nr_observe_report_tool_call`                          | `self-reported`   |

Every `PlatformAdapter` (`src/platforms/types.ts`) declares a `visibilityLevel` field encoding this table in code, not just prose — `full-hooks` (automatic, deterministic capture), `self-reported` (built-in-tool-shaped events are observable, but only if an external party — a third-party extension, or the calling MCP client itself — actually reports them), or `mcp-tools-only` (structurally cannot see built-in tool calls at all). Consumers that blend metrics across platforms (`nr_observe_get_platform_comparison`, the weekly digest's per-platform breakdown) use `getPlatformVisibilityMap()` (`src/platforms/platform-registry.ts`) to tag results and caveat comparisons that span more than one level.

Detection order matters: `createDefaultRegistry()` (`src/platforms/platform-registry.ts`) registers adapters in a fixed order — Claude Code, Cursor, Windsurf, Copilot, Zed, Continue, Amazon Q, Kiro, Droid, then the generic MCP fallback (always last, `isSupported()` always `true`). `PlatformRegistry.detect()` returns the **first** adapter whose `isSupported()` returns `true`; there is no `NEW_RELIC_AI_PLATFORM`-driven override for most platforms (see per-platform detection below).

---

## Claude Code (`claude-code`)

**Mechanism:** Native `PreToolUse`/`PostToolUse`/`PostToolUseFailure` hooks, installed by Preflight itself.

**Detection (`isSupported()`):** `CLAUDE_CODE` env var set, or `CLAUDE_CODE_VERSION` set, or `MCP_CLIENT === 'claude-code'`.

**Setup:**

1. Run `npx preflight install`
2. This adds `PreToolUse`/`PostToolUse` hooks to `~/.claude/settings.json`
3. Restart Claude Code to activate the hooks
4. Add the MCP server to your `.mcp.json` configuration

**Notes:** The default, first-class platform. Tool names pass through unmapped (`mapToolName()` is identity).

---

## Cursor (`cursor`)

**Mechanism:** Cursor's own hooks system (`.cursor/hooks.json`), a local process protocol unrelated to MCP. Confirmed against Cursor's docs and a Cursor engineer's forum reply ([forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316)).

**Detection (`isSupported()`):** `CURSOR_SESSION_ID` set, or `CURSOR_TRACE_ID` set, or `MCP_CLIENT === 'cursor'`.

**Two distinct event vocabularies handled by `collector-script.ts`:**

1. Per-action hook events — `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit` — carry no generic `tool_name` field; the collector derives the tool name from the event name itself. `CURSOR_TOOL_MAP` is never consulted for these.
2. Generic `preToolUse`/`postToolUse` events (confirmed to exist, payload only partially documented) — carry `tool_name` as one of `Shell`/`Read`/`Write`/`Task`/`MCP`. `MCP` is deliberately left unmapped (collapsing an arbitrary downstream MCP tool into the literal string "MCP" would discard information); it falls through to `'Unknown'` with the original name preserved.

**Known gaps:** Cursor has no `afterReadFile` event (`beforeReadFile` is emitted as a completed read directly) and no `beforeFileEdit` event (`afterFileEdit` is post-only). `afterShellExecution`/`afterMCPExecution` have no documented failure-outcome field, so success is reported unconditionally `true`.

**Setup:**

1. Register the Preflight MCP server for `nr_observe_*` tools: Cursor Settings → MCP → add server, command `npx preflight --stdio`, env `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_ACCOUNT_ID`
2. Configure Cursor hooks so tool-call activity is captured — create `.cursor/hooks.json` (project) or `~/.cursor/hooks.json` (global):
   ```json
   {
     "version": 1,
     "hooks": {
       "beforeShellExecution": [{ "command": "preflight-collector" }],
       "afterShellExecution": [{ "command": "preflight-collector" }],
       "beforeMCPExecution": [{ "command": "preflight-collector" }],
       "afterMCPExecution": [{ "command": "preflight-collector" }],
       "beforeReadFile": [{ "command": "preflight-collector" }],
       "afterFileEdit": [{ "command": "preflight-collector" }]
     }
   }
   ```
3. Ensure `preflight-collector` is on `PATH` (`npm link`, or `npm install -g @newrelic/preflight`)
4. Restart Cursor

---

## Windsurf (`windsurf`)

**Mechanism:** Windsurf's real Cascade Hooks system (`.windsurf/hooks.json`) — [docs.windsurf.com/windsurf/cascade/hooks](https://docs.windsurf.com/windsurf/cascade/hooks). Not a file watcher or extension API. Windsurf also supports MCP natively via `mcp_config.json`.

**Detection (`isSupported()`):** `WINDSURF_SESSION_ID` set, or `WINDSURF_CONTEXT_ID` set, or `MCP_CLIENT === 'windsurf'`.

**Event vocabulary handled by `collector-script.ts`:** `pre_read_code`, `post_read_code`, `pre_write_code`, `post_write_code`, `pre_run_command`, `post_run_command`. Windsurf sends the event name as `agent_action_name`, not `hook_event_name` — the collector checks both.

**Known gaps:** `post_read_code`/`post_run_command` report success `true` unconditionally, the same gap as Cursor's `afterShellExecution`. `pre_write_code` maps to `'Edit'` (it's typically a partial edit, not a full-file write).

**Setup:**

1. Windsurf Settings → MCP Servers → add server, command `npx preflight --stdio`, env `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_ACCOUNT_ID`
2. MCP tool calls via Cascade are captured automatically through the MCP connection
3. Built-in tool calls (file reads/writes, terminal commands) require Cascade Hooks — create `.windsurf/hooks.json` and register `pre_read_code`, `post_read_code`, `pre_write_code`, `post_write_code`, `pre_run_command`, `post_run_command`, each running `preflight-collector`
4. See [docs.windsurf.com/windsurf/cascade/hooks](https://docs.windsurf.com/windsurf/cascade/hooks) for the full schema

---

## Zed (`zed`)

**Mechanism:** None for built-in tools. Zed's native agent has no hook/callback mechanism for tool-call interception — confirmed via [zed.dev/docs/ai/mcp.html](https://zed.dev/docs/ai/mcp.html): Zed supports only MCP's Tools and Prompts features, with no notification for host-side tool calls. As a Zed MCP "context server," Preflight can only receive calls Zed's agent makes to Preflight's own exposed tools.

**Detection (`isSupported()`):** `ZED_SESSION_ID` set, or `ZED_EXTENSION_API_VERSION` set, or `MCP_CLIENT === 'zed'`, or `ZED_ITEM_ID` set.

**Tool-map status:** `ZED_TOOL_MAP` (real built-in agent tool names from [zed.dev/docs/ai/tools.html](https://zed.dev/docs/ai/tools.html)) exists for correctness and any future hook capability — it is currently **unreachable**, since no Zed event reaches it. `diagnostics`, `copy_path`, `move_path`, `create_directory` are real Zed tools deliberately left unmapped.

**Workaround:** When Zed runs another already-supported platform (Claude Code, Cursor, etc.) as an [External Agent via the Agent Client Protocol](https://zed.dev/docs/ai/external-agents.html), that agent's own native hooks capture its tool calls independently of Zed.

**Setup:**

1. There is no hook mechanism for tool-call capture in Zed's native agent — Preflight only sees calls made to its own MCP tools.
2. To use Preflight as an MCP context server (for its own observability tools): Settings → AI → MCP Servers → Add Server:
   ```json
   {
     "context_servers": {
       "preflight": {
         "command": "npx",
         "args": ["preflight", "--stdio"],
         "env": {
           "NEW_RELIC_LICENSE_KEY": "<your-key>",
           "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"
         }
       }
     }
   }
   ```
3. For full tool-call observability, run an already-supported platform as a Zed External Agent instead.

---

## Continue.dev (`continue`)

**Mechanism:** None for built-in tools. Continue's native agent (VS Code/JetBrains extension and CLI) has no `PreToolUse`/`PostToolUse`-style hook mechanism. Continue supports MCP only as a client.

**Detection (`isSupported()`):** `CONTINUE_SESSION_ID` set, or `CONTINUE_SERVER_HOST` set, or `MCP_CLIENT === 'continue'`, or `MCP_CLIENT_NAME === 'continue'`.

**Tool-map status:** `CONTINUE_TOOL_MAP` covers Continue's real built-in tool vocabulary (`read_file`, `edit_existing_file`, `run_terminal_command`, etc.) but, like Zed's map, is currently unreachable via any hook — it exists for the events that _would_ arrive if Continue ever exposed a callback.

**Setup:**

1. Continue cannot observe built-in tool calls the way Claude Code can — only calls Continue routes to its own MCP tools are visible.
2. Create `.continue/mcpServers/preflight.yaml`:
   ```yaml
   name: Preflight mcpServer
   version: 0.0.1
   schema: v1
   mcpServers:
     - name: preflight
       command: npx
       args: ['preflight', '--stdio']
       env:
         NEW_RELIC_LICENSE_KEY: <your-key>
         NEW_RELIC_ACCOUNT_ID: <your-account-id>
   ```
3. Reload Continue.

**Note:** the `continuedev/continue` repository is no longer actively maintained and is read-only as of its final 2.0.0 release, so a deeper hook integration is unlikely to land upstream.

---

## Amazon Q Developer CLI (`amazon-q`)

**Mechanism:** A genuine hook mechanism — `agentSpawn`/`userPromptSubmit`/`preToolUse`/`postToolUse`/`stop`, configured per-agent. Once wired, Amazon Q's `preToolUse`/`postToolUse` events are handled by the same generic branches in `collector-script.ts` that Claude Code and Kiro use (identical `hook_event_name`/`tool_name`/`tool_input` field names). Also supports MCP as a client.

**Detection (`isSupported()`):** `AMAZON_Q_SESSION_ID` set, or `Q_DEVELOPER_SESSION` set, or `MCP_CLIENT === 'amazon-q'`, or `AWS_CODEWHISPERER_SESSION` set.

**Tool-map:** Amazon Q CLI has exactly 9 built-in tools; only 4 have a genuine Claude Code equivalent (`fs_read`→Read, `fs_write`→Write, `execute_bash`→Bash, `todo_list`→TaskCreate). `introspect`, `report_issue`, `knowledge`, `thinking`, and `use_aws` are deliberately left unmapped and fall through to `'Unknown'` with the original name preserved.

**Known gap:** Amazon Q hook events carry no session identifier at all (unlike Claude Code, Kiro, Cursor, or Windsurf) — concurrent Amazon Q sessions on the same machine share a single unscoped buffer.

**Setup:**

1. Open your Amazon Q MCP config (`~/.aws/amazonq/mcp.json` or project-level `.amazonq/mcp.json`), add to `mcpServers`:
   ```json
   {
     "preflight": {
       "command": "npx",
       "args": ["preflight", "--stdio"],
       "env": {
         "NEW_RELIC_LICENSE_KEY": "<your-key>",
         "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"
       }
     }
   }
   ```
2. Configure hooks in your agent config (`~/.aws/amazonq/cli-agents/<agent-name>.json` global, or `.amazonq/cli-agents/<agent-name>.json` workspace):
   ```json
   {
     "hooks": {
       "preToolUse": [{ "command": "preflight-collector" }],
       "postToolUse": [{ "command": "preflight-collector" }]
     }
   }
   ```
   See [aws.github.io/amazon-q-developer-cli/agent-format.html#hooks-field](https://aws.github.io/amazon-q-developer-cli/agent-format.html#hooks-field).
3. Restart Amazon Q Developer CLI (or start a new `q chat` session).

---

## Amazon Kiro (`kiro`)

**Mechanism:** MCP stdio protocol, plus real hook events — [kiro.dev/docs/cli/hooks](https://kiro.dev/docs/cli/hooks). Kiro sends the hook event name in lower-camelCase (`preToolUse`) rather than Claude Code's PascalCase (`PreToolUse`); `collector-script.ts` matches case-insensitively so both are handled by the same generic branches as Claude Code and Amazon Q.

**Detection (`isSupported()`):** `KIRO_SESSION_ID` set, or `KIRO_IDE` set, or `MCP_CLIENT === 'kiro'`, or `NEW_RELIC_AI_PLATFORM === 'kiro'`.

**Tool-map:** `tool_name` may arrive as either a tool's canonical name (`fs_read`) or a documented alias (`read`) — both forms are covered in `KIRO_TOOL_MAP`. Some entries (`fsRead`, `fsCreate`, etc.) have no confirmed source in Kiro's public docs and are kept as best-effort coverage for IDE-surface tool names — don't remove them without positive evidence they're wrong.

**Setup:**

1. Open your Kiro MCP config (`~/.kiro/settings/mcp.json` user-level, or `.kiro/settings/mcp.json` workspace-level), add to `mcpServers`:
   ```json
   {
     "preflight": {
       "command": "npx",
       "args": ["preflight", "--stdio"],
       "env": {
         "NEW_RELIC_LICENSE_KEY": "<your-key>",
         "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"
       }
     }
   }
   ```
2. Restart Kiro (or reconnect MCP servers from the Kiro MCP panel).

---

## Factory Droid (`droid`)

**Mechanism:** Native `hooks.json` hook system (`~/.factory/hooks.json` user scope, `.factory/hooks.json` project scope, or an org-managed policy) — [docs.factory.ai/reference/hooks-reference](https://docs.factory.ai/reference/hooks-reference). Droid's `PreToolUse`/`PostToolUse` events send `hook_event_name`, `tool_name`, `tool_input`/`tool_response` in the same shape Claude Code, Kiro, and Amazon Q use, so they're handled by the same generic branches in `collector-script.ts` — no platform-specific parsing was needed. Also supports MCP as a client independently of the hooks system.

**Detection (`isSupported()`):** `MCP_CLIENT === 'droid'`, or `NEW_RELIC_AI_PLATFORM === 'droid'`. Unlike Cursor/Windsurf/Kiro, Factory's documentation names no ambient environment variable for a Droid-spawned MCP server process (`FACTORY_PROJECT_DIR` is scoped to hook _command_ subprocesses only) — detection is explicit-opt-in only; don't invent one.

**Tool-map:** Droid's documented `PreToolUse`/`PostToolUse` matchers are `Task`, `Execute`, `Glob`, `Grep`, `Read`, `Edit`, `Create`, `FetchUrl`, `WebSearch`. `Read`, `Glob`, `Grep`, `Edit` already match Preflight's canonical vocabulary and are listed as explicit identity entries in `DROID_TOOL_MAP` (there is no pass-through fallback). `Task`→Agent, `Execute`→Bash, `Create`→Write, `FetchUrl`→WebFetch, `WebSearch`→WebSearch.

**Known gap:** `collector-script.ts`'s per-tool metadata extractors (`extractInputMeta`/`extractOutputMeta`) switch on the raw, unmapped tool name written into the buffer — so Droid's `Create`/`Execute`/`Task` calls don't get the extra structured fields (content length, command classification, etc.) that `Write`/`Bash`/`Agent` get for Claude Code. This is the same situation Kiro's `fsWrite`/`fsCreate`/etc. are already in; `Read`/`Glob`/`Grep`/`Edit` (matching exactly) are unaffected.

**Setup:**

1. Add a `PreToolUse`/`PostToolUse` hook pair matching all tools to `hooks.json` (`~/.factory/hooks.json` or `.factory/hooks.json`):
   ```json
   {
     "hooks": {
       "PreToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }
       ],
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "preflight-collector" }] }
       ]
     }
   }
   ```
2. Ensure `preflight-collector` is on `PATH` (`npm link`, or `npm install -g @newrelic/preflight`)
3. Register the Preflight MCP server:
   ```
   droid mcp add preflight "npx preflight --stdio" \
     --env MCP_CLIENT=droid \
     --env NEW_RELIC_LICENSE_KEY=<your-key> \
     --env NEW_RELIC_ACCOUNT_ID=<your-account-id>
   ```
4. Restart Droid

---

## GitHub Copilot (`copilot`)

**Mechanism:** Copilot does not use MCP natively. Data arrives from a Copilot-compatible VS Code extension via HTTP push to a local Preflight endpoint (`http://localhost:9847`). This adapter only consumes events — it doesn't ship the extension itself.

**Detection (`isSupported()`):** `MCP_CLIENT === 'copilot'`, or `NEW_RELIC_AI_PLATFORM === 'copilot'` (the only adapter besides Kiro that actually reads `NEW_RELIC_AI_PLATFORM`).

**Event vocabulary:** `file_edit`→Edit, `file_open`→Read, `file_create`→Write, `file_delete`→Delete, `terminal_command`→Bash, `task`→Bash.

**Known gap:** tool-call timing is approximate — inferred from VS Code event timestamps, not a precise pre/post pair.

**Setup:**

1. Set `NEW_RELIC_AI_PLATFORM=copilot` in your environment
2. Set `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_ACCOUNT_ID`
3. Configure your Copilot extension to forward events to `http://localhost:9847` (`"preflight.endpoint": "http://localhost:9847"` in VS Code settings)

Unlike every other adapter in this document, Copilot has no first-party extension that forwards tool-call events — Preflight only receives what a third-party or user-authored extension chooses to send to the endpoint above. Treat this integration's fidelity as bounded by that extension, not by this adapter's own code.

---

## Generic MCP fallback (`generic-mcp`)

**Mechanism:** Self-report via MCP tools. Always registered last and always `isSupported() === true` — the catch-all for any MCP-speaking client not otherwise named above.

**Tools exposed:**

- `nr_observe_report_tool_call` — report a non-MCP tool call (file read/write/terminal command) manually
- `nr_observe_report_session_start` / `nr_observe_report_session_end` — session lifecycle

**Setup:**

1. Add the Preflight MCP server to your client's MCP configuration: `npx preflight --stdio`
2. Set `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_ACCOUNT_ID`
3. MCP tool calls are captured automatically via the proxy
4. Use `nr_observe_report_tool_call` for non-MCP tool activity
5. Use `nr_observe_report_session_start` / `nr_observe_report_session_end` for session tracking

---

## Adding a new adapter

1. Implement `PlatformAdapter` (`src/platforms/types.ts`) in a new `src/platforms/<name>-adapter.ts`, including a `visibilityLevel` (`full-hooks`, `self-reported`, or `mcp-tools-only` — see the table above) — `platform-registry.test.ts` enforces every registered adapter declares one.
2. Source the tool-name map from the platform's own documentation — never invent entries. Every existing adapter's tool-map comment cites its source; do the same.
3. If the platform has a real hook/callback mechanism, add its event vocabulary as new branches in `src/hooks/collector-script.ts` (see Cursor's or Windsurf's branches for the pattern) — don't assume the platform matches Claude Code's `tool_name`/`tool_input` shape.
4. Register the adapter in `createDefaultRegistry()` (`src/platforms/platform-registry.ts`), before the generic MCP fallback.
5. Add this platform's section to this document, following the structure above: mechanism, detection env vars, tool-map/event vocabulary, known gaps, setup steps.
