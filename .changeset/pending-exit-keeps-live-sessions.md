---
'@newrelic/preflight': patch
---

A `--stdio` engine that exits before it learns its own session id no longer marks a session it observed as completed while that session's own engine is still running. That session stays in progress in saved session records until its own engine ends it. A session with no running engine is still saved as completed, and an engine that starts for it later moves it back to in progress as soon as it boots.
