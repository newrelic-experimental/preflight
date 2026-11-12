---
'@newrelic/preflight': patch
---

**The session trace no longer keeps the old subagent time span after a failed subagent refetch.** The parent lane now spans only the parent's own tool calls once the lanes are gone.
