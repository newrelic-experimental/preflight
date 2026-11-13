---
'@newrelic/preflight': patch
---

`NEW_RELIC_AI_MCP_MAX_CONTENT_LENGTH` is now bounded. Before, `0` cut every captured detail to the truncation marker, and a negative value dropped the last few characters instead of limiting the length. A value below 256 now clamps up to 256, and a value above 1,048,576 clamps down to 1,048,576, the same clamping the other bounded integer settings use. A value with no leading digits, such as `abc` or an empty string, still falls back to the 10,240 default.
