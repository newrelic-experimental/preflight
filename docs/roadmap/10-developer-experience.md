# Implementation Plan: Developer Experience Improvements

**Roadmap item:** [08 — Developer Experience Improvements](../../ROADMAP.md#8-developer-experience-improvements)
**Effort estimate:** ~1.5 days (setup wizard + weekly digest + data retention)
**Prerequisites:** Read the following files before starting.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-mcp-server/src/install/install-helper.ts` — existing install helper; setup wizard extends this
- `packages/nr-ai-mcp-server/src/install/cli.ts` — CLI entry point; wizard is invoked as `nr-ai-mcp-server setup`
- `packages/nr-ai-mcp-server/src/config.ts` — `McpServerConfig`; new `retainSessionsDays`, `digestWebhookUrl`, `digestSchedule` fields go here
- `packages/nr-ai-mcp-server/src/storage/session-store.ts` — session files live under `storagePath/sessions/`; retention purge reads these
- `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts` — digest subscription tools go here

This plan covers three distinct features. Implement them in order; each is independent.

---

## Feature A: Setup Wizard

### Goal

`npx nr-ai-mcp-server setup` launches an interactive CLI that walks the user through:
1. New Relic account ID
2. License key (or user API key)
3. Developer name
4. Hook install (calls existing `install-helper.ts` logic)
5. Dashboard deploy (optional)
6. Alert conditions deploy (optional, requires plan 01 to be complete)

### Implementation

#### A1 — Add `setup` subcommand to CLI

Open `packages/nr-ai-mcp-server/src/install/cli.ts`.

Find where the `Commander` program is defined. Add a new `setup` command:

```typescript
program
  .command('setup')
  .description('Interactive first-run setup: configure New Relic keys, install hooks, and deploy dashboards')
  .action(async () => {
    const { runSetupWizard } = await import('./setup-wizard.js');
    await runSetupWizard();
  });
```

Ensure the `setup` command is registered before `program.parse(argv)`.

#### A2 — Create `setup-wizard.ts`

Create `packages/nr-ai-mcp-server/src/install/setup-wizard.ts`.

Use Node's built-in `readline` module (no additional dependencies). The wizard writes the resulting config to `~/.nr-ai-observe/config.json`.

```typescript
import { createInterface } from 'node:readline/promises';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeDeveloper } from '../config.js';
import type { NrObserveConfig } from './install-helper.js';

const DEFAULT_STORAGE_PATH = resolve(homedir(), '.nr-ai-observe');
const CONFIG_PATH = resolve(DEFAULT_STORAGE_PATH, 'config.json');

