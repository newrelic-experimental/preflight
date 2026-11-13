---
'@newrelic/preflight': patch
---

**A cwd guess stops holding the wrong session's buffer.** After a correction, other Preflight processes drain the guessed session's later calls again. A guess no longer takes over the heartbeat of the guessed session's own engine. It takes the heartbeat later, once that engine exits or the ppid breadcrumb confirms the guess.
