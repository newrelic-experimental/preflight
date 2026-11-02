---
'@newrelic/preflight': patch
---

**Session cost no longer double counts after a restart or in a forked session.** A restarted Preflight that re-read a transcript moved to a new project directory, for example after a repo rename, billed its earlier turns again. A session started with `claude --resume <id> --fork-session` billed again every turn it copied from its parent. Preflight now records each billed message id under `~/.newrelic-preflight/billed-turns/` and bills each turn once, to the session that first reported it. A turn whose buffer write fails, for example on a full disk, is retried on the next poll instead of being lost. Two behaviors change. A turn first seen more than `retainSessionsDays` after it happened is no longer billed. A fork of a session billed before this release can still double count that session's turns once. See docs/ARCHITECTURE.md.
