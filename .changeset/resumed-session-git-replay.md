---
'@newrelic/preflight': patch
---

The git activity of a session that is resumed after it completed now includes the calls made after the resume once it completes again. Before, the dashboard kept the activity from the first completion until the process restarted.
