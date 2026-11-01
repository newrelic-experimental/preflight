---
'@newrelic/preflight': patch
---

**A pending engine counts tool calls only under the session that made them.** Before it knows its own session id, Preflight counts none of the calls it drains, then counts its own session's calls once it adopts that id. It saves the other sessions' calls for those sessions when it adopts, and a wrongly guessed session's calls under that session when the guess is corrected.
