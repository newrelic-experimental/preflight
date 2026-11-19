---
'@newrelic/preflight': patch
---

The documented hook setup for Codex, Droid, Gemini CLI, OpenCode, and Kilo Code now names the engine, so their tool-call hooks file session breadcrumbs under that engine and no longer share the `unattributed` pool with every other unstamped engine. Codex, Droid, and Gemini CLI hook commands start with `MCP_CLIENT=<engine>`, with a Windows form in the docs. The OpenCode and Kilo Code plugin snippets set `MCP_CLIENT` in the collector's spawn options. Existing installs without the stamp keep resolving through `unattributed`. Add the stamp to your hook config to stop sharing.
