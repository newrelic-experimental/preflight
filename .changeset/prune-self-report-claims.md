---
'@newrelic/preflight': patch
---

The storage directory no longer keeps one empty file for every token report a Cursor or Windsurf hook recorded. The retention sweep now removes these duplicate-guard files once they are 7 days old, and each conversation's `self-reports` folder once it is empty. A retried hook call still cannot record the same report twice, because its retries land within seconds.
