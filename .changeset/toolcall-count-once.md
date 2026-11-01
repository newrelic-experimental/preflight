---
'@newrelic/preflight': patch
---

**Each tool call now counts once, in the session that made it, with its real outcome.** A call still running when Preflight swaps its store keeps pairing normally. Bash calls may run 11 minutes and Agent calls 30 minutes before they are counted as a timeout. A call that finishes after its timeout replaces the timeout record with its real outcome and duration, and after a restart its finish no longer adds a second record. A pending engine no longer adds other sessions' calls to its own count. It saves them for their own sessions when it adopts its id. A post without a `toolUseId` now pairs only with a pre from its own session.
