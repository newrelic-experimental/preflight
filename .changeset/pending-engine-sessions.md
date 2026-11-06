---
'@newrelic/preflight': patch
---

**A pending engine counts tool calls under the session that made them.** Before it knows its own session id, Preflight saves none of the calls it drains under its own session. Once it adopts an id, it counts that session's calls, and it saves the other sessions' calls for those sessions, or a wrongly guessed session's calls under that session after a correction. A session that already has a file keeps those calls: its count is the file's count plus this process's calls. When Preflight swaps its store at adoption, its own calls in flight keep pairing, and another session's call in flight counts once. It counts as a timeout for a session with no file. For a session with a file it counts when its post arrives, so a call that never finishes stays uncounted there. Until a pending engine adopts an id, `/api/session/current` still shows every call it drained.
