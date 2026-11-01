---
'@newrelic/preflight': patch
---

**Each tool call now counts once, in the session that made it.** A call that runs longer than 60 seconds, or is still running when Preflight swaps its store, exits or restarts, no longer adds a second record when it finishes. A pending engine no longer adds other sessions' calls to its own count. It saves them for their own sessions when it adopts its id. A post without a `toolUseId` now pairs only with a pre from its own session.
