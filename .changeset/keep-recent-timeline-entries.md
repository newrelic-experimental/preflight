---
'@newrelic/preflight': patch
---

**Session timelines keep the most recent 10,000 entries everywhere.** A session that crossed the cap used to keep its first 10,000 entries in memory (the live tracker and the local session aggregator) but its last 10,000 on disk, so concurrency, the activity heatmap, and replay depended on which path produced the record. The in-memory timelines now drop the oldest entries, matching the session store.
