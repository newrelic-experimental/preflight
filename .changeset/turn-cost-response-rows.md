---
'@newrelic/preflight': minor
---

`AiTurnCost` now includes responses that no tool call claimed: the first response after each prompt, which asks for that turn's tools, and every text-only reply. Before, Preflight dropped the token report for each of them, so their cost never reached New Relic. Each one now arrives as its own row with no `tool` or `tool_use_id` and `turn_tool_call_count` set to 0. Because those responses now count, `AiTurnCost` totals rise at the upgrade by roughly the share of spend that previously never reached `AiTurnCost`. To total cost per tool, add `WHERE tool IS NOT NULL` to your query. The local dashboard and `nr_observe_get_cost_per_tool` are unchanged.
