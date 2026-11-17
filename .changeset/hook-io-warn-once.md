---
'@newrelic/preflight': patch
---

The hook collector now creates breadcrumb directories only when a write finds one missing and skips the exists check before each read. It warns about an unrecognized engine name once per storage directory, recorded in an `unknown-engine-warned` file, instead of on every hook event.
