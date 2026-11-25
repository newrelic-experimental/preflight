---
'@newrelic/preflight': patch
---

**An engine whose session guess is never confirmed keeps the cost it drained for that session before the guess.** A Claude Code engine that took its session from the working directory's breadcrumb stops waiting for its parent's breadcrumb to confirm the guess after two minutes, and then saves the session's file as its own. Its saves merged its own totals with that file by taking the larger of each, so a token report saved before the guess and one drained after it saved one report's tokens instead of two. A subagent turn it drained for that session before the guess was not saved at all. Once the two minutes pass, the engine now adds what it drained for the session before the guess to its own totals, so its saves, its exit save and its budget count each report once. It still never adds the file's other cost, which may belong to another session. On native Windows the parent's breadcrumb never confirms a guess, so every such engine took this path.
