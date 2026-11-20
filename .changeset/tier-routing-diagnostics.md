---
'@newrelic/preflight': minor
---

You can now confirm where multi-tier telemetry is going. Preflight logs the resolved tiers at startup, and `nr_observe_get_config` and the dashboard's `/api/settings` return `tiers` and `primaryTier` (names, destinations, event types, no license keys). `nr_observe_get_config` also shows write and failure counts for each local tier, so a tier with a bad path no longer fails silently.
