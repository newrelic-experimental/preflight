---
'@newrelic/preflight': patch
---

A tool call is now attributed to the skill run that was open when the call started, not the one open when its record was written. Before, a call that finished after the next prompt, such as a long `Bash` command the user interrupted to type `/simplify`, carried the new prompt's skill on its `AiToolCall` and `AiTurnCost` rows. Calls whose start Preflight did not see, for example across an engine restart, keep the old behavior.
