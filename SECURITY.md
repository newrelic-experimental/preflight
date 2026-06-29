# Security Guidelines — NR AI Coding Observability: Preflight

This document captures the security practices and invariants baked into this codebase. Use it as a reference when writing new code and as a checklist during code review.

---

## Quick Reference for Code Review

- [ ] External string values (accountId, tool names) validated/sanitized before use
- [ ] `envInt` callers pass explicit `{ min, max }` bounds
- [ ] All redaction patterns applied before content reaches logs or NR events
- [ ] License key and accountId absent from all logger calls
- [ ] New storage directories created with `{ mode: 0o700 }`, files with `0o600`
- [ ] File paths from user-controlled config validated (`.json` extension at minimum)
- [ ] New `HttpUpstream` URLs rejected if scheme is not `http:`/`https:`, or host is RFC-1918/loopback
- [ ] Subprocess commands validated as absolute paths; dangerous env keys stripped
- [ ] `MetricAggregator.record()` only called with values known to be finite
- [ ] High security mode respected: never bypass `recordContent=false` when `highSecurity=true`
- [ ] Event listeners on long-lived streams use `once` + `removeAllListeners()` after terminal events
- [ ] Error responses to HTTP clients contain only a generic code — detail goes to the logger
- [ ] `randomUUID()` from `node:crypto` used for all IDs (not `Math.random()`)

---

## Input Validation

### Account ID — `src/shared/config.ts`, `src/config.ts`

`accountId` is interpolated into New Relic API URLs. Both config loaders validate it at startup before any use:

```typescript
if (accountId !== null && !/^\d{1,12}$/.test(accountId)) {
  throw new Error('NEW_RELIC_ACCOUNT_ID must be 1–12 decimal digits');
}
```

When adding a new field that goes into a URL path, validate it at config-load time the same way — not at request time.

### Integer environment variables — `envInt()`

`envInt` accepts an optional `{ min?, max? }` bounds argument that clamps the parsed value. Every caller must document its bounds:

```typescript
// Good — bounds prevent nonsensical or unsafe values
envInt('NEW_RELIC_AI_CONTENT_MAX_LENGTH', 4096, { min: 1, max: 1_048_576 });
envInt('NEW_RELIC_AI_MCP_PORT', 9847, { min: 1, max: 65535 });
envInt('NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS', 5000, { min: 100, max: 3_600_000 });

// Bad — unbounded; a value of 0 or -1 could cause setInterval to fire at max rate
envInt('NEW_RELIC_AI_SOME_INTERVAL', 5000);
```

### Token counts — `safeInt()` in `src/shared/tokens.ts`

SDK responses occasionally contain unexpected values. `safeInt` enforces finite, non-negative, integer semantics:

```typescript
function safeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}
```

Use `safeInt` anywhere you extract a numeric count from an untrusted API response.

### Tool names

Tool names come from caller-supplied arrays and are stored in NR events. They must be sanitized:

```typescript
function sanitizeToolName(name: unknown): string {
  return String(name ?? '')
    .slice(0, 256)
    .replace(/[\x00-\x1f]/g, '');
}
```

Apply the same pattern to any user-supplied string that becomes a NR event field.

---

## Secret Redaction

### `DEFAULT_REDACTION_PATTERNS` — `src/config.ts`

A set of compiled regular expressions that cover:

| Pattern                                                                        | What it catches                           |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| `API_KEY=`, `SECRET=`, `TOKEN=`, `PASSWORD=`, `PASSPHRASE=`, `PRIVATE_KEY=`, … | Key-value secret assignments              |
| `sk-`, `ghp_`, `gho_`, `github_pat_`, `Bearer …`                               | Common API token prefixes                 |
| `-----BEGIN … -----END-----`                                                   | PEM-encoded private keys and certificates |
| `AKIA[0-9A-Z]{16}`                                                             | AWS access key IDs                        |
| `AIzaSy…`                                                                      | Google API keys                           |
| `eyJ…` (three-part)                                                            | JWT tokens                                |
| `npm_…`                                                                        | npm auth tokens                           |
| `xox[a-z]-…`                                                                   | All Slack token types                     |

