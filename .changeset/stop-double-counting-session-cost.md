---
'@newrelic/preflight': patch
---

**A session's cost could be counted twice.** Three cases are fixed.

- A session's saved cost no longer counts the parent's spend twice when a subagent starts after a checkpoint. Preflight now folds in only the part of the saved cost that another writer added beyond what it had already checkpointed.
- Byte-size cost estimates are taken back out once the transcript watcher's first real token report arrives, instead of staying in the total alongside the same turns reported as exact usage. The estimated share is saved with the session, so a restart before the first report doesn't keep it either. Subagent reports and single-response self-reports (`nr_observe_report_tokens`) don't remove it. Platforms that never report tokens keep their estimate.
- A `--stdio` server that drains another session's token reports before its own session id resolves no longer adds that cost to its own session total or model usage, and no longer emits an `AiTurnCost` event for it under its own session id. The cost still goes to the other session's record. `--local` is unchanged.
