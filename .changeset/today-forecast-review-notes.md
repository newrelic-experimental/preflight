---
'@newrelic/preflight': patch
---

Keep each day's saved first spend when a restarted local dashboard seeds a session from its saved file, and leave a day unanchored when one process seeds a legacy and an anchored session in either order. The Today page now shows the first of the aggregate, live SSE and `/api/cost` forecasts that is not below the spend on the tile instead of hiding the figure when the first one is stale. It names the forecast's scope (all sessions, all spend so far at this session's pace for the live one, or this session), and keeps the week projection when no day forecast shows.
