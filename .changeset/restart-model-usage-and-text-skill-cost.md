---
'@newrelic/preflight': patch
---

Two cost-accounting gaps are closed. After a `--local` restart, Model Usage keeps the requests a session made before the restart instead of counting only the ones after it. Replies in a text-only skill run (a `/<skill>` prompt that makes no tool calls) now carry the skill's name and run id on their `AiTurnCost` rows, so the adoption-cost dashboard's USD / Run no longer drops their cost.