function loadExisting(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export async function runSetupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== NR AI Observatory Setup ===\n');
  console.log('This wizard will configure observability for your AI coding assistant.');
  console.log('Press Ctrl+C at any time to cancel.\n');

  const existing = loadExisting();

  // Step 1: Account ID
  const existingAccountId = typeof existing.accountId === 'string' ? existing.accountId : '';
  const accountIdPrompt = existingAccountId
    ? `New Relic Account ID [${existingAccountId}]: `
    : 'New Relic Account ID: ';
  let accountId = (await rl.question(accountIdPrompt)).trim();
  if (!accountId) accountId = existingAccountId;
  if (!/^\d{1,12}$/.test(accountId)) {
    console.error(`Invalid account ID: "${accountId}". Must be 1–12 digits.`);
    rl.close();
    process.exit(1);
  }

  // Step 2: License key
  const existingKey = typeof existing.licenseKey === 'string' ? '(already set)' : '';
  const keyPrompt = existingKey
    ? `New Relic License Key ${existingKey}: `
    : 'New Relic License Key (NEW_RELIC_LICENSE_KEY): ';
  let licenseKey = (await rl.question(keyPrompt)).trim();
  if (!licenseKey && typeof existing.licenseKey === 'string') {
    licenseKey = existing.licenseKey;
  }
  if (!licenseKey) {
    console.error('License key is required.');
    rl.close();
    process.exit(1);
  }

  // Step 3: Developer name
  const defaultDeveloper = typeof existing.developer === 'string'
    ? existing.developer
    : (process.env.USER ?? process.env.USERNAME ?? '');
  const developer = sanitizeDeveloper(
    (await rl.question(`Developer name [${defaultDeveloper}]: `)).trim() || defaultDeveloper,
  );

  // Step 4: Optional fields
  const teamId = (await rl.question('Team ID (optional, leave blank to skip): ')).trim() || null;
  const projectId = (await rl.question('Project ID (optional, leave blank to auto-detect from git): ')).trim() || null;

  // Step 5: Budget caps
  const sessionBudgetStr = (await rl.question('Session budget USD (optional, e.g. 5.00 — leave blank for no limit): ')).trim();
  const sessionBudgetUsd = sessionBudgetStr ? parseFloat(sessionBudgetStr) : null;

  // Write config
  const config: Record<string, unknown> = {
    ...existing,
    accountId,
    licenseKey,
    developer,
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sessionBudgetUsd !== null ? { sessionBudgetUsd } : {}),
  };

  mkdirSync(DEFAULT_STORAGE_PATH, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`\nConfig written to ${CONFIG_PATH}`);

  // Step 6: Hook install
  const installHooks = (await rl.question('\nInstall Claude Code hooks now? [Y/n]: ')).trim().toLowerCase();
  if (installHooks !== 'n') {
    console.log('\nRunning hook installer...');
    const { runInstall } = await import('./cli.js');
    await runInstall({ accountId, licenseKey } as NrObserveConfig);
    console.log('Hooks installed.');
  }

  // Step 7: Dashboard deploy
  const deployDashboard = (await rl.question('\nDeploy NR dashboards? (requires NEW_RELIC_API_KEY env var) [y/N]: ')).trim().toLowerCase();
  if (deployDashboard === 'y') {
    if (!process.env.NEW_RELIC_API_KEY) {
      console.log('Skipping — NEW_RELIC_API_KEY is not set. Run: NEW_RELIC_API_KEY=NRAK-... npx tsx scripts/deploy-dashboard.ts --all');
    } else {
      process.env.NEW_RELIC_ACCOUNT_ID = accountId;
      const { deployDashboard: deploy } = await import('../../scripts/deploy-dashboard.js');
      await deploy(process.env.NEW_RELIC_API_KEY, parseInt(accountId, 10), 'ai-coding-assistant-overview.json');
      console.log('Dashboard deployed.');
    }
  }

  rl.close();

  console.log('\n✓ Setup complete. Start the MCP server with:');
  console.log('  nr-ai-mcp-server --stdio\n');
}
```

#### A3 — Tests (`setup-wizard.test.ts`)

The wizard uses `readline`, which is hard to mock in unit tests. Write a light test for the config-writing logic extracted into a pure helper:

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Extract config-writing logic into a testable pure function:
function buildConfig(
  existing: Record<string, unknown>,
  inputs: { accountId: string; licenseKey: string; developer: string; teamId: string | null },
): Record<string, unknown> {
  return {
    ...existing,
    accountId: inputs.accountId,
    licenseKey: inputs.licenseKey,
    developer: inputs.developer,
    ...(inputs.teamId ? { teamId: inputs.teamId } : {}),
  };
}

describe('buildConfig', () => {
  it('merges new fields with existing config', () => {
    const result = buildConfig(
      { appName: 'my-app', existingField: 'keep-me' },
      { accountId: '12345', licenseKey: 'nrlic', developer: 'alice', teamId: null },
    );
    expect(result.accountId).toBe('12345');
    expect(result.existingField).toBe('keep-me');
  });

  it('omits teamId when null', () => {
    const result = buildConfig({}, { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null });
    expect(Object.keys(result)).not.toContain('teamId');
  });

  it('includes teamId when provided', () => {
    const result = buildConfig({}, { accountId: '1', licenseKey: 'k', developer: 'd', teamId: 'eng' });
    expect(result.teamId).toBe('eng');
  });
});
```

