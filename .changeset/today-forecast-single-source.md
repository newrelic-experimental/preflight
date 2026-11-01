---
'@newrelic/preflight': patch
---

Fix the Today page end-of-day forecast jumping to tens of dollars while `/api/cost` reported cents. The cross-session aggregate now anchors its burn rate at the start of a session that has spend today, not at its first tool call, and the page shows the aggregate forecast as its only source once it has resolved instead of falling through to the SSE or `/api/cost` figure.
