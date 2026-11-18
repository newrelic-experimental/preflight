---
'@newrelic/preflight': patch
---

A session resumed after Preflight saved it as completed no longer shows **Status: Completed** in Sessions while it keeps running. A later in-progress save with newer activity now replaces the completed outcome. A restart with no new activity still leaves the session completed.
