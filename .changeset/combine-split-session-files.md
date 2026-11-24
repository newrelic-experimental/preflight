---
'@newrelic/preflight': patch
---

**A session split across several files is listed once, with its activity added up.** Some sessions were saved as one file per day they were resumed, so history listed them several times and the session's own page showed only one piece. Preflight now combines a session's files into one record when it reads them, recovered files included. Files that share a tool call on their timelines are copies of the same activity and keep the larger value; files that share none hold separate activity and add, byte estimates included. A file with no timeline keeps the larger value. A load limited to recent days combines only the files in that window. The next save of the session writes the combined record and renames the other files to `*.merged`, which nothing reads and retention deletes by age. Separate activity in a file with no timeline is not added.
