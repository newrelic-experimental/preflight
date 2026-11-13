---
'@newrelic/preflight': patch
---

The saved session timeline now keeps every tool call when several calls to one tool land in the same millisecond. Before, parallel calls collapsed into one entry on save, so a replayed session showed fewer calls than ran. Sessions saved before this change keep their old entries.
