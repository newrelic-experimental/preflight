---
'@newrelic/preflight': patch
---

**`AiCodingTask` events for a task that ends without another tool call are sent right away.** A task closed by the idle timeout, by the end of a turn (the `Stop` hook), or by `nr_observe_mark_task_boundary` was only sent to New Relic when a later tool call arrived, so the last task of a session was often never sent. Each of these closes, and shutdown, now sends the finished task, runs its anti-pattern checks, and scores it right away. A `--stdio` server that has not resolved its real session id still scores tasks locally, and holds them for sending. Once it adopts an id it sends only the held tasks whose every tool call belongs to that session, and drops the rest.