**Where applied:**

- `collector-script.ts` — redacts tool input/output before writing to the hook buffer
- `src/config.ts` — `redactSensitive()` for config-level redaction

**Rule:** Any string that might contain secrets and is heading to a log or NR event must pass through these patterns first. Use `redact(text, config.redactionPatterns)` (agent) or `redactSensitive(text)` (MCP server).

### Credentials in logs

License key and account ID must never appear in logger calls. The debug config log in both `config.ts` files deliberately omits these fields. If you add a new config field that is sensitive, exclude it from logging the same way.

---

## File System Safety

### Storage permissions

All directories and files created under `~/.newrelic-preflight/` use restrictive permissions so other users on the same machine cannot read session data or tool call history:

```typescript
// Directories
mkdirSync(dir, { recursive: true, mode: 0o700 });

// Files
openSync(path, O_WRONLY | O_CREAT | O_APPEND, 0o600);
```

Follow this pattern for any new storage paths the MCP server creates.

### Custom pricing file path — `src/shared/pricing.ts`

`loadCustomPricing` validates that the caller-supplied path ends with `.json` before reading, preventing accidental (or deliberate) reads of arbitrary files via the `NEW_RELIC_AI_CUSTOM_PRICING_FILE` env var or config file. If you add other user-configurable file paths, apply at minimum an extension check and preferably a directory containment check with `path.resolve()`.

---

## Network Security

### SSRF protection — `src/security/ssrf.ts`

`validateSsrfUrl()` validates any user-configured URL against two criteria:

1. **Scheme** — only `http:` and `https:` are allowed
2. **Host** — RFC-1918 addresses (`10.*`, `172.16–31.*`, `192.168.*`), loopback (`127.*`, `::1`, `localhost`), and link-local (`169.254.*`) are rejected

```typescript
if (!ALLOWED_SCHEMES.has(this.url.protocol)) throw new Error('…scheme not allowed');
if (BLOCKED_HOST_RE.test(this.url.hostname)) throw new Error('…private addresses not allowed');
```

This is used by both `HttpUpstream` (MCP proxy forwarding) and `OtlpReceiver` (`otlpForwardEndpoint` config). Any new network client that takes a URL from config or user input should call `validateSsrfUrl()` at construction time.

### Proxy body limits — `proxy-manager.ts`

`readBody()` enforces:

- **30-second timeout** — prevents slow-loris resource exhaustion
- **10 MB body limit** — prevents unbounded heap growth from large request bodies

If you add a new HTTP ingestion path, reuse `readBody()` rather than reading raw chunks yourself.

### SSE detection — `upstream-http.ts`

Use proper media-type parsing — not substring matching — to detect Server-Sent Events:

```typescript
// Good — parses media type correctly
const mediaType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
const isStreaming = mediaType === 'text/event-stream';

// Bad — matches the substring anywhere in the header, including in parameter values
const isStreaming = (res.headers['content-type'] ?? '').includes('text/event-stream');
```

### Error responses

HTTP error responses must not echo back the request URL, upstream server name, or any internal routing detail. Log the detail server-side; send only a generic code to the client:

```typescript
// Good
logger.warn('Proxy route not found', { url });
res.end(JSON.stringify({ error: 'not_found' }));

// Bad — discloses internal routing structure
res.end(JSON.stringify({ error: 'not_found', message: `No route for ${url}` }));
```

---

## Process Execution Safety

### `StdioUpstream` — `src/proxy/upstream-stdio.ts`

When spawning an upstream MCP server as a child process, two invariants must hold:

1. **Absolute command path** — the `command` field must be an absolute filesystem path (begins with `/`). Relative or bare names allow PATH hijacking.

