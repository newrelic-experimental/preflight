---
'@newrelic/preflight': patch
---

**Activity a pending server collected is no longer lost when it finds its own session.** This applies to servers that adopt a session id, which today means Claude Code. Cursor and Windsurf servers do not adopt, and they save what they collected through their own save, as before. While a `--stdio` server waits for its session id, it collects hook events and self-reported token counts for every conversation on the machine. Before, once it found its own session, it saved only that session, and a collected report or tool call that had not been saved yet was dropped. Now each conversation's collected activity is saved at every checkpoint until a write succeeds, so a failed write is retried and does not block the server's own save. What the server collected for the session it adopts is saved before it seeds from that session's file. A report for its own session reaches its own cost and model usage. A session file keeps the larger self-report count.
