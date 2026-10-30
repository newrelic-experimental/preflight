---
'@newrelic/preflight': patch
---

On platforms without exact token data (Kiro, Amazon Q), a restarted session now keeps its estimated cost and keeps estimating from tool I/O until the agent reports tokens, and is still labelled `estimated`.
