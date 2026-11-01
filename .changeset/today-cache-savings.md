---
'@newrelic/preflight': patch
---

Fix: the Today page now shows the cache savings the API reports. Sessions recorded by the shared aggregator persisted their cache tokens but no savings, so the Cache Health card read $0.00. Sub-cent savings render as "<$0.01".
