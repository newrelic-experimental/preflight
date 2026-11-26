---
'@newrelic/preflight': patch
---

**Two engines saving one session now save the sum of their work.** Each Preflight engine used to save a session by reading its file and keeping the larger of each total. When two engines served one session at once, such as after a reload while the earlier engine was still running, each saved its own view, and one engine's work was lost. Two engines that each added $0.50 to a $1 session saved $1.50. Each engine now saves only what it counted itself, to a file of its own, and the session adds those files up, so that example saves $2. The dashboard and the session history show the summed session. A restarted engine writes a new file, and its cost tools start from the whole session.
