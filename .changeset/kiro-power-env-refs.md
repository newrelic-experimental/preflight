---
'@newrelic/preflight': patch
---

The Kiro Power's `mcp.json` now reads its settings from `${VAR}` environment references and pins the Preflight version, and its setup skill no longer asks you to paste your New Relic license key or account ID into chat. Set `NR_AI_MODE` and `NEW_RELIC_AI_PLATFORM` in the environment Kiro launches from; for cloud mode, add `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_ACCOUNT_ID` as `${VAR}` references yourself. The README now lists what cloud mode sends.
