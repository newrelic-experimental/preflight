---
'@newrelic/preflight': patch
---

**Cursor and Windsurf sessions now save a cost instead of none.** Each conversation gets a byte-size estimate of its own tool input and output, priced at the default model. The estimate leaves out prompts, replies, and cache tokens, so it undercounts. Cursor and Windsurf agents cannot report exact token counts today, so the estimate is the only cost these sessions carry. The estimate survives a dashboard restart. Hook events from Cursor and Windsurf are now labelled with their platform even when the hook command sets no `MCP_CLIENT`.
