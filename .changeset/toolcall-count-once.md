---
'@newrelic/preflight': patch
---

**Each tool call now counts once, with its real outcome.** Bash calls may run 11 minutes and Agent calls 30 minutes before they count as a timeout. A call that finishes after its timeout replaces the timeout record with its real outcome and duration. A call still running at shutdown is saved as a timeout, and its finish after a restart no longer adds a second record. A post without a `toolUseId` no longer pairs with a pre from another session.
