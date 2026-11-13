---
'@newrelic/preflight': minor
---

Skill runs that make no tool calls now show up in New Relic. A `/<skill>` prompt that Claude answers with text only used to leave no rows, so run counts undercounted. Preflight now emits one `AiSkillRun` event when each skill run opens, for every run, and the skill run counts on the adoption dashboard include them. Runs that have tool calls keep their `AiToolCall` and `AiTurnCost` rows, which still carry the same `skill_run_id`. The cost of a text-only run's replies is not yet attributed to the skill, so USD / Run is understated for skills that have such runs.
