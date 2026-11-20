---
'@newrelic/preflight': patch
---

A session the dashboard or a pending engine observed now saves how many tasks it completed, instead of 0. Each session's task count comes from that session's own tool calls and Stop or prompt events, so two sessions in one process no longer share a count.
