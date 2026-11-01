---
'@newrelic/preflight': patch
---

**A pending engine counts tool calls only under the session that made them.** Before it knows its own session id, Preflight holds the calls it drains for every session and counts its own once it adopts that id. It saves the other sessions' calls for those sessions when it adopts.
