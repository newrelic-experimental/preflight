---
'@newrelic/preflight': patch
---

**`ai.retry.alerts_total` and `ai.retry.tokens_wasted` now reach New Relic.** These tool-call thrashing metrics were documented but never sent, so queries returned no data. Once a thrashing alert has fired, each metric harvest reports the session's running totals, like the other cumulative gauges, so chart them with `latest()` or `max()`. They are not suppressed by `companionMode`, because they count tool-call thrashing rather than cost.
