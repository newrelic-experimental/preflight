---
'@newrelic/preflight': patch
---

Fix the end-of-day forecast disagreeing between the Today page and `/api/cost`, including after a restart. Session summaries now persist the first spend of each day (`firstActivityByDayMs`). The cross-session aggregate anchors its burn rate there instead of at the first tool call, and a restarted session seeds `/api/cost` from it instead of the restart time. Only events that cost something anchor the day. The page shows the aggregate forecast, falls back to the live SSE or `/api/cost` figure when the aggregate has none, and shows no forecast that is below the spend on the tile.
