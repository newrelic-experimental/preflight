---
'@newrelic/preflight': patch
---

**Spend Today includes the current session and stays the same across a restart.** The dashboard left out the live session's cost once that session had saved a checkpoint the same day, which happens 30 seconds after it starts. A restarted Preflight also recomputed today's cost from the session timeline instead of the saved per-day total, and could drop a checkpoint's cost when the live session had not yet been restored from it. A saved session with no recorded activity no longer adds its lifetime total to today after a restart.
