---
'@newrelic/preflight': patch
---

A hook event that follows a torn write to the hook buffer is now recorded. Before, when a write was cut short and the marker that ends it also failed, as on a full disk, the next event was appended to the fragment and both were dropped. Each event now starts with its own line break, so a fragment can no longer swallow the event after it.
