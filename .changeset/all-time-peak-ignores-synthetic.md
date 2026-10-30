---
'@newrelic/preflight': patch
---

**The Today view's "all-time" concurrency peak is no longer inflated by internal bookkeeping sessions.** It used to include a per-process live peak that counted `local-*`, `proxy-*` and `pending-*` ids and never reset. It now comes only from persisted sessions and today's activity.
