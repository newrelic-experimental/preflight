---
'@newrelic/preflight': patch
---

Setting `otlp.transport` to `otlp` or `both` now actually sends events and metrics over OTLP, as `docs/ADVANCED.md` describes. Before, the setting never reached the harvest scheduler and everything went to the New Relic APIs. For runs observed live, `AiWorkflowRun` now carries `token_reconciliation_delta`, the gap between the run's rollup tokens and the sum of each subagent's latest turn. An `otlp.endpoint` that is rejected, such as plain http to a non-loopback host, logs a warning and falls back to the New Relic APIs instead of stopping the server. Local tier files now file `AiAuditEvent` and `SecurityAlert` events under their real day instead of a 1970 file.
