---
'@newrelic/preflight': minor
---

**Session detail can copy the session as Markdown or JSON.** The Session Detail dialog opened from the Today view has two header buttons. "Copy as Markdown" puts a short summary on the clipboard: name, start time, duration, cost, tool calls, model, tokens, and up to three anti-patterns with their file paths. "Copy as JSON" puts the session summary object as the dashboard already holds it, pretty-printed. Neither button makes a new request. Anti-pattern commands are left out of the Markdown because they are raw shell text.
