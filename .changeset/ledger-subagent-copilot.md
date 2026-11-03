---
'@newrelic/preflight': patch
---

**Subagent and Copilot cost no longer double counts after a restart.** A restarted Preflight billed subagent turns again when it re-read a subagent transcript: after a restart between two lines of one message, after a repo rename moved the transcript, or after a crash tore the read-position file. Copilot sessions billed their requests again when a crash left the read-position file empty or truncated. Subagent turns and Copilot requests now go through the same billed-turn ledger as main-session turns, so each is billed once. A turn whose buffer write fails, for example on a full disk, is retried on the next poll instead of being lost.
