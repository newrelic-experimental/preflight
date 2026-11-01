---
'@newrelic/preflight': patch
---

**A pending engine counts tool calls only under the session that made them.** Before it knows its own session id, Preflight counts none of the calls it drains, then counts its own session's calls once it adopts that id. It saves the other sessions' calls for those sessions when it adopts, with a call still running counted once as a timeout, and a wrongly guessed session's calls under that session when the guess is corrected. After a correction, other Preflight processes drain the guessed session's later calls again, and a guess no longer takes over the heartbeat of the guessed session's own engine.
