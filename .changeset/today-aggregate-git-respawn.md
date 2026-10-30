---
'@newrelic/preflight': patch
---

**The local dashboard's Today view no longer re-resolves every repository's git identity on every refresh.** The Today aggregate and the Git Efficiency view now share one identity resolver instead of building a new one per request, so a machine with many repositories stops spawning several `git` processes per repository on each refresh, which showed up as CPU spikes while the dashboard was open.
