---
'@newrelic/preflight': minor
---

Each skill run now has one New Relic row with its cost, tokens and duration. Preflight emits an `AiWorkUnit` event when a run ends, with `cost_usd` and tokens summed from the run's `AiTurnCost` tool rows, a wall-clock `duration_ms`, and `agent_id` and `parent_session_id` when a subagent opened the run. Cost per run and duration per run by skill are now one query on one event. No existing event changes.
