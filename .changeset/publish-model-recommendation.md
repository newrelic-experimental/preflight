---
'@newrelic/preflight': minor
---

Preflight now writes its model recommendation to `model-recommendation.json` in its storage directory once the recommendation reaches high confidence, so a shell hook can read it without calling an MCP tool. The file is removed when confidence drops.
