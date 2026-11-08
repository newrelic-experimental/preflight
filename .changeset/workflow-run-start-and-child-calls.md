---
'@newrelic/preflight': patch
---

**`AiWorkflowRun` reports when an `Agent` call started and counts its subagent's calls.** `started_at` is the `Agent` call's start, and the event `timestamp` is its end. `tool_call_count` and `child_agent_count` count the tool calls and `Agent` calls the spawned subagent finished before the `Agent` call returned, matched by the subagent's `agent_id`. A background `Agent` call returns at launch, so its counts are usually `0`.
