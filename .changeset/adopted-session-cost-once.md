---
'@newrelic/preflight': patch
---

A `--stdio` engine that starts before its session id is known and then resumes a saved session no longer counts that session's earlier cost twice in daily and weekly spend, so budget thresholds no longer fire early.
