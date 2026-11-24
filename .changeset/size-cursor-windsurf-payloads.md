---
'@newrelic/preflight': patch
---

Cursor and Windsurf tool calls now record how much they read and wrote. The hook collector sizes Cursor's shell output, MCP results, file reads and edits, and Windsurf's edits and MCP results, from the payload fields that carry them. A Cursor read or edit has no pre event, so its input size now comes from the post event. Windsurf's `post_read_code` sends no file content, so the collector sizes the read with one stat of the absolute file path and records 0 when that fails. Windsurf sends no command output, so a Windsurf command still records no output size.
