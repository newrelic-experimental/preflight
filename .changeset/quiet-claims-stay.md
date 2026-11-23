---
'@newrelic/preflight': patch
---

**A pending engine no longer counts another session's call after it adopts its own session.** When the store swap could not take a claim of another session's buffer, the adopted engine later read that call and counted it under its own session. The call now counts only in its own session.
