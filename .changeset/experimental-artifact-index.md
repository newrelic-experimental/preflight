---
'@newrelic/preflight': minor
---

**Experimental: browse the HTML reports your agent writes, grouped by repo.** With `experimentalArtifacts` on (config file, or `NEW_RELIC_AI_EXPERIMENTAL_ARTIFACTS=true`), the local dashboard gains an Artifacts page. It lists every `.html` file written with Write or Edit that still exists on disk. Files inside a git repo are grouped under that repo, with worktrees folded together. Other files are grouped by folder. Opening a report serves it from the dashboard in a sandboxed origin, so its scripts cannot read the dashboard API. Only files the index already lists can be opened. Off by default, and `highSecurity=true` forces it off.
