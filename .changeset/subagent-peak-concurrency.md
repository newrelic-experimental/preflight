---
'@newrelic/preflight': minor
---

The session view now shows the peak number of subagents that ran at the same time, with the clock time it was reached, such as "Peak 9 parallel at 5:35 PM". A session with one subagent reads "Peak 1 at a time", and a session with none shows no label. The `GET /api/sessions/:sessionId/subagents` response gains a `peak` field (`{ count, atMs }`) for this. A subagent that finishes in the same instant another starts counts as overlapping with it.
