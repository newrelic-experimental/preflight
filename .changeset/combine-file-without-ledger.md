---
'@newrelic/preflight': patch
---

**A session split across files no longer counts its byte estimates twice when one file has no ledger.** A file saved by a build from before the byte-estimate ledger holds its estimates in its totals but does not say which share they are. Combining it with a file that has a ledger read its whole total as exact cost, then added the other file's ledger on top, so a session with $1 exact and $4 estimated showed $9. The same happened to its tokens and to its estimated and unpriced call counts. A file without a ledger is now read as holding the ledger the combined record keeps, so its total is compared with the other file's whole total and the session shows $5.
