---
'@newrelic/preflight': patch
---

**An engine that exits soon after guessing its session from the working directory keeps the session's earlier cost.** A Claude Code engine that took its session from the working directory's breadcrumb waits up to two minutes for its parent's breadcrumb to confirm the guess before it counts the session's saved cost. If it stopped within that window, its exit save merged its own totals with the session file by taking the larger of each, so the smaller side was lost. For example, a token report saved before the guess and one drained after it saved one report's tokens instead of two. Activity it drained for that session before the guess, such as a subagent turn, was not saved at all. The exit save now does what a confirmation does first: it saves that earlier activity and adds the file's totals to its own. An engine still unconfirmed after the two minutes saves as before.
