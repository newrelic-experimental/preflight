---
'@newrelic/preflight': patch
---

Hook records now drop a malformed or oversized `agent_id` or `subagent_type` (empty, longer than 128 characters, or containing control characters) instead of sending it on `AiToolCall` and `AiWorkflowRun`. A subagent that is still working is now attributed no matter how many finished or abandoned subagents the session ran before it, including after Preflight restarts mid-session. Preflight no longer re-checks transcripts that ended on a tool result nobody answered for 15 minutes, or on a final answer more than 15 minutes ago. A subagent woken shortly after its final answer is still attributed at once.
