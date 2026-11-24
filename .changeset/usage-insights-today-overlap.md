---
'@newrelic/preflight': patch
---

Today's "Where today's spend went" panel no longer shows "No sessions in this window." just after midnight while sessions are still active. It now counts every session that overlaps today, and each one contributes only its share of today's spend and tokens instead of its lifetime totals. A session with no recorded cost still counts, with its tokens pro-rated by its share of today. The 7, 30, and 90 day windows are unchanged.
