---
'@newrelic/preflight': patch
---

**The Today view's concurrency chart now counts sessions you resumed, and its session counts are the real ones.** Before, a session resumed on a later day was left out of that day's concurrency, so the chart under-reported how many sessions ran at once. The concurrency endpoint now loads resumed sessions, and the chart shows the actual session counts instead of an approximation.
