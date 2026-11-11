---
'@newrelic/preflight': patch
---

A `--stdio` engine that resumes a saved session now counts that session's earlier cost exactly once in daily and weekly spend. Before, a session adopted after startup was counted twice, so budget thresholds fired early, and one picked up from a working-directory guess that was never confirmed could have its earlier cost left out, so thresholds fired late.
