---
'@newrelic/preflight': minor
---

**Experimental: an index of the HTML reports your agent writes, served by the dashboard API.** With `experimentalArtifacts` on (config file, or `NEW_RELIC_AI_EXPERIMENTAL_ARTIFACTS=true`), `GET /api/artifacts` lists every `.html` file written with Write or Edit that still exists on disk. Files inside a git repo are grouped under that repo, with worktrees folded together. Other files are grouped by folder. `GET /api/artifacts/view?path=` serves a listed report in a sandboxed origin, so its scripts cannot read the dashboard API. Only files the index already lists can be opened. Off by default, and `highSecurity=true` forces it off.
