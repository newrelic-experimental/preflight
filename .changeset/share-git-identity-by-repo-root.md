---
'@newrelic/preflight': patch
---

Git lookups for a repository are now shared across startup replay, live tool calls and the dashboard, and cached by the repository root. A session that works in many subdirectories of one repo runs git once for that repo instead of once per directory, which cuts the `--stdio` startup and dashboard git work on Windows, where each git process is slow.
