---
'@newrelic/preflight': minor
---

**New Relic now attributes all the work a skill drives to that skill, including slash-invoked skills.** A skill run opens on a named `Skill` call or a `/<skill>` prompt and lasts until your next prompt or the next skill. Every `AiToolCall` and `AiTurnCost` row inside the run carries `skill_name`, `skill_source` (`tool` or `slash`), and `skill_run_id`. So `FROM AiTurnCost SELECT sum(cost_usd) WHERE skill_name IS NOT NULL FACET skill_name` is the cost of the whole run, not only the call that loaded the skill, and `uniqueCount(skill_run_id)` counts runs. A skill invoked while another skill's run is open carries `skill_parent_run_id`, so a parent skill's total including the skills it called is `WHERE skill_run_id = X OR skill_parent_run_id = X`. The Adoption & Cost dashboard gains a Skills page, and the team-view dashboard's skill widgets use the new attributes, with Skill Calls replaced by Skill Runs so slash-invoked runs count.

- **Breaking: `skillName` is no longer sent to New Relic.** Replace `skillName` with `skill_name` in saved NRQL and dashboards. Rows sent by earlier versions keep `skillName`.
- The local dashboard's Cost by Skill and `costBySkill` in `nr_observe_get_cost_per_tool` count the whole run the same way, so a skill's cost, tokens, and time are higher than in earlier versions. `callCount` still counts invocations, and average cost is now per invocation.
