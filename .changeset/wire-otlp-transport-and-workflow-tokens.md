---
'@newrelic/preflight': patch
---

Setting `otlp.transport` to `otlp` or `both` now actually sends events and metrics over OTLP, as `docs/ADVANCED.md` describes. Before, the setting never reached the harvest scheduler and everything went to the New Relic APIs. `AiWorkflowRun` now carries `token_reconciliation_delta` and a `total_tokens` summed from each subagent's latest turn for runs observed live. Local tier files now file `AiAuditEvent` and `SecurityAlert` events under their real day instead of a 1970 file.
