---
'@newrelic/preflight': minor
---

**Cursor and Windsurf agents can report their token cost while Preflight's engine is still pending, and it is saved to the conversation that made it.** A pending engine serves every chat in the window, so it cannot keep a report itself. The tool now accepts the report and Preflight's post-MCP hook records it into that conversation, using the conversation id and arguments the hook already carries. The tool takes a new `report_id` per call, so a retried call counts once. Thinking tokens from a report are now saved with the session.
