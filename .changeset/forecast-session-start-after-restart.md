---
'@newrelic/preflight': patch
---

The session-end cost forecast no longer spikes after a mid-session restart. A resumed session's saved cost was divided by the minutes since the restart, so a $50 session resumed 10 minutes ago forecast $2,400. The forecast now measures the session's age from its saved start time. A session resumed from more than 8 hours ago projects no further growth.
