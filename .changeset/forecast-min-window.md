---
'@newrelic/preflight': patch
---

The end-of-day, end-of-week, and session-end cost forecasts now stay blank until they have 10 minutes of activity to extrapolate from, instead of projecting from the first few seconds of spend. When end-of-day and end-of-week are blank, the forecast now carries a `heldReason` ("held: under 10 minutes of today's data" or "held: no spend yet today"). A session that started before local midnight in this process and has no spend yet today no longer projects yesterday's spend over today. This does not cover a mid-session restart, where the session start and today's first activity are both the restart time, so a resumed session can still project a spike after 10 minutes (#1033).