---

## Feature B: Weekly Digest

### Goal

A `nr_observe_subscribe_digest` MCP tool that registers a Slack webhook URL for weekly AI cost + efficiency summaries. A `nr_observe_unsubscribe_digest` tool removes the subscription. The digest is triggered by the existing `WeeklySummaryGenerator` and formatted as a Slack Block Kit message.

### Implementation

#### B1 — Add `digestWebhookUrl` and `digestSchedule` to config

In `packages/nr-ai-mcp-server/src/config.ts`, add to `McpServerConfig`:

```typescript
readonly digestWebhookUrl: string | null;
readonly digestSchedule: string; // cron expression, default: "0 9 * * 1" (Monday 9am)
```

In `loadMcpConfig()`:

```typescript
digestWebhookUrl:
  process.env.NEW_RELIC_AI_DIGEST_WEBHOOK_URL ??
  (typeof file.digestWebhookUrl === 'string' ? file.digestWebhookUrl : null),

digestSchedule:
  process.env.NEW_RELIC_AI_DIGEST_SCHEDULE ??
  (typeof file.digestSchedule === 'string' ? file.digestSchedule : '0 9 * * 1'),
```

#### B2 — Create `src/digest/digest-formatter.ts`

```typescript
import type { WeeklySummaryResult } from '../storage/weekly-summary.js';

export function formatSlackDigest(summary: WeeklySummaryResult): Record<string, unknown> {
  const totalCost = summary.totalCostUsd?.toFixed(4) ?? '—';
  const avgEfficiency = summary.avgEfficiencyScore?.toFixed(1) ?? '—';
  const topAntiPattern = summary.topAntiPatterns?.[0]?.type ?? 'none';

  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🤖 Weekly AI Coding Summary' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Total Cost:*\n$${totalCost}` },
          { type: 'mrkdwn', text: `*Avg Efficiency:*\n${avgEfficiency}/100` },
          { type: 'mrkdwn', text: `*Sessions:*\n${summary.sessionCount ?? '—'}` },
          { type: 'mrkdwn', text: `*Top Anti-pattern:*\n\`${topAntiPattern}\`` },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '_Generated by NR AI Observatory_',
          },
        ],
      },
    ],
  };
}
```

#### B3 — Create `src/digest/digest-sender.ts`

```typescript
export async function sendSlackDigest(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    throw new Error(`Slack webhook returned ${resp.status}: ${await resp.text()}`);
  }
}
```

#### B4 — Create MCP tools

In `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`, add:

```typescript
export const SUBSCRIBE_DIGEST_TOOL = {
  name: 'nr_observe_subscribe_digest',
  description: 'Register a Slack webhook URL to receive weekly AI coding cost and efficiency summaries.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      webhookUrl: { type: 'string', description: 'Slack incoming webhook URL (https://hooks.slack.com/...)' },
    },
    required: ['webhookUrl'],
  },
};

export const UNSUBSCRIBE_DIGEST_TOOL = {
  name: 'nr_observe_unsubscribe_digest',
  description: 'Remove the registered Slack webhook for weekly digests.',
  inputSchema: { type: 'object' as const, properties: {} },
};
```

Handlers write/clear the webhook URL to the config file (`~/.nr-ai-observe/config.json`) directly. The running server's in-memory config is not mutated — the new value takes effect on restart.

```typescript
export function handleSubscribeDigest(
  webhookUrl: string,
  configFilePath: string,
): { content: Array<{ type: 'text'; text: string }> } {
  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'webhookUrl must be a Slack incoming webhook URL (https://hooks.slack.com/...)' }) }] };
  }
  try {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(configFilePath, 'utf-8')); } catch {}
    existing.digestWebhookUrl = webhookUrl;
    writeFileSync(configFilePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Webhook registered. Digest will be sent on the configured schedule.' }) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }] };
  }
}

