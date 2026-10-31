---
'@newrelic/preflight': minor
---

**Cursor and Windsurf agents can report their token cost while Preflight's engine is still pending, and it is saved to the conversation that made it.** A pending engine serves every chat in the window, so it cannot keep a report itself. The tool now accepts the report and Preflight's post-MCP hook records it into that conversation, using the conversation id and arguments the hook already carries. The tool takes a new `report_id` per call, and the hook saves each `report_id` once per conversation, even when another process drains the retry. When no hooks file runs Preflight's collector for the post-MCP event, the reply says the report will not be saved until the hook is added. Thinking tokens from a report are now saved with the session.
