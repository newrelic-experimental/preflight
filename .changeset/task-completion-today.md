---
'@newrelic/preflight': minor
---

**Today shows completed-task counts, average task duration, and average tool calls per task.** The dashboard had no view of task completion, so the numbers were only available through the `nr_observe_get_task_completion_rate` MCP tool. Today now has a "Tasks (this process)" block that reads a new `GET /api/task-completion` route. The block reports the completed task count, average duration, and average tool calls per task since the dashboard process started, so the counts start again after a restart and are not limited to today. It shows an empty-state line until a task completes.
