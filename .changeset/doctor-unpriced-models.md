---
'@newrelic/preflight': minor
---

`preflight doctor` has a new "Unpriced models" check. It lists models from the last 7 days of sessions that Preflight cannot price (their cost shows as $0) with a call count, and points you at the `aliases` option in `customPricingFile`. A model drops off the list once it can be priced.
