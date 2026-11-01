---
'@newrelic/preflight': patch
---

The end-of-day, end-of-week, and session-end cost forecasts now stay blank until they have 10 minutes of activity to extrapolate from, instead of projecting from the first few seconds of spend. A session that crossed midnight with no spend yet today no longer projects yesterday's spend over today.
