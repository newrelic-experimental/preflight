---
'@newrelic/preflight': patch
---

A `--stdio` engine that starts before it knows its own session id no longer mixes other sessions' tool calls into its tasks, anti-patterns, latency, retry alerts, quality signals, turns, git activity, workflow runs and audit trail. Those now hold only its own session's calls, as its tool-call count already did. Its own calls from before it learned the id still count once it does.
