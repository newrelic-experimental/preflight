---
'@newrelic/preflight': patch
---

A Cursor, Windsurf, or Antigravity conversation's self-reported cost now survives an engine restart, is saved even when the report is the conversation's only activity, and keeps its thinking tokens. A malformed `nr_observe_report_tokens` call now fails with the stable code `invalid_token_report`, with the details in `message`.
