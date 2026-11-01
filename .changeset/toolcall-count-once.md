---
'@newrelic/preflight': patch
---

**Each tool call now counts once, with its real outcome.** Bash calls may run 11 minutes and Agent calls 30 minutes before they count as a timeout. A call that finishes after its timeout replaces the timeout record with its real outcome and duration. A call still running at shutdown is saved as a timeout, and its finish after a restart no longer adds a second record. When Preflight swaps its store, its own calls in flight keep pairing, and other sessions' calls go back to their own buffers. A post without a `toolUseId` now pairs only with a pre from its own session.
