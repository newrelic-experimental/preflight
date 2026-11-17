---
'@newrelic/preflight': patch
---

A tool call whose start and finish two Preflight processes picked up, such as an engine restarting while the old one still runs, or a dashboard server draining alongside a session's engine, now counts once in the saved session instead of twice. A session's tool call count and Bash command count use each call's tool use id to skip a call another process already saved.
