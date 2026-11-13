---
'@newrelic/preflight': patch
---

A `--stdio` engine that exits before it learns its own session id no longer marks the other sessions it observed as completed. It saves them as in progress, so a session still running in another engine stays live on the dashboard until its own engine ends it.
