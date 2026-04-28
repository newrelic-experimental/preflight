# Implementation Plan: Alert Conditions

**Roadmap item:** [03 — Alert Conditions](../../ROADMAP.md#3-alert-conditions)
**Effort estimate:** ~1 day
**Prerequisites:** Existing dashboard deploy pattern in `scripts/deploy-dashboard.ts`

---

## Goal

Ship five pre-built New Relic alert conditions alongside the dashboards. One command deploys a complete alert policy with NRQL conditions. Mirrors the dashboard UX: JSON definitions stored in source, a script injects account ID, NerdGraph does the work.

---

## Background reading

Before starting, read these files to understand existing patterns:

- `packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts` — NerdGraph mutation pattern, API key handling, CLI flags
- `packages/nr-ai-mcp-server/src/config.ts` — `McpServerConfig` shape, how `accountId` is validated
- `packages/nr-ai-mcp-server/src/dashboard.test.ts` — how dashboard JSON files are validated in tests

---

## Step 1 — Create the alert definitions directory

Create `packages/nr-ai-mcp-server/src/alerts/` and add one JSON file per alert condition.

### `packages/nr-ai-mcp-server/src/alerts/policy.json`

```json
{
  "name": "AI Coding Assistant Alerts",
  "incidentPreference": "PER_CONDITION"
}
```

### `packages/nr-ai-mcp-server/src/alerts/conditions/01-daily-cost-spike.json`

```json
{
  "name": "AI Daily Cost Spike",
  "description": "Fires when today's AI coding cost is more than 2x the 7-day rolling average.",
  "enabled": true,
  "nrqlQuery": "SELECT sum(numeric(cost.totalUsd)) FROM Metric WHERE metricName = 'ai.cost.session' SINCE 1 day ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 3600,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": 10,
    "duration": 3600,
    "occurrences": "ALL"
  },
  "violationTimeLimitSeconds": 86400
}
```

> Note: The threshold value of `10` (dollars) is a placeholder. The deploy script will warn users to adjust it. A more sophisticated version using a baseline comparison query is described in the advanced section below.

### `packages/nr-ai-mcp-server/src/alerts/conditions/02-low-efficiency-score.json`

```json
{
  "name": "AI Low Efficiency Score",
  "description": "Fires when the rolling efficiency score drops below 40 for 30+ minutes.",
  "enabled": true,
  "nrqlQuery": "SELECT average(numeric(efficiency.score)) FROM Metric WHERE metricName = 'ai.efficiency.score' SINCE 30 minutes ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 300,
  "aggregationDelay": 120,
  "thresholdOperator": "BELOW",
  "thresholdCritical": {
    "value": 40,
    "duration": 1800,
    "occurrences": "ALL"
  },
  "violationTimeLimitSeconds": 86400
}
```

### `packages/nr-ai-mcp-server/src/alerts/conditions/03-stuck-loop-rate.json`

```json
{
  "name": "AI Stuck Loop Spike",
  "description": "Fires when stuck loop anti-patterns exceed 3 occurrences in a 15-minute window.",
  "enabled": true,
  "nrqlQuery": "SELECT count(*) FROM AiAntiPattern WHERE patternType = 'stuck_loop' SINCE 15 minutes ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 300,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": 3,
    "duration": 300,
    "occurrences": "AT_LEAST_ONCE"
  },
  "violationTimeLimitSeconds": 43200
}
```

### `packages/nr-ai-mcp-server/src/alerts/conditions/04-anti-pattern-rate.json`

```json
{
  "name": "AI Anti-Pattern Rate Elevated",
  "description": "Fires when total anti-patterns exceed 10 in any 30-minute window.",
  "enabled": true,
  "nrqlQuery": "SELECT count(*) FROM AiAntiPattern SINCE 30 minutes ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 600,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": 10,
    "duration": 600,
    "occurrences": "AT_LEAST_ONCE"
  },
  "violationTimeLimitSeconds": 43200
}
```

### `packages/nr-ai-mcp-server/src/alerts/conditions/05-session-cost-budget.json`

```json
{
  "name": "AI Session Cost Over Budget",
  "description": "Fires when a single session's cost exceeds $5. Adjust threshold to match your budget.",
  "enabled": false,
  "nrqlQuery": "SELECT max(numeric(cost.sessionTotalUsd)) FROM Metric WHERE metricName = 'ai.cost.session' SINCE 1 hour ago FACET sessionId",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 300,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": 5,
    "duration": 300,
    "occurrences": "AT_LEAST_ONCE"
  },
  "violationTimeLimitSeconds": 86400
}
```

---

## Step 2 — Create the TypeScript type definitions

Create `packages/nr-ai-mcp-server/src/alerts/types.ts`:

```typescript
export interface AlertConditionDefinition {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly nrqlQuery: string;
  readonly aggregationMethod: 'EVENT_FLOW' | 'EVENT_TIMER' | 'CADENCE';
  readonly aggregationWindow: number;
  readonly aggregationDelay?: number;
  readonly aggregationTimer?: number;
  readonly thresholdOperator: 'ABOVE' | 'ABOVE_OR_EQUALS' | 'BELOW' | 'BELOW_OR_EQUALS' | 'EQUALS' | 'NOT_EQUALS';
  readonly thresholdCritical: {
    readonly value: number;
    readonly duration: number;
    readonly occurrences: 'ALL' | 'AT_LEAST_ONCE';
  };
  readonly thresholdWarning?: {
    readonly value: number;
    readonly duration: number;
    readonly occurrences: 'ALL' | 'AT_LEAST_ONCE';
  };
  readonly violationTimeLimitSeconds: number;
}

export interface AlertPolicyDefinition {
  readonly name: string;
  readonly incidentPreference: 'PER_POLICY' | 'PER_CONDITION' | 'PER_CONDITION_AND_TARGET';
}
```

---

## Step 3 — Create the deploy script

Create `packages/nr-ai-mcp-server/scripts/deploy-alerts.ts`:

```typescript
#!/usr/bin/env npx tsx
/**
 * Deploy AI Coding Assistant alert conditions to a New Relic account.
 *
 * Usage:
 *   NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts [options]
 *
 *   --dry-run   Print the policy + conditions that would be created and exit.
 *   --teardown  Delete the alert policy and all its conditions.
 *
 * Requires a New Relic User API key (NRAK-...), not a license key.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlertConditionDefinition, AlertPolicyDefinition } from '../src/alerts/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';
```

### Step 3a — NerdGraph helper

Add a `nerdgraph()` helper at the top of the script (copy the existing pattern from `deploy-dashboard.ts`):

```typescript
async function nerdgraph<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const resp = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API-Key': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`NerdGraph HTTP ${resp.status}: ${await resp.text()}`);
  }
  const json = await resp.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`NerdGraph errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  return json.data as T;
}
```

### Step 3b — Create policy mutation

```typescript
const CREATE_POLICY_MUTATION = `
mutation CreateAlertPolicy($accountId: Int!, $name: String!, $incidentPreference: AlertsNrqlConditionIncidentPreference!) {
  alertsPolicyCreate(accountId: $accountId, policy: {
    name: $name
    incidentPreference: $incidentPreference
  }) {
    id
    name
  }
}`;

