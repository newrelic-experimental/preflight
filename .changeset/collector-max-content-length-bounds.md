---
'@newrelic/preflight': patch
---

`NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH` is now bounded. A value below 256 or above 1,048,576, or one that is not a number, falls back to the 10,240 default. Before, `0` cut every captured input, output and error detail to the truncation marker, and a negative value kept the tail of the content instead of the head.
