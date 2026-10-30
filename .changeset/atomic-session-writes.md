---
'@newrelic/preflight': patch
---

**Session files are written atomically, and one corrupt file no longer splits a session.** Two Preflight processes saving the same session id could interleave writes and leave a file holding one full JSON document plus a leftover tail. The loader stopped at that file and treated the session as missing, so every later save started a fresh per-day file. Saves now write to a temp file and rename it into place. A file with a leftover tail is read from its first complete document, and the loader skips any file it still can't read instead of giving up. Files a session was already split into stay as they are, since they hold separate activity.
