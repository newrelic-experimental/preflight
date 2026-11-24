---
'@newrelic/preflight': minor
---

**Experimental: an index of the HTML reports your agent writes, served by the dashboard API.** With `experimentalArtifacts` on (config file, or `NEW_RELIC_AI_EXPERIMENTAL_ARTIFACTS=true`), `GET /api/artifacts` lists the `.html` files written with Write or Edit that still exist on disk, from the newest 20,000 audit trail rows. A file whose path the audit trail redacts is not listed. Files inside a git repo are grouped under that repo, with worktrees folded together. Other files are grouped by folder. `GET /api/artifacts/view?path=` serves a listed report in a sandboxed origin, so its scripts cannot read the dashboard API. Only files the index already lists can be opened. Off by default, and `highSecurity=true` forces it off.
