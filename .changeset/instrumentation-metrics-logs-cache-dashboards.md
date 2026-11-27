---
'@newrelic/preflight': minor
---

Preflight's Metric API gauges and Logs API audit entries now carry `instrumentation.provider`, `instrumentation.name` and `instrumentation.version`, the same attributes events already had, so one filter on `instrumentation.provider` finds all of Preflight's telemetry. The Personal dashboard gains cache hit rate, its weekly trend and the share of spend caching avoided, and the Overview dashboard gains cache hit rate and the same savings share.
