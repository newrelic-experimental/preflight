# Implementation Plan: Developer Identity as Explicit Config

**Roadmap item:** [12 — Developer Identity as Explicit Config](../../ROADMAP.md#12-developer-identity-as-explicit-config)
**Effort estimate:** ~half day
**Prerequisites:** None — `developer` already exists in `McpServerConfig`; this plan hardens and surfaces it.

---

## Goal

The `developer` field is already loaded into `McpServerConfig` via `loadMcpConfig()` in `src/config.ts`, the setup wizard already prompts for it, and `inferDeveloper()` already falls back through `$USER` / `$USERNAME` / `git config user.name`. What is missing:

1. **Normalization** — `sanitizeDeveloper()` only strips control characters and trims whitespace. It does not lowercase or replace spaces, so "John Doe" and "john doe" would fail a NRQL `WHERE developer = 'john_doe'` exact-match comparison. Introduce `normalizeDeveloperName()` that produces a predictable, NRQL-safe string.
2. **Surfacing** — The resolved identity is not visible in the `nr_observe_get_session_stats` MCP tool response. A developer has no way to confirm which identity is being used for the current session without reading the raw config file.
3. **Env var documentation** — The env var `NEW_RELIC_AI_MCP_DEVELOPER` is not mentioned in `README.md` or the configuration table.

---

## Background reading

Before starting, read these files:

- `packages/nr-ai-mcp-server/src/config.ts` — `sanitizeDeveloper()`, `inferDeveloper()`, `loadMcpConfig()` — understand the existing loading chain
- `packages/nr-ai-mcp-server/src/install/setup-wizard.ts` — see how developer is prompted and saved
- `packages/nr-ai-mcp-server/src/tools/session-stats.ts` — where `nr_observe_get_session_stats` is defined and what it currently returns
- `packages/nr-ai-mcp-server/src/metrics/session-tracker.ts` — `FullSessionSummary` shape, to know what to extend

---

## Step 1 — Add `normalizeDeveloperName()` to `src/config.ts`

The normalization rules, in order:
1. Strip control characters (already done by `sanitizeDeveloper`)
2. Trim leading/trailing whitespace
3. Lowercase the whole string
4. Replace any run of whitespace or non-alphanumeric characters (except `-`) with a single `_`
5. Strip leading/trailing underscores
6. Truncate to 64 characters
7. Return `'unknown'` if the result is empty

Add the following export to `packages/nr-ai-mcp-server/src/config.ts`, **after** the existing `sanitizeDeveloper` function:

```typescript
/**
 * Produces a lowercase, NRQL-safe identifier from a raw developer name.
 * "John Doe" → "john_doe", "my.user@host" → "my_user_host"
 */
export function normalizeDeveloperName(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, '')  // strip control chars
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_')     // collapse non-alphanumeric runs to _
    .replace(/^_+|_+$/g, '')           // strip leading/trailing underscores
    .slice(0, 64)
    || 'unknown';
}
```

Then update the single call site in `loadMcpConfig()` where `developer` is assigned — change `sanitizeDeveloper(...)` to `normalizeDeveloperName(...)`:

```typescript
// Before:
developer: sanitizeDeveloper(
  process.env.NEW_RELIC_AI_MCP_DEVELOPER ??
  (typeof file.developer === 'string' ? file.developer : inferDeveloper()),
),

// After:
developer: normalizeDeveloperName(
  process.env.NEW_RELIC_AI_MCP_DEVELOPER ??
  (typeof file.developer === 'string' ? file.developer : inferDeveloper()),
),
```

Keep `sanitizeDeveloper` exported as-is — it is used by the setup wizard for display purposes and in the security code, where the looser constraint is intentional.

---

## Step 2 — Update the setup wizard to use `normalizeDeveloperName`

In `packages/nr-ai-mcp-server/src/install/setup-wizard.ts`, import `normalizeDeveloperName` alongside the existing `sanitizeDeveloper` import:

```typescript
import { sanitizeDeveloper, normalizeDeveloperName } from '../config.js';
```

Change the developer normalisation step (around line 86) to use `normalizeDeveloperName` so the value stored in the config file is already in normalised form. **Also print the normalised value back to the user** so they can see exactly what will be stored:

```typescript
// Step 3: Developer name
const defaultDeveloper = typeof existing.developer === 'string'
  ? existing.developer
  : normalizeDeveloperName(process.env.USER ?? process.env.USERNAME ?? '');
const rawInput = (await rl.question(`Developer name [${defaultDeveloper}]: `)).trim() || defaultDeveloper;
const developer = normalizeDeveloperName(rawInput);
if (developer !== rawInput) {
  print(`  → Normalized to: ${developer}`);
}
```

The `sanitizeDeveloper` import can be removed from this file if it is no longer used after this change.

---

## Step 3 — Surface developer identity in `nr_observe_get_session_stats`

The `nr_observe_get_session_stats` tool is registered in `packages/nr-ai-mcp-server/src/tools/session-stats.ts`. Locate the `registerTools` function and the handler for `nr_observe_get_session_stats`. The tool response is a JSON-serialised object.

Add `developer` (and the effective `teamId` / `projectId` if set) to the response object. The config values need to flow into `registerTools`. Inspect the existing call site in `packages/nr-ai-mcp-server/src/server.ts` to see how `registerTools` is called, then add a `identity` parameter:

### 3a — Update `registerTools` signature

In `session-stats.ts`, add an `identity` parameter to `registerTools`:

```typescript
export interface RegisterToolsIdentity {
  readonly developer: string;
  readonly teamId: string | null;
  readonly projectId: string | null;
}

export function registerTools(
  server: Server,
  trackers: { /* existing tracker params */ },
  identity: RegisterToolsIdentity,
): void {
```

### 3b — Include identity in session stats response

Inside the handler for `nr_observe_get_session_stats`, merge identity into the returned object:

```typescript
const stats = sessionTracker.getMetrics();
return {
  content: [{
    type: 'text',
    text: JSON.stringify({
      identity: {
        developer: identity.developer,
        teamId: identity.teamId,
        projectId: identity.projectId,
      },
      ...stats,
    }),
  }],
};
```

### 3c — Pass identity from `server.ts`

In `packages/nr-ai-mcp-server/src/server.ts`, where `registerTools` is called, pass in the config identity fields:

```typescript
registerTools(
  this.server,
  { /* existing trackers */ },
  {
    developer: this.config.developer,
    teamId: this.config.teamId,
    projectId: this.config.projectId,
  },
);
```

---

## Step 4 — Add `developer` to the configuration reference in `README.md`

Locate the configuration table in `README.md` (the section listing env vars and config file keys). Add a row for the developer identity:

| Config key | Env var | Default | Description |
|---|---|---|---|
| `developer` | `NEW_RELIC_AI_MCP_DEVELOPER` | `$USER` → git user.name → `unknown` | Your identifier on all NR events. Normalised to lowercase with underscores. Set this if your `$USER` differs between machines. |

---

## Step 5 — Write tests

Create `packages/nr-ai-mcp-server/src/config.test.ts` (or add to an existing config test file if one exists).

```typescript
import { normalizeDeveloperName } from './config.js';

describe('normalizeDeveloperName', () => {
  it('lowercases the input', () => {
    expect(normalizeDeveloperName('JohnDoe')).toBe('johndoe');
  });

  it('replaces spaces with underscores', () => {
    expect(normalizeDeveloperName('John Doe')).toBe('john_doe');
  });

  it('collapses multiple non-alphanumeric chars to a single underscore', () => {
    expect(normalizeDeveloperName('john.doe@example.com')).toBe('john_doe_example_com');
  });

  it('strips leading and trailing underscores', () => {
    expect(normalizeDeveloperName('  john  ')).toBe('john');
  });

  it('preserves hyphens', () => {
    expect(normalizeDeveloperName('john-doe')).toBe('john-doe');
  });

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(100);
    expect(normalizeDeveloperName(long)).toHaveLength(64);
  });

  it('returns unknown for empty or whitespace-only input', () => {
    expect(normalizeDeveloperName('')).toBe('unknown');
    expect(normalizeDeveloperName('   ')).toBe('unknown');
  });

  it('strips control characters', () => {
    expect(normalizeDeveloperName('john\x00doe')).toBe('john_doe');
  });

  it('handles $USER-style values consistently across machines', () => {
    expect(normalizeDeveloperName('cdehaan')).toBe('cdehaan');
    expect(normalizeDeveloperName('CDEHAAN')).toBe('cdehaan');
  });
});
```

---

## Acceptance criteria

- [ ] `normalizeDeveloperName('John Doe')` returns `'john_doe'`
- [ ] `normalizeDeveloperName('CDEHAAN')` returns `'cdehaan'`
- [ ] `loadMcpConfig()` uses `normalizeDeveloperName` for the `developer` field
- [ ] `runSetupWizard()` prints the normalised name back when it differs from the raw input
- [ ] `nr_observe_get_session_stats` response JSON includes `identity.developer`, `identity.teamId`, `identity.projectId`
- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — all `normalizeDeveloperName` tests pass
- [ ] `npm run lint` passes

---

## File checklist

Files to **modify**:

```
packages/nr-ai-mcp-server/src/config.ts               — add normalizeDeveloperName(), update loadMcpConfig()
packages/nr-ai-mcp-server/src/install/setup-wizard.ts  — use normalizeDeveloperName, print confirmation
packages/nr-ai-mcp-server/src/tools/session-stats.ts   — add identity param, include in stats response
packages/nr-ai-mcp-server/src/server.ts                — pass identity to registerTools()
README.md                                               — add developer env var row to config table
```

Files to **create**:

```
packages/nr-ai-mcp-server/src/config.test.ts           — normalizeDeveloperName unit tests
                                                          (or add to existing config test file if present)
```
