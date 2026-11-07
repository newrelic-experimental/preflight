---
'@newrelic/preflight': patch
---

Pricing lookups that bypass model-name normalization and custom pricing aliases now fail lint, so a model named by an ARN or gateway cannot silently price at $0 from a new call site.
