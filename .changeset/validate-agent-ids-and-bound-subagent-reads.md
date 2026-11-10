---
'@newrelic/preflight': patch
---

Hook records now drop a malformed or oversized `agent_id` or `subagent_type` (empty, longer than 128 characters, or containing control characters) instead of sending it on `AiToolCall` and `AiWorkflowRun`. Preflight also stops re-checking finished subagent transcripts on every hook call, so a subagent stuck in a long tool call is still attributed after a session has run dozens of short ones.
