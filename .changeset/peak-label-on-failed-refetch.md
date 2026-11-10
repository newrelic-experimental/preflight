---
'@newrelic/preflight': patch
---

**The session trace no longer shows a stale "Peak N parallel" label after a failed subagent refetch.** The label now hides together with the lanes when the refetch errors.
