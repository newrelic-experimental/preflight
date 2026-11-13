---
'@newrelic/preflight': patch
---

A call made before its session id is known is now counted when the engine that saw it exits before adopting that session, as long as a session is adopted within 5 minutes of the last such call. The call stays in the no-session buffer until the engine that adopts the session counts it, once. Before, a still-pending engine could drain the buffer, save no tracker count, and exit, so the call was dropped. If no engine adopts within 5 minutes, cleanup archives the buffer, which keeps it on disk without counting it. That case is tracked in #1196.
