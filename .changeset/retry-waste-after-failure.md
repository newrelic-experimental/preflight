---
'@newrelic/preflight': patch
---

**Compute Waste no longer counts normal work as retries.** A run of successful tool calls with similar inputs, such as reading different line ranges of a file or starting several subagents, used to count as a retry and mark the card "Needs attention". A retry now needs a failed call first. Each repeated call is also charged once, where a burst used to be charged again each time the window moved. Retry alerts, `nr_observe_get_compute_waste`, `nr_observe_get_retry_alerts`, and `ai.retry.*` report lower numbers as a result.
