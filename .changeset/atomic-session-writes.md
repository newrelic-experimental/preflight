---
'@newrelic/preflight': patch
---

**Session files are written atomically, and sessions split across several files heal themselves.** Two Preflight processes saving the same session id could interleave writes and leave a file holding one full JSON document plus a leftover tail. The loader then treated that session as missing and wrote a fresh file each time, so one session showed up as several rows in history. Saves now write to a temp file and rename it into place, a file with a leftover tail is read from its first complete document, and the next save of a split session merges its files into one. Session history also merges duplicate files for the same id, which fixes old sessions that will never be saved again.
