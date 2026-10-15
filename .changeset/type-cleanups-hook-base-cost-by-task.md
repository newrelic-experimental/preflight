---
'@newrelic/preflight': patch
---

Cost metrics no longer include a `costByTask` field that was always `null`. Per-task cost is reported on the task records themselves.
