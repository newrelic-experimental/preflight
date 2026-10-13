---
'@newrelic/preflight': minor
---

**New Relic now attributes all the work a skill drives to that skill, including slash-invoked skills.** A skill run opens on a named `Skill` call or a `/<skill>` prompt and lasts until your next prompt or the next skill. Every `AiToolCall` and `AiTurnCost` row inside the run carries `skill_name`, `skill_source` (`tool` or `slash`), and `skill_run_id`. So `FROM AiTurnCost SELECT sum(cost_usd) WHERE skill_name IS NOT NULL FACET skill_name` is the cost of the whole run, not only the call that loaded the skill, and `uniqueCount(skill_run_id)` counts runs. The team-view dashboard's skill widgets use the new attributes.

- **Breaking: `skillName` is no longer sent to New Relic.** Replace `skillName` with `skill_name` in saved NRQL and dashboards. Rows sent by earlier versions keep `skillName`.
- The local dashboard's Cost by Skill and `costBySkill` in `nr_observe_get_cost_per_tool` count the whole run the same way, so a skill's cost, tokens, and time are higher than in earlier versions. `callCount` still counts invocations, and average cost is now per invocation.
