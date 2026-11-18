---
'@newrelic/preflight': patch
---

A session resumed after Preflight saved it as completed no longer shows **Status: Completed** in Sessions while it keeps running. A later in-progress save now replaces the completed outcome. Restarting the dashboard server with no new activity still leaves the session completed. A resumed session reads in progress while its engine runs, even before it makes a new call, and completed again once that engine exits.
