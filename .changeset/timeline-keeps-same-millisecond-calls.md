---
'@newrelic/preflight': patch
---

Tool calls that carry an id now keep separate timeline entries when several calls to one tool land in the same millisecond, across saves and across reloads of a saved session. Before, they collapsed into one entry, so a replayed session showed fewer calls than ran. Sessions saved before this release have no ids, so their same-millisecond calls can still collapse.