interface CreatePolicyResult {
  alertsPolicyCreate: { id: string; name: string };
}
```

### Step 3c — Create NRQL condition mutation

```typescript
const CREATE_NRQL_CONDITION_MUTATION = `
mutation CreateNrqlCondition($accountId: Int!, $policyId: ID!, $condition: AlertsNrqlConditionStaticInput!) {
  alertsNrqlConditionStaticCreate(accountId: $accountId, policyId: $policyId, condition: $condition) {
    id
    name
    enabled
  }
}`;

interface CreateConditionResult {
  alertsNrqlConditionStaticCreate: { id: string; name: string; enabled: boolean };
}
```

### Step 3d — Search for existing policy mutation (for idempotency)

```typescript
const LIST_POLICIES_QUERY = `
query ListPolicies($accountId: Int!, $name: String!) {
  actor {
    account(id: $accountId) {
      alerts {
        policiesSearch(searchCriteria: { name: $name }) {
          policies {
            id
            name
          }
        }
      }
    }
  }
}`;

interface ListPoliciesResult {
  actor: {
    account: {
      alerts: {
        policiesSearch: {
          policies: Array<{ id: string; name: string }>;
        };
      };
    };
  };
}
```

### Step 3e — Delete policy mutation (teardown)

```typescript
const DELETE_POLICY_MUTATION = `
mutation DeletePolicy($accountId: Int!, $policyId: ID!) {
  alertsPolicyDelete(accountId: $accountId, id: $policyId) {
    id
  }
}`;
```

### Step 3f — Load definitions and main function

```typescript
function loadDefinitions(): {
  policy: AlertPolicyDefinition;
  conditions: AlertConditionDefinition[];
} {
  const alertsDir = resolve(__dirname, '..', 'src', 'alerts');
  const conditionsDir = resolve(alertsDir, 'conditions');

  const policy: AlertPolicyDefinition = JSON.parse(
    readFileSync(resolve(alertsDir, 'policy.json'), 'utf-8'),
  );

  const conditionFiles = readdirSync(conditionsDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const conditions: AlertConditionDefinition[] = conditionFiles.map(f =>
    JSON.parse(readFileSync(resolve(conditionsDir, f), 'utf-8')),
  );

  return { policy, conditions };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const teardown = args.includes('--teardown');

  const apiKey = process.env.NEW_RELIC_API_KEY ?? process.env.NEW_RELIC_LICENSE_KEY;
  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;

  if (!accountIdStr) {
    console.error('Error: NEW_RELIC_ACCOUNT_ID environment variable is required.');
    process.exit(1);
  }
  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId)) {
    console.error(`Error: NEW_RELIC_ACCOUNT_ID must be a number. Got: "${accountIdStr}"`);
    process.exit(1);
  }

  const { policy, conditions } = loadDefinitions();

  if (dryRun) {
    console.log('--- Dry run: would create policy ---');
    console.log(JSON.stringify(policy, null, 2));
    console.log(`--- Would create ${conditions.length} conditions ---`);
    for (const c of conditions) {
      console.log(`  [${c.enabled ? 'enabled' : 'disabled'}] ${c.name}`);
    }
    return;
  }

  if (!apiKey) {
    console.error('Error: NEW_RELIC_API_KEY environment variable is required.');
    process.exit(1);
  }

  if (teardown) {
    // Find existing policy by name and delete it
    const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
      accountId,
      name: policy.name,
    });
    const existing = listResult.actor.account.alerts.policiesSearch.policies;
    if (existing.length === 0) {
      console.log(`No policy named "${policy.name}" found. Nothing to delete.`);
      return;
    }
    for (const p of existing) {
      await nerdgraph(apiKey, DELETE_POLICY_MUTATION, { accountId, policyId: p.id });
      console.log(`Deleted policy "${p.name}" (id: ${p.id})`);
    }
    return;
  }

  // Idempotent upsert: skip if policy already exists
  const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
    accountId,
    name: policy.name,
  });
  const existing = listResult.actor.account.alerts.policiesSearch.policies;

  let policyId: string;
  if (existing.length > 0) {
    policyId = existing[0].id;
    console.log(`Policy "${policy.name}" already exists (id: ${policyId}). Skipping creation.`);
    console.log('Tip: run with --teardown to delete it first, then re-deploy.');
    return;
  }

  // Create policy
  const createPolicyResult = await nerdgraph<CreatePolicyResult>(apiKey, CREATE_POLICY_MUTATION, {
    accountId,
    name: policy.name,
    incidentPreference: policy.incidentPreference,
  });
  policyId = createPolicyResult.alertsPolicyCreate.id;
  console.log(`Created policy "${policy.name}" (id: ${policyId})`);

  // Create each condition
  for (const cond of conditions) {
    const conditionInput = {
      name: cond.name,
      description: cond.description,
      enabled: cond.enabled,
      nrql: { query: cond.nrqlQuery },
      signal: {
        aggregationMethod: cond.aggregationMethod,
        aggregationWindow: cond.aggregationWindow,
        ...(cond.aggregationDelay !== undefined ? { aggregationDelay: String(cond.aggregationDelay) } : {}),
        ...(cond.aggregationTimer !== undefined ? { aggregationTimer: String(cond.aggregationTimer) } : {}),
      },
      terms: [
        {
          threshold: String(cond.thresholdCritical.value),
          thresholdDuration: cond.thresholdCritical.duration,
          thresholdOccurrences: cond.thresholdCritical.occurrences,
          operator: cond.thresholdOperator,
          priority: 'CRITICAL',
        },
        ...(cond.thresholdWarning ? [{
          threshold: String(cond.thresholdWarning.value),
          thresholdDuration: cond.thresholdWarning.duration,
          thresholdOccurrences: cond.thresholdWarning.occurrences,
          operator: cond.thresholdOperator,
          priority: 'WARNING',
        }] : []),
      ],
      violationTimeLimitSeconds: cond.violationTimeLimitSeconds,
    };

    const result = await nerdgraph<CreateConditionResult>(apiKey, CREATE_NRQL_CONDITION_MUTATION, {
      accountId,
      policyId,
      condition: conditionInput,
    });
    const status = result.alertsNrqlConditionStaticCreate.enabled ? 'enabled' : 'disabled';
    console.log(`  Created condition "${result.alertsNrqlConditionStaticCreate.name}" (${status})`);
  }

  console.log('\nDone. Tip: adjust threshold values in src/alerts/conditions/ to match your usage.');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

