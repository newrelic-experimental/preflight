---
'@newrelic/preflight': patch
---

**A server that picked another session from a shared breadcrumb now switches to its own.** A server can pick its session from a breadcrumb above its own parent process, such as one an older Preflight version left on Linux at a tmux server two sessions share. It now switches to its own session as soon as its own hooks write their breadcrumb, and that session starts from zero rather than with the other session's tasks, lines, tests, quality signals and fired budget alerts. The other session's live server keeps its heartbeat.
