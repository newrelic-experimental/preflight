---
'@newrelic/preflight': patch
---

**View sessions →** links from Today's Needs attention, the Git view, and the usage panel no longer open an empty Sessions list when a linked session is older than the newest 50. Sessions now fetches the linked sessions by id, and `GET /api/sessions` accepts an `ids` parameter for that. The "not found" note appears only after that fetch finishes.