---

## Step 4 — Add the deploy-alerts script to package.json scripts

In `packages/nr-ai-mcp-server/package.json`, add to the `"scripts"` section:

```json
"deploy:alerts": "npx tsx scripts/deploy-alerts.ts",
"deploy:alerts:teardown": "npx tsx scripts/deploy-alerts.ts --teardown"
```

Also add to the `"bin"` exports if a standalone CLI entry point is wanted (optional).

---

## Step 5 — Write tests

Create `packages/nr-ai-mcp-server/src/alerts/alerts.test.ts`.

The test file should:

1. Read all JSON files from `src/alerts/conditions/` and validate their structure.
2. Validate the `policy.json` structure.
3. Validate that each condition's `nrqlQuery` contains `SELECT` and `FROM`.
4. Validate that each condition's `nrqlQuery` references only known event types (`AiToolCall`, `Metric`, `AiCodingTask`, `AiAntiPattern`).
5. Validate that `thresholdCritical.duration` is a multiple of `aggregationWindow`.
6. Validate that `aggregationDelay` is only set when `aggregationMethod` is `EVENT_FLOW` or `CADENCE`.
7. Validate that no two conditions share the same `name`.

Test skeleton:

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AlertConditionDefinition, AlertPolicyDefinition } from './types.js';

