---
'@newrelic/preflight': patch
---

**A pending engine counts tool calls only under the session that made them.** Before it knows its own session id, Preflight counts none of the calls it drains, then counts its own session's calls once it adopts that id. It saves the other sessions' calls for those sessions when it adopts, and a wrongly guessed session's calls under that session when the guess is corrected. When Preflight swaps its store at adoption, its own calls in flight keep pairing, and another session's call in flight counts once, as a timeout, even when another process drains its finish. Calls saved this way for a session that already has a session file can stay uncounted, because session files merge by maximum. After a correction, other Preflight processes drain the guessed session's later calls again, and a guess no longer takes over the heartbeat of the guessed session's own engine.
