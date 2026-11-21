---
'@newrelic/preflight': minor
---

Add named retention presets for local data. Set `retentionPolicy` in `config.json`, or `NEW_RELIC_AI_RETENTION_POLICY`, to one of `default` (90 days), `gdpr-minimisation` (30), `soc2-audit` (365), `hipaa-audit` (2190), or `minimal` (7) instead of looking up a day count. `preflight setup --retention <policy>` writes the choice without a prompt, and the setup wizard now asks for it. An explicit `retainSessionsDays` still wins over a preset. Presets govern only the local session, weekly summary, and ledger files. They do not change data already sent to New Relic.