2. **Dangerous env keys stripped** — the following keys are removed from the child environment regardless of what the config file supplies:

   | Key                     | Risk                                     |
   | ----------------------- | ---------------------------------------- |
   | `LD_PRELOAD`            | Linux: preload attacker shared library   |
   | `LD_LIBRARY_PATH`       | Linux: redirect dynamic linker           |
   | `DYLD_INSERT_LIBRARIES` | macOS: same as `LD_PRELOAD`              |
   | `DYLD_LIBRARY_PATH`     | macOS: redirect dynamic linker           |
   | `NODE_OPTIONS`          | Inject Node.js flags (e.g., `--require`) |

   Note: `PATH` is intentionally **not** stripped. `StdioClientTransport` (MCP SDK) spreads `getDefaultEnvironment()` before applying the caller-supplied env, so stripping `PATH` from config input has no effect — it would always flow through anyway. PATH-based hijacking is prevented instead by the absolute-path requirement in invariant 1.

If you add a new subprocess invocation anywhere in the codebase, apply both checks.

---

## Telemetry Data Safety

For the full inventory of what fields are sent to New Relic, who can query them, and privacy-relevant configuration settings, see [PRIVACY.md](./PRIVACY.md).

### Metric values — `src/shared/harvest/metric-aggregator.ts`

`MetricAggregator.record()` rejects non-finite values before they can corrupt metric buckets:

```typescript
if (!Number.isFinite(value)) {
  logger.warn('MetricAggregator.record: non-finite value ignored', { name, value });
  return;
}
```

Always ensure any numeric value coming from an external SDK response passes through `safeInt` (for integers) or an explicit `Number.isFinite` check (for floats) before being recorded.

### High security mode

When `highSecurity=true`, `recordContent` is forced to `false` regardless of any other setting. This invariant is enforced in both config loaders and must never be bypassed. The purpose is to guarantee that prompt text, tool output, and response content is never sent to New Relic even if an administrator misconfigures the system. See [PRIVACY.md → `highSecurity`](./PRIVACY.md#highsecurity--forces-content-recording-off) for the privacy use case.

### Config immutability

Both `AgentConfig` and `McpServerConfig` are frozen with `Object.freeze()` immediately after construction. Do not add mutable fields to these types.

---

## Audit Trail

`AuditTrailManager` (`src/security/audit-trail.ts`) classifies every tool call and flags:

- **Sensitive file access** — `.env`, `.pem`, `.key`, credential and password files — severity: `high`
- **Destructive commands** — `rm -rf`, `DROP TABLE`, pipe-to-shell patterns — severity: `critical`
- **External network requests** — `curl`, `wget`, `fetch` — severity: `medium`

Records are persisted to disk in real time via `LocalStore.appendAuditLog()`, so the trail survives unclean shutdowns.

Classification patterns are configurable via constructor options. The log is queryable via `getSensitiveAccessLog()` and is also sent as NR events for dashboarding.

---

## Memory Safety

### Hook event processor — `src/hooks/event-processor.ts`

The `pending` map (pre-events awaiting their post-event pair) is capped at 2,000 entries. When the cap is reached, the oldest entry is evicted before inserting the new one. This prevents an unbounded heap growth if the buffer file is flooded with unpaired pre-events.

### Stream listener cleanup

`wrapStream` uses `once` (not `on`) for the `finalMessage` and `error` events, and calls `removeAllListeners()` after emitting the record. This releases the closure references held by all three event listeners so the stream object can be garbage collected promptly after completion.

Apply the same pattern to any new `EventEmitter`-based stream wrappers: `once` for terminal events + `removeAllListeners()` in the handler.

---

## Logger Safety

The logger (`src/shared/logger.ts`) writes structured JSON to **stderr**. Two invariants:

1. **Circular reference guard** — `JSON.stringify` is wrapped in a try/catch. If serialization fails, the fallback logs only the known-safe scalar fields (`timestamp`, `level`, `component`, `message`) with `data: '[unserializable]'`. This ensures the logger itself cannot throw.

2. **stderr only** — Never write to stdout. The MCP stdio transport uses stdout exclusively for JSON-RPC messages; any stray bytes will corrupt the protocol stream.

---

## Cryptography

All session and request IDs are generated with `randomUUID()` from `node:crypto`. Do not use `Math.random()` or any non-cryptographic source for IDs.
