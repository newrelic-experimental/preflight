---
'@newrelic/preflight': patch
---

A background subagent is now attributed to the skill run that spawned it. Before, its calls carried the run the main agent had open when Preflight first processed one of them, so a prompt typed while the subagent worked, such as `/simplify`, took its `AiToolCall` and `AiTurnCost` rows. Preflight now reads the spawning `Agent` call's id from the subagent's `agent-<id>.meta.json` sidecar and pins the subagent to the run open when that call started. A run the subagent opened itself is kept. Without a sidecar id, or when the `Agent` call's start was not seen, the old behavior applies.
