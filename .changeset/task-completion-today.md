---
'@newrelic/preflight': minor
---

**Today shows completed-task counts, average task duration, and average tool calls per task.** The dashboard had no view of task completion, so the numbers were only available through the `nr_observe_get_task_completion_rate` MCP tool. Today now has a Tasks block that reads a new `GET /api/task-completion` route. The block reports the completed task count, average duration, and average tool calls per task for the dashboard process. It shows an empty-state line until a task completes.
