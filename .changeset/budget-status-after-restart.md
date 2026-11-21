---
'@newrelic/preflight': patch
---

**Daily and weekly budget status read zero after a restart, and a threshold crossed before it fired again.** A restarted process now starts the daily and weekly spend from what the period already has recorded, so `/api/budget` shows it before the first cost event. Thresholds that spend already crossed are marked fired without alerting, so only a newly crossed threshold alerts.
