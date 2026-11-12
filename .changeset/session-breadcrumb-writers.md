---
'@newrelic/preflight': minor
---

Custom platform adapters can set the new optional `capabilities.sessionBreadcrumbWriters` to
name the engines whose hook breadcrumbs their MCP server may take its session id from, so
Preflight attributes cost to the right session. Left out, it is the adapter's own
`platformName` and then `UNATTRIBUTED_BREADCRUMB_WRITER`, the writer of a hook command that
names no engine, which is now exported.
