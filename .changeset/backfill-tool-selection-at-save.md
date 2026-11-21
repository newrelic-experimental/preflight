---
'@newrelic/preflight': patch
---

The tool selection score saved with each session now attributes more calls to the subagent that made them. Preflight re-runs the subagent lookup when it saves the summary, so parallel subagents reading the same file are no longer counted as one agent re-reading it.
