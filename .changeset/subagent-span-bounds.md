---
'@newrelic/preflight': patch
---

**Subagent spans now cover the agent's whole run.** A span used to start at the agent's first model response and end when its final turn began streaming, so parallel agents could read as sequential, single-turn agents showed zero length, and the session's peak parallel count could read low. Spans now run from the first to the last line in the agent's transcript. Turn count, tokens and cost are unchanged.