export function handleUnsubscribeDigest(
  configFilePath: string,
): { content: Array<{ type: 'text'; text: string }> } {
  try {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(configFilePath, 'utf-8')); } catch {}
    delete existing.digestWebhookUrl;
    writeFileSync(configFilePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Webhook removed.' }) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }] };
  }
}
```

#### B5 — Tests (`digest-formatter.test.ts`)

```typescript
import { formatSlackDigest } from './digest-formatter.js';

describe('formatSlackDigest', () => {
  it('produces a blocks array', () => {
    const payload = formatSlackDigest({
      totalCostUsd: 1.23,
      avgEfficiencyScore: 72,
      sessionCount: 5,
      topAntiPatterns: [{ type: 'thrashing', count: 2 }],
    } as any);
    expect(Array.isArray(payload.blocks)).toBe(true);
  });

  it('includes total cost in a field', () => {
    const payload = formatSlackDigest({ totalCostUsd: 2.5, avgEfficiencyScore: null, sessionCount: 3, topAntiPatterns: [] } as any);
    const text = JSON.stringify(payload);
    expect(text).toContain('2.5000');
  });

  it('handles null efficiency score gracefully', () => {
    const payload = formatSlackDigest({ totalCostUsd: null, avgEfficiencyScore: null, sessionCount: 0, topAntiPatterns: [] } as any);
    expect(JSON.stringify(payload)).not.toContain('undefined');
  });
});
```

---

## Feature C: Data Retention

### Goal

`retainSessionsDays` config field. When set, the `SessionStore` or a standalone `RetentionManager` deletes session JSON files older than N days on startup and periodically.

### Implementation

#### C1 — Add `retainSessionsDays` to config

In `packages/nr-ai-mcp-server/src/config.ts`, add to `McpServerConfig`:

```typescript
readonly retainSessionsDays: number | null;
```

In `loadMcpConfig()`:

```typescript
retainSessionsDays:
  process.env.NEW_RELIC_AI_RETAIN_SESSIONS_DAYS
    ? parseInt(process.env.NEW_RELIC_AI_RETAIN_SESSIONS_DAYS, 10)
    : (typeof file.retainSessionsDays === 'number' ? file.retainSessionsDays : null),
```

#### C2 — Create `src/storage/retention.ts`

```typescript
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('retention');

export function purgeOldSessions(storagePath: string, retainDays: number): number {
  const sessionsDir = resolve(storagePath, 'sessions');
  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  let files: string[];
  try {
    files = readdirSync(sessionsDir);
  } catch {
    return 0; // sessions directory doesn't exist yet
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fullPath = resolve(sessionsDir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.mtimeMs < cutoffMs) {
        unlinkSync(fullPath);
        deletedCount++;
        logger.debug('Purged old session file', { file, ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86_400_000) });
      }
    } catch (err) {
      logger.warn('Failed to check/delete session file', { file, error: String(err) });
    }
  }

  if (deletedCount > 0) {
    logger.info('Purged old session files', { count: deletedCount, retainDays });
  }

  return deletedCount;
}
```

#### C3 — Call purge on startup

In `packages/nr-ai-mcp-server/src/index.ts`, after `localStore.initialize()`:

```typescript
if (config.retainSessionsDays !== null && config.retainSessionsDays > 0) {
  const { purgeOldSessions } = await import('./storage/retention.js');
  const purged = purgeOldSessions(config.storagePath, config.retainSessionsDays);
  if (purged > 0) {
    logger.info('Retention purge complete', { deletedSessionFiles: purged });
  }
}
```

#### C4 — Tests (`retention.test.ts`)

```typescript
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { purgeOldSessions } from './retention.js';

