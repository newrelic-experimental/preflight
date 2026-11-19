---
'@newrelic/preflight': minor
---

The New Relic account ID is now optional. Preflight sends events to the Events API endpoint that has no account ID in its URL, so the license key alone picks the destination account, and a mistyped ID can no longer cause an empty 403. `accountId` (top-level and per tier) and `NEW_RELIC_ACCOUNT_ID` are still accepted and are only needed to deploy dashboards and alerts and to query team summaries (`nr_observe_get_team_summary` now says it needs `accountId` when it is unset). `preflight setup` lets you skip the account ID, and the license key check no longer sends one.
