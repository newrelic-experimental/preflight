---
'@newrelic/preflight': patch
---

**An assistant started from a Claude Code terminal keeps its own session, and Claude Code no longer adopts it.** Before, a Codex, Droid, or Gemini CLI hook command that names no assistant, as older setups do, inherited Claude Code's environment when run from a Claude Code terminal. The collector filed its session breadcrumbs and tool calls under Claude Code, so that assistant's Preflight server never found its session, and a Claude Code server in the same directory could take it over. The collector now files a hook under Claude Code only when `CLAUDE_CODE_SESSION_ID` is unset or names the hook's own session. A Claude Code build that never sets `CLAUDE_CODE_SESSION_ID` keeps the old behavior.
