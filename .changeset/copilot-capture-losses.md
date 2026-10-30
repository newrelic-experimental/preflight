---
'@newrelic/preflight': patch
---

**Preflight no longer loses GitHub Copilot usage records.** A Copilot request whose log line was larger than 4 MiB was dropped; its usage is now read from the start and end of the line with memory bounded, and a line whose usage fields cannot be recovered is counted as a parse error instead of recorded as zero. A session log that went quiet for more than `discoveryHours` while it still had unread lines is now read. A log that is truncated or rotated no longer corrupts its first new line with leftover bytes from the old file. A chat-only Copilot session, with cost but no tool calls, is now saved to session history and listed in History. This change does not retry a record whose buffer write failed; that retry is handled separately.
