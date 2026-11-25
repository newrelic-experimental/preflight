---
'@newrelic/preflight': patch
---

Proxied tool calls are now recorded as failures when the upstream answers HTTP 200 with a JSON-RPC `error` object (`error_type` `jsonrpc_error`) or with a tool result that sets `isError: true` (`error_type` `tool_error`). Before, both counted as successes. Dashboards or alerts built on `AiMcpToolCall` `success` may show more failures after this release. Only non-streaming JSON responses of up to 1 MiB are checked, so SSE responses are still recorded as successes.
