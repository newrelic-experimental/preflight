---
'@newrelic/preflight': patch
---

A background subagent keeps the skill run that spawned it even when Preflight reads its transcript before it processes the spawning `Agent` call's start. Before, that pin was dropped, so the subagent's first calls carried the run the main agent had open when Preflight first processed one of them, such as a later `/simplify`. The pin now waits for the `Agent` call's start and applies then.
