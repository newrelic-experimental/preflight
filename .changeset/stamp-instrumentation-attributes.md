---
'@newrelic/preflight': minor
---

Every event Preflight sends to New Relic or writes to a local tier now carries `instrumentation.provider`, `instrumentation.name` (both `"preflight"`), and `instrumentation.version`, so you can filter Preflight events apart from other instrumentation.
