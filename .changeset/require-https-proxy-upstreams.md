---
'@newrelic/preflight': minor
---

Proxy HTTP upstreams now require `https://` unless the host is loopback (`localhost`, `127.0.0.1`, `::1`), so MCP traffic is no longer sent in cleartext to other hosts. A private-range upstream that uses `http://` also needs the new `allowInsecureHttp: true` field, alongside `allowPrivateHosts`.

Migration: any existing `proxyUpstreams` entry with a non-loopback `http://` URL now fails at startup. Change its URL to `https://`, or, for a private-range host on a trusted network, set `allowPrivateHosts: true` and `allowInsecureHttp: true` on that entry.
