---
'@newrelic/preflight': patch
---

**Spend Today includes the current session and stays the same across a restart.** The dashboard left out the live session's cost once that session had saved a checkpoint the same day, which happens 30 seconds after it starts. A restarted Preflight also recomputed today's cost from the session timeline instead of the saved per-day total.
