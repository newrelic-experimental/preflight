---
'@newrelic/preflight': minor
---

**Session detail can copy the session as Markdown or JSON, or copy a link to it.** The Session Detail dialog opened from the Today view has three header buttons. "Copy as Markdown" puts a short summary on the clipboard: name, start time, duration, cost, tool calls, model, tokens, and up to three anti-patterns with their file paths. "Copy as JSON" puts the session summary object, pretty-printed. "Copy link" puts a URL on the clipboard that opens the session in the Sessions view. No button makes a new request. Anti-pattern commands are left out of the Markdown and the JSON because they are raw shell text.
