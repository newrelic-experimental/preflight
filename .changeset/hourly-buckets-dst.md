---
'@newrelic/preflight': patch
---

**Today page shows the right hours and totals on daylight saving days.** The spend by hour and tool call charts, the spend headline, the session list and the end-of-day forecast assumed a 24-hour day, so after the clock change events landed an hour off and the last hour spilled into the next day. They now share one end-of-day and bucket by local clock hour.
