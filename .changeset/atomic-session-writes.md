---
'@newrelic/preflight': patch
---

**Session files are written atomically, and one corrupt file no longer splits a session.** Two Preflight processes saving the same session id could interleave writes and leave a file holding one full JSON document plus a leftover tail. The loader stopped at that file and treated the session as missing, so every later save started a fresh per-day file. Saves now write to a temp file and rename it into place, and retry briefly when another program, such as antivirus on Windows, holds the file. When a session has only one file and that file has a leftover tail, Preflight reads its first complete document. The loader skips any file it still can't read instead of giving up. Before a save replaces a file it could not parse, it keeps the original bytes in a `.corrupt` file, and retention deletes those by age like session files. Files a session was already split into stay as they are, since they hold separate activity.
