---
'@newrelic/preflight': minor
---

**Tool-call events no longer carry your transcript path, and several event attributes are now correct.** `AiToolCall` stops sending `transcriptPath`, which held your home directory and so your OS username. `AiRetryAlert` now carries `event_version`. `AiContextSnapshot` is sent only by the process that owns the session, and its `session_id` is the session the snapshot was measured in, not whichever session the sending process happened to hold. A proxied tool call that fails with a non-2xx HTTP status now sets `error_type` to `http_4xx`, `http_5xx` or `http_error` on both its `AiMcpToolCall` and its `AiToolCall`. A JSON-RPC error returned with HTTP 200 still counts as a success.
