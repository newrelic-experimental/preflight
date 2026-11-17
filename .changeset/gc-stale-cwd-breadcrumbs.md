---
'@newrelic/preflight': patch
---

**Preflight now cleans up old working-directory session breadcrumbs.** The breadcrumb sweep only removed breadcrumbs for dead processes, so the per-directory ones, both under each assistant and in the old shared location, piled up forever. It now deletes a per-directory breadcrumb once it has sat untouched for 7 days and no recently touched process breadcrumb in the same place names its session, so a long-running session keeps resolving.
