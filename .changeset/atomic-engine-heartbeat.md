---
'@newrelic/preflight': patch
---

**A session's tool calls are no longer lost when several Preflight engines start at once.** Each engine writes a heartbeat file naming its process so the others know its session's buffer has an owner. Another engine that read that file in the instant it was being written saw no owner, archived the session's buffer as an orphan, and deleted the heartbeat, so the session's engine counted none of the calls captured before it started. The heartbeat is now written to a temporary file and renamed into place, so other engines see either no heartbeat or a complete one. When Windows refuses the rename because antivirus holds the file, the engine writes the heartbeat directly instead, so it always has one.
