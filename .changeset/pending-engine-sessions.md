---
'@newrelic/preflight': patch
---

**Tool calls are counted under the session that made them.** When several Claude Code sessions start close together, one session's calls could be added to another's count and the other session lost them. Each session now keeps its own calls. A restarted `--local` process also adds the calls it drained to a session's saved count instead of keeping the larger number, so a restart no longer loses them.
