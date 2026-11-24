---
'@newrelic/preflight': patch
---

**Other web pages can no longer change the local dashboard's state.** A page open in your browser could send the dashboard a `POST` with no body, such as `/api/digest/send`, which needs no CORS preflight. It could not read the answer, but the route still ran, so it could send your weekly digest to the configured webhook. A sandboxed page with a `null` origin could do the same. The dashboard now answers 403 to any request other than `GET` that the browser marks as coming from another site, from a `null` origin, or from an origin other than the dashboard's own. The dashboard's own pages and clients that send no `Origin` header, such as `curl`, work as before.
