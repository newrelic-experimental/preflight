---
'@newrelic/preflight': patch
---

**A session's saved cost no longer grows by its size-based estimates when an aggregator restarts mid-session.** When a session file held a byte-estimate ledger and a restarted `--local` or unscoped engine recorded subagent spend for it, the ledger was counted twice in the saved total and in the per-day costs. The restart baseline now starts from the file's exact cost, so the ledger is added once, even when the file carries a stale-low `exactTotals` from an older build.
