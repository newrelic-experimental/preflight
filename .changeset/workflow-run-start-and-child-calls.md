---
'@newrelic/preflight': patch
---

**`AiWorkflowRun` reports when an `Agent` call started and counts its subagent's calls.** `started_at` is the `Agent` call's start, and the event `timestamp` is its end. `tool_call_count` and `child_agent_count` count the tool calls and `Agent` calls recorded for the spawned subagent, matched by its `agent_id`, until the `Agent` call returns. A call that resumes a subagent also counts that subagent's calls left over from earlier calls. A call that outlives the 30-minute timeout emits a timed-out row with `0` counts, then a completed row with the counts. A background `Agent` call returns at launch, so its counts are usually `0`. A tool call whose `PreToolUse` was lost, for example across an engine restart, now starts one reported duration before its `PostToolUse`.
