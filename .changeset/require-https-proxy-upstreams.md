---
'@newrelic/preflight': minor
---

Proxy HTTP upstreams now require `https://` unless the host is loopback (`localhost`, `127.0.0.1`, `::1`), so MCP traffic is no longer sent in cleartext to other hosts. An upstream at a private-range IP address that uses `http://` also needs the new `allowInsecureHttp: true` field, alongside `allowPrivateHosts`. Hostnames are not resolved for this check, so a LAN host given by name needs `https://` or its IP address.

Migration: any existing `proxyUpstreams` entry with a non-loopback `http://` URL is now skipped at startup with an error naming it, and listed under `skippedUpstreams` in the proxy's `/health` response, which reports `status: "degraded"` while any upstream is skipped; the other upstreams still start. If every configured upstream is rejected, the proxy refuses to start. Change its URL to `https://`, or, for a private-range IP address on a trusted network, set `allowPrivateHosts: true` and `allowInsecureHttp: true` on that entry.
