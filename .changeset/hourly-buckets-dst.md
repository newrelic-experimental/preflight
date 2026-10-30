---
'@newrelic/preflight': patch
---

**Activity today charts label the right hour on daylight saving days.** The spend, tool call, and concurrent session charts assumed a 24-hour day, so after the clock change events landed one hour early or late and the last hour spilled into the next day. They now bucket by local clock hour.
