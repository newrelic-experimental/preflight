---
'@newrelic/preflight': patch
---

**The History concurrency chart now counts resumed sessions, and today's bar matches the Today view.** Before, a session resumed from before the chart's window was left out, and today's bar could show a stale or inflated lifetime peak. History now loads resumed sessions and computes today's value the same way the Today view's headline peak does.
