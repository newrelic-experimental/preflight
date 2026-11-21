---
'@newrelic/preflight': patch
---

When two Preflight engines of one session run at once and the one named in the session's heartbeat exits first, the other one now takes the heartbeat back at its next checkpoint. Before, it ran with no heartbeat, so a `--local` dashboard or a pending engine could drain its buffer beside it.
