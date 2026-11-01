---
'@newrelic/preflight': patch
---

Fix the Today page end-of-day forecast disagreeing with `/api/cost`. Session summaries now persist the first token event of each day (`firstActivityByDayMs`), and the cross-session aggregate anchors its burn rate there, the same anchor `/api/cost` uses, instead of at the first tool call. The page shows the aggregate forecast once the aggregate has seen today's spend, and bridges with the live SSE or `/api/cost` figure until then.