const alertsDir = resolve(__dirname, '.');
const conditionsDir = resolve(alertsDir, 'conditions');

const policy: AlertPolicyDefinition = JSON.parse(
  readFileSync(resolve(alertsDir, 'policy.json'), 'utf-8'),
);

const conditionFiles = readdirSync(conditionsDir).filter(f => f.endsWith('.json')).sort();
const conditions: Array<{ file: string; condition: AlertConditionDefinition }> = conditionFiles.map(file => ({
  file,
  condition: JSON.parse(readFileSync(resolve(conditionsDir, file), 'utf-8')),
}));

const VALID_EVENT_TYPES = new Set(['AiToolCall', 'Metric', 'AiCodingTask', 'AiAntiPattern', 'AiAuditEvent']);

describe('Alert policy definition', () => {
  it('has a name', () => expect(policy.name).toBeTruthy());
  it('has a valid incidentPreference', () => {
    expect(['PER_POLICY', 'PER_CONDITION', 'PER_CONDITION_AND_TARGET']).toContain(policy.incidentPreference);
  });
});

describe.each(conditions)('Condition: $file', ({ file, condition }) => {
  it('has required string fields', () => {
    expect(condition.name).toBeTruthy();
    expect(condition.nrqlQuery).toBeTruthy();
    expect(condition.aggregationMethod).toBeTruthy();
  });

  it('nrqlQuery contains SELECT and FROM', () => {
    expect(condition.nrqlQuery).toMatch(/SELECT/i);
    expect(condition.nrqlQuery).toMatch(/FROM/i);
  });

  it('nrqlQuery references a known event type', () => {
    const match = condition.nrqlQuery.match(/FROM\s+(\w+)/i);
    expect(match).not.toBeNull();
    expect(VALID_EVENT_TYPES.has(match![1])).toBe(true);
  });

  it('thresholdCritical.duration is a multiple of aggregationWindow', () => {
    expect(condition.thresholdCritical.duration % condition.aggregationWindow).toBe(0);
  });

  it('aggregationDelay only set for EVENT_FLOW or CADENCE', () => {
    if (condition.aggregationDelay !== undefined) {
      expect(['EVENT_FLOW', 'CADENCE']).toContain(condition.aggregationMethod);
    }
  });
});

describe('Condition name uniqueness', () => {
  it('no two conditions share the same name', () => {
    const names = conditions.map(c => c.condition.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

---

## Step 6 — Update README / ONBOARDING

In `ONBOARDING.md`, add a section after the dashboard deploy section:

```markdown
### Deploy alert conditions

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts
```

Deploys the "AI Coding Assistant Alerts" policy with five conditions. Use `--dry-run` to
preview. Conditions 1–4 are enabled by default; condition 05 (session budget) is disabled
and requires adjusting the threshold in `src/alerts/conditions/05-session-cost-budget.json`.

To remove:
```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts --teardown
```
```

---

## Acceptance criteria

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — `alerts.test.ts` runs and all assertions pass
- [ ] `npx tsx scripts/deploy-alerts.ts --dry-run` prints all 5 conditions without hitting the API
- [ ] All 5 condition JSON files are valid `AlertConditionDefinition` objects
- [ ] `policy.json` is a valid `AlertPolicyDefinition`
- [ ] No two conditions share the same `name`
- [ ] The deploy script's idempotent path (policy already exists) logs a clear message and exits 0
- [ ] The `--teardown` path deletes the policy
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/alerts/types.ts
packages/nr-ai-mcp-server/src/alerts/policy.json
packages/nr-ai-mcp-server/src/alerts/conditions/01-daily-cost-spike.json
packages/nr-ai-mcp-server/src/alerts/conditions/02-low-efficiency-score.json
packages/nr-ai-mcp-server/src/alerts/conditions/03-stuck-loop-rate.json
packages/nr-ai-mcp-server/src/alerts/conditions/04-anti-pattern-rate.json
packages/nr-ai-mcp-server/src/alerts/conditions/05-session-cost-budget.json
packages/nr-ai-mcp-server/src/alerts/alerts.test.ts
packages/nr-ai-mcp-server/scripts/deploy-alerts.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/package.json  — add deploy:alerts scripts
ONBOARDING.md                           — add deploy alert conditions section
```
