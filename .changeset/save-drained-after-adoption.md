---
'@newrelic/preflight': patch
---

**Activity a pending server collected is counted once when it adopts its session id.** While a `--stdio` server waits for its session id, it collects hook events, self-reported token counts and subagent turns for every conversation on the machine. Before, a server that adopted its session id never saved what it had collected for that session itself, and another conversation's collected activity was lost when its one save failed. Now the server saves what it collected for the session it adopts before it seeds from that session's file. Each other conversation's collected activity is saved at every checkpoint until a write succeeds, and a failed write or a rollup that fails to build does not block the server's own save. A subagent turn collected for another conversation no longer adds to the server's own cost. A session file keeps the larger self-report count.
