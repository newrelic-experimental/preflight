---
'@newrelic/preflight': patch
---

**`AiCodingTask` events for a task closed by the idle timeout are sent without waiting for another tool call.** A task that went idle, such as the last task of a session, was only sent to New Relic when a later tool call arrived, so it was often never sent. The idle close and shutdown now send the finished task, run its anti-pattern checks, and score it right away.
