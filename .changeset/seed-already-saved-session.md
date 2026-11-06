---
'@newrelic/preflight': patch
---

Stop double counting a session that Preflight had already saved before it seeded it. A session first guessed from the working directory and confirmed later no longer has its cost and tokens doubled, and a session adopted after its first tool calls no longer has them counted twice.
