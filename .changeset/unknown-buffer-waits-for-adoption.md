---
'@newrelic/preflight': patch
---

A call made before its session id is known is no longer lost when the engine that saw it exits before adopting that session. The call stays in the no-session buffer until the engine that adopts the session counts it, once. Before, a still-pending engine could drain the buffer, save no tracker count, and exit, so the call was dropped.
