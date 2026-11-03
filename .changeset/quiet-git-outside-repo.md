---
'@newrelic/preflight': patch
---

Running a Preflight command outside a git repository (for example `preflight setup` from your home directory) no longer prints `fatal: not a git repository` to the terminal. Preflight still checks git for your project ID and repo URL, and still falls back quietly when there is no repository.