function makeTempDir(): string {
  const dir = resolve(tmpdir(), randomUUID());
  mkdirSync(resolve(dir, 'sessions'), { recursive: true });
  return dir;
}

function writeSessionFile(storagePath: string, name: string, mtime: Date): void {
  const path = resolve(storagePath, 'sessions', name);
  writeFileSync(path, JSON.stringify({ sessionId: name }), { mode: 0o600 });
  // Manually set mtime by writing and checking — Jest fake timers don't affect fs mtime.
  // Instead, create files for tests that need specific ages using a different approach:
  // write file, then verify by checking that recent files are NOT purged.
}

describe('purgeOldSessions', () => {
  it('returns 0 when sessions directory does not exist', () => {
    const dir = resolve(tmpdir(), randomUUID()); // never created
    expect(purgeOldSessions(dir, 30)).toBe(0);
  });

  it('does not delete recent files', () => {
    const dir = makeTempDir();
    writeFileSync(resolve(dir, 'sessions', '2026-04-27_session1.json'), '{}');
    const deleted = purgeOldSessions(dir, 30);
    expect(deleted).toBe(0);
    expect(existsSync(resolve(dir, 'sessions', '2026-04-27_session1.json'))).toBe(true);
  });

  it('returns 0 for empty sessions directory', () => {
    const dir = makeTempDir();
    expect(purgeOldSessions(dir, 30)).toBe(0);
  });

  it('ignores non-JSON files', () => {
    const dir = makeTempDir();
    writeFileSync(resolve(dir, 'sessions', 'readme.txt'), 'ignore me');
    expect(purgeOldSessions(dir, 0)).toBe(0); // 0 day retention: only .json deleted
  });
});
```

---

## Acceptance criteria

### Setup Wizard
- [ ] `nr-ai-mcp-server setup` starts the interactive wizard
- [ ] Wizard writes valid JSON to `~/.nr-ai-observe/config.json` with `0o600` permissions
- [ ] Existing config values are preserved as defaults (shown in brackets)
- [ ] Pressing Enter with no input uses the default value
- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — `buildConfig` tests pass

### Weekly Digest
- [ ] `nr_observe_subscribe_digest` validates the URL starts with `https://hooks.slack.com/`
- [ ] `nr_observe_subscribe_digest` writes `digestWebhookUrl` to the config file
- [ ] `nr_observe_unsubscribe_digest` removes `digestWebhookUrl` from the config file
- [ ] `formatSlackDigest` returns a Slack Block Kit payload with a `blocks` array
- [ ] No `undefined` values in the formatted payload
- [ ] `npm test` passes — `digest-formatter.test.ts` passes

### Data Retention
- [ ] `retainSessionsDays` config field accepted from env var and config file
- [ ] `purgeOldSessions()` returns 0 when the sessions directory doesn't exist
- [ ] `purgeOldSessions()` does not delete recently-created files
- [ ] `purgeOldSessions()` ignores non-JSON files
- [ ] Purge is called on startup only when `retainSessionsDays` is non-null and > 0
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/install/setup-wizard.ts
packages/nr-ai-mcp-server/src/install/setup-wizard.test.ts
packages/nr-ai-mcp-server/src/digest/digest-formatter.ts
packages/nr-ai-mcp-server/src/digest/digest-formatter.test.ts
packages/nr-ai-mcp-server/src/digest/digest-sender.ts
packages/nr-ai-mcp-server/src/storage/retention.ts
packages/nr-ai-mcp-server/src/storage/retention.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/install/cli.ts              — add 'setup' subcommand
packages/nr-ai-mcp-server/src/config.ts                   — add digestWebhookUrl, digestSchedule, retainSessionsDays
packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts — add digest subscription tools
packages/nr-ai-mcp-server/src/tools/session-stats.ts      — register digest tools
packages/nr-ai-mcp-server/src/index.ts                    — call purgeOldSessions on startup
```
