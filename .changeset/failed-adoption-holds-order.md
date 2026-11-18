---
'@newrelic/preflight': patch
---

A tool call's post no longer reaches the processor before its pre when a leftover drain claim cannot be renamed for adoption (for example EPERM or EBUSY on a locked file). The drain now holds the newer claims and the fresh buffer behind that claim, as it already does for a claim it cannot take, for up to 50 polls (about 5 seconds), so the call is counted once and pairs with its own pre.
