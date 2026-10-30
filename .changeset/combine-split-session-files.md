---
'@newrelic/preflight': patch
---

**A session split across several files is listed once, with its activity added up.** Sessions hit by #997 were saved as one file per day they were resumed, so history listed them several times. Preflight now combines a session's files into one record. Files whose tool-call timelines share no entry hold separate activity and are added together. Files that share entries, or have no timeline, are copies of the same activity and keep the larger value. The next save of that session writes the combined record and removes the other files. Unreadable `*.corrupt` files are kept.
