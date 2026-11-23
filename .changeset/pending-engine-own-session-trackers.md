---
'@newrelic/preflight': patch
---

A `--stdio` engine that starts before it knows its own session id no longer mixes other sessions' tool calls into its tasks, anti-patterns, latency, retry alerts, quality signals, turns, git activity, workflow runs and audit trail. Those now hold only its own session's calls, as its tool-call count already did. Other sessions' prompts and Stops no longer start or close its tasks and turns. Once it learns its id, its own calls, token reports, prompts and Stops from before then reach those trackers in the order they arrived, so each tool burst gets its own cost and each Stop closes its task.
