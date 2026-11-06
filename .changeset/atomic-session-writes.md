---
'@newrelic/preflight': patch
---

**Session files are written atomically, and one corrupt file no longer splits a session.** Two Preflight processes saving the same session could write into the same file at once and corrupt it, after which every later save started a new per-day file. Saves now go through a temp file, retried briefly on Windows when antivirus holds the file. When a session has no other readable file, a file with extra data after a complete session is read up to the end of that first session, and unreadable files are skipped. Before a save replaces a file that is not a clean session, its bytes are kept as `*.corrupt` in the `sessions` folder, and retention deletes those by age like session files.
