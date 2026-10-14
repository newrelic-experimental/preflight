---
'@newrelic/preflight': patch
---

**Preflight's dependencies had known vulnerabilities, and two code paths were flagged by CodeQL.** The server's dependencies (`@modelcontextprotocol/sdk`, `undici`, `hono`, `proxy-addr`, `ip-address`, `fast-uri`, `brace-expansion`) are upgraded, which clears every open Dependabot alert. The minimum versions in `package.json` are raised so installs of Preflight resolve the patched releases. Stripping `[1m]`-style suffixes from model IDs during pricing no longer uses a backtracking regular expression, so a crafted model name can't make it run for a long time. `scripts/generate-demo-data.ts` no longer prints the request URL, which contains the account ID, in its error output.
