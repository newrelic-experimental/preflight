---
'@newrelic/preflight': patch
---

**Activity a pending server collected for other conversations is no longer lost when it finds its own session.** While a `--stdio` server waits for its session id, it collects hook events for every conversation on the machine. Before, once it found its own session, it saved only that session, and anything it had collected for other conversations since the last checkpoint was dropped. Now each conversation's collected activity is saved until a write succeeds. A failed write is retried at the next checkpoint and no longer blocks the server's own save. Saving another conversation's activity keeps that conversation's existing outcome, and a session's self-report count is kept across saves.
