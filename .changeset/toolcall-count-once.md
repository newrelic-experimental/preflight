---
'@newrelic/preflight': patch
---

**Each tool call now counts once, with its real outcome.** Bash calls may run 11 minutes and Agent calls 30 minutes before they count as a timeout. A call that finishes after its timeout replaces the timeout record in the session summary and dashboard with its real outcome and duration. Events already sent to New Relic are not changed. A call still running at shutdown is saved as a timeout, and its finish after a restart no longer adds a second record when the post names its session. A post without a `toolUseId` no longer pairs with a pre from another session when both name their session.
