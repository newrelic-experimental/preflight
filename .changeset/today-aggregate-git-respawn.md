---
'@newrelic/preflight': patch
---

**The local dashboard's Today view no longer starts a `git` process for every directory on every refresh.** Directories that are not git repositories are now remembered, and the Today aggregate shares one identity resolver instead of building a new one per request. Before, a machine with many non-repo working directories re-ran `git` for each of them on every refresh, which showed up as CPU spikes while the dashboard was open.
