---
'@newrelic/preflight': patch
---

A `--stdio` engine that resumes a session started before the 7-day window now counts only that session's in-window days in the weekly budget. Before, it added the session's whole saved cost, so a session from three weeks ago with $40 saved and $2 of it this week read $44 weekly after a $4 turn and fired the 50, 80 and 100% weekly alerts. It now reads $6. The daily figure and the session cost are unchanged. A saved byte estimate on an earlier day counts once in the week, and leaves it when an exact report replaces the estimates.
