# Implementation Plan: Developer-Scoped Alert Deployments

**Roadmap item:** [14 — Developer-Scoped Alert Deployments](../../ROADMAP.md#14-developer-scoped-alert-deployments)
**Effort estimate:** ~1 day
**Prerequisites:** Item 12 (developer identity normalisation). Item 3 (alert conditions) must already be complete — this plan extends the existing `deploy-alerts.ts` script and `src/alerts/` structure.

---

## Goal

Extend `deploy-alerts.ts` with a `--developer <name>` flag that deploys a second, personal alert policy alongside the existing team-wide one. Personal conditions inject `AND developer = '<name>'` into their NRQL and use individually meaningful thresholds (e.g., $2/day vs. $50/day). The `--developer` flag is **additive** — running without it deploys the team policy only; running with it deploys the personal policy only; running both flags in separate invocations is the intended production pattern.

Personal thresholds are configurable via a new `alerts.personal` config section in `~/.nr-ai-observe/config.json` so each developer can tune them without touching source files.

---

## Background reading

Before starting, read these files:

- `packages/nr-ai-mcp-server/scripts/deploy-alerts.ts` — the existing deploy script; understand `loadDefinitions()`, the NerdGraph mutations, idempotent upsert logic, and `--teardown`
- `packages/nr-ai-mcp-server/src/alerts/types.ts` — `AlertConditionDefinition` and `AlertPolicyDefinition` — you will reuse these types
- `packages/nr-ai-mcp-server/src/alerts/conditions/` — read all five existing team conditions to understand the NRQL patterns you will adapt
- `packages/nr-ai-mcp-server/src/config.ts` — `loadMcpConfig()` and `normalizeDeveloperName()` — you will use both in the deploy script
- `packages/nr-ai-mcp-server/src/alerts/alerts.test.ts` — test patterns for alert JSON validation; mirror for the personal conditions

---

## Step 1 — Create the personal config type and loader

### 1a — Add `PersonalAlertThresholds` to `src/alerts/types.ts`

Append to `packages/nr-ai-mcp-server/src/alerts/types.ts`:

```typescript
export interface PersonalAlertThresholds {
  readonly dailyCostUsd: number;          // default: 2
  readonly sessionCostUsd: number;        // default: 0.50
  readonly efficiencyScoreMin: number;    // default: 40
  readonly antiPatternRateMax: number;    // default: 0.15  (15% of calls are anti-patterns)
  readonly stuckLoopCountMax: number;     // default: 2
}

export const DEFAULT_PERSONAL_THRESHOLDS: PersonalAlertThresholds = {
  dailyCostUsd: 2,
  sessionCostUsd: 0.50,
  efficiencyScoreMin: 40,
  antiPatternRateMax: 0.15,
  stuckLoopCountMax: 2,
};
```

### 1b — Add `alerts.personal` to `McpServerConfig`

In `packages/nr-ai-mcp-server/src/config.ts`, add `personalAlertThresholds` to the `McpServerConfig` interface:

```typescript
readonly personalAlertThresholds: PersonalAlertThresholds;
```

Import `PersonalAlertThresholds` and `DEFAULT_PERSONAL_THRESHOLDS` from `./alerts/types.js`.

In `loadMcpConfig()`, resolve the personal thresholds by merging file values over defaults:

```typescript
personalAlertThresholds: (() => {
  const fileThresholds = typeof file.alerts === 'object' && file.alerts !== null
    ? (file.alerts as Record<string, unknown>).personal
    : undefined;
  if (typeof fileThresholds !== 'object' || fileThresholds === null) {
    return DEFAULT_PERSONAL_THRESHOLDS;
  }
  const t = fileThresholds as Record<string, unknown>;
  return {
    dailyCostUsd:        typeof t.dailyCostUsd === 'number'       ? t.dailyCostUsd       : DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
    sessionCostUsd:      typeof t.sessionCostUsd === 'number'     ? t.sessionCostUsd     : DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
    efficiencyScoreMin:  typeof t.efficiencyScoreMin === 'number' ? t.efficiencyScoreMin : DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
    antiPatternRateMax:  typeof t.antiPatternRateMax === 'number' ? t.antiPatternRateMax : DEFAULT_PERSONAL_THRESHOLDS.antiPatternRateMax,
    stuckLoopCountMax:   typeof t.stuckLoopCountMax === 'number'  ? t.stuckLoopCountMax  : DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
  };
})(),
```

---

## Step 2 — Create the personal conditions directory and JSON files

Create `packages/nr-ai-mcp-server/src/alerts/conditions-personal/`. Add five files. Note that these files use `{{developer}}` as a placeholder — the deploy script will substitute the real developer name at runtime (see Step 3).

### `01-personal-daily-cost.json`

```json
{
  "name": "AI Personal Daily Cost — {{developer}}",
  "description": "Fires when {{developer}}'s daily AI coding spend exceeds the personal threshold.",
  "enabled": true,
  "nrqlQuery": "SELECT sum(numeric(cost.totalUsd)) FROM Metric WHERE metricName = 'ai.cost.session' AND developer = '{{developer}}' SINCE 1 day ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 3600,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": "__dailyCostUsd__",
    "duration": 3600,
    "occurrences": "ALL"
  },
  "violationTimeLimitSeconds": 86400
}
```

### `02-personal-session-cost.json`

```json
{
  "name": "AI Personal Session Cost — {{developer}}",
  "description": "Fires when a single session by {{developer}} exceeds the personal session cost threshold.",
  "enabled": true,
  "nrqlQuery": "SELECT max(numeric(cost.totalUsd)) FROM AiToolCall WHERE developer = '{{developer}}' SINCE 1 hour ago FACET session_id",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 300,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": "__sessionCostUsd__",
    "duration": 300,
    "occurrences": "AT_LEAST_ONCE"
  },
  "violationTimeLimitSeconds": 86400
}
```

### `03-personal-low-efficiency.json`

```json
{
  "name": "AI Personal Low Efficiency — {{developer}}",
  "description": "Fires when {{developer}}'s efficiency score stays below personal threshold for 30 minutes.",
  "enabled": true,
  "nrqlQuery": "SELECT average(numeric(efficiency.score)) FROM Metric WHERE metricName = 'ai.efficiency.score' AND developer = '{{developer}}' SINCE 30 minutes ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 300,
  "aggregationDelay": 120,
  "thresholdOperator": "BELOW",
  "thresholdCritical": {
    "value": "__efficiencyScoreMin__",
    "duration": 1800,
    "occurrences": "ALL"
  },
  "violationTimeLimitSeconds": 86400
}
```

### `04-personal-anti-pattern-rate.json`

```json
{
  "name": "AI Personal Anti-Pattern Rate — {{developer}}",
  "description": "Fires when {{developer}}'s anti-pattern rate exceeds personal threshold in a 15-minute window.",
  "enabled": true,
  "nrqlQuery": "SELECT count(*) FROM AiAntiPattern WHERE developer = '{{developer}}' SINCE 15 minutes ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 300,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": "__stuckLoopCountMax__",
    "duration": 300,
    "occurrences": "AT_LEAST_ONCE"
  },
  "violationTimeLimitSeconds": 43200
}
```

### `05-personal-stuck-loop.json`

```json
{
  "name": "AI Personal Stuck Loop — {{developer}}",
  "description": "Fires when {{developer}} triggers more than the personal stuck loop threshold in a 10-minute window.",
  "enabled": true,
  "nrqlQuery": "SELECT count(*) FROM AiAntiPattern WHERE developer = '{{developer}}' AND patternType = 'stuck_loop' SINCE 10 minutes ago",
  "aggregationMethod": "EVENT_FLOW",
  "aggregationWindow": 300,
  "aggregationDelay": 120,
  "thresholdOperator": "ABOVE",
  "thresholdCritical": {
    "value": "__stuckLoopCountMax__",
    "duration": 300,
    "occurrences": "AT_LEAST_ONCE"
  },
  "violationTimeLimitSeconds": 43200
}
```

> The `__placeholder__` values in `thresholdCritical.value` are substituted at runtime by the deploy script. They are stored as strings in JSON so they survive `JSON.parse` without becoming numeric — the deploy script replaces them with the actual configured threshold values before calling NerdGraph.

---

## Step 3 — Extend `deploy-alerts.ts` with `--developer` support

### 3a — Parse the `--developer` flag

In `main()`, add alongside the existing flag parsing:

```typescript
const developerFlagIndex = args.indexOf('--developer');
const developerRaw: string | null = developerFlagIndex !== -1
  ? (args[developerFlagIndex + 1] ?? null)
  : null;
```

Import `normalizeDeveloperName` from `../src/config.js`:

```typescript
import { normalizeDeveloperName } from '../src/config.js';
```

Normalise the input:

```typescript
const developer: string | null = developerRaw ? normalizeDeveloperName(developerRaw) : null;
```

### 3b — Add `loadPersonalDefinitions()` function

```typescript
function loadPersonalDefinitions(
  developer: string,
  thresholds: PersonalAlertThresholds,
): { policy: AlertPolicyDefinition; conditions: AlertConditionDefinition[] } {
  const conditionsDir = resolve(__dirname, '..', 'src', 'alerts', 'conditions-personal');

  const policy: AlertPolicyDefinition = {
    name: `AI Coding — Personal — ${developer}`,
    incidentPreference: 'PER_CONDITION',
  };

  const conditionFiles = readdirSync(conditionsDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const thresholdMap: Record<string, number> = {
    __dailyCostUsd__:       thresholds.dailyCostUsd,
    __sessionCostUsd__:     thresholds.sessionCostUsd,
    __efficiencyScoreMin__: thresholds.efficiencyScoreMin,
    __antiPatternRateMax__: thresholds.antiPatternRateMax,
    __stuckLoopCountMax__:  thresholds.stuckLoopCountMax,
  };

  const conditions: AlertConditionDefinition[] = conditionFiles.map(f => {
    let raw = readFileSync(resolve(conditionsDir, f), 'utf-8');

    // Substitute developer name and threshold placeholders
    raw = raw.replaceAll('{{developer}}', developer);
    for (const [placeholder, value] of Object.entries(thresholdMap)) {
      // The placeholder appears as a quoted string in JSON: "__dailyCostUsd__"
      // Replace with a bare number so it becomes a valid JSON number after re-parse
      raw = raw.replace(`"${placeholder}"`, String(value));
    }

    return JSON.parse(raw) as AlertConditionDefinition;
  });

  return { policy, conditions };
}
```

### 3c — Read personal thresholds from config file (optional)

The deploy script runs standalone via `npx tsx`, so it cannot use `loadMcpConfig()` directly (which requires a full NR license key). Instead, read only the `alerts.personal` section from the config file without requiring NR credentials:

```typescript
function loadPersonalThresholds(): PersonalAlertThresholds {
  const configPath = resolve(homedir(), '.nr-ai-observe', 'config.json');
  try {
    const file = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const alertsSection = file.alerts;
    if (typeof alertsSection !== 'object' || alertsSection === null) return DEFAULT_PERSONAL_THRESHOLDS;
    const personal = (alertsSection as Record<string, unknown>).personal;
    if (typeof personal !== 'object' || personal === null) return DEFAULT_PERSONAL_THRESHOLDS;
    const t = personal as Record<string, unknown>;
    return {
      dailyCostUsd:        typeof t.dailyCostUsd === 'number'       ? t.dailyCostUsd       : DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
      sessionCostUsd:      typeof t.sessionCostUsd === 'number'     ? t.sessionCostUsd     : DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
      efficiencyScoreMin:  typeof t.efficiencyScoreMin === 'number' ? t.efficiencyScoreMin : DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
      antiPatternRateMax:  typeof t.antiPatternRateMax === 'number' ? t.antiPatternRateMax : DEFAULT_PERSONAL_THRESHOLDS.antiPatternRateMax,
      stuckLoopCountMax:   typeof t.stuckLoopCountMax === 'number'  ? t.stuckLoopCountMax  : DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
    };
  } catch {
    return DEFAULT_PERSONAL_THRESHOLDS;
  }
}
```

Add `import { homedir } from 'node:os';` and `import { DEFAULT_PERSONAL_THRESHOLDS } from '../src/alerts/types.js';` at the top.

### 3d — Branch on `--developer` in `main()`

In `main()`, after the existing `teardown` path and before the team deploy path, add:

```typescript
if (developer) {
  const thresholds = loadPersonalThresholds();
  const { policy, conditions } = loadPersonalDefinitions(developer, thresholds);

  if (dryRun) {
    console.log(`--- Dry run: personal policy for ${developer} ---`);
    console.log(JSON.stringify(policy, null, 2));
    console.log(`--- Would create ${conditions.length} personal conditions ---`);
    for (const c of conditions) {
      console.log(`  [${c.enabled ? 'enabled' : 'disabled'}] ${c.name}`);
    }
    return;
  }

  if (teardown) {
    // Find and delete by policy name
    const listResult = await nerdgraph<ListPoliciesResult>(apiKey!, LIST_POLICIES_QUERY, {
      accountId,
      name: policy.name,
    });
    const existing = listResult.actor.account.alerts.policiesSearch.policies;
    if (existing.length === 0) {
      console.log(`No personal policy found for "${developer}". Nothing to delete.`);
      return;
    }
    for (const p of existing) {
      await nerdgraph(apiKey!, DELETE_POLICY_MUTATION, { accountId, policyId: p.id });
      console.log(`Deleted personal policy "${p.name}" (id: ${p.id})`);
    }
    return;
  }

  // Deploy personal policy (idempotent: skip if already exists)
  const listResult = await nerdgraph<ListPoliciesResult>(apiKey!, LIST_POLICIES_QUERY, {
    accountId,
    name: policy.name,
  });
  if (listResult.actor.account.alerts.policiesSearch.policies.length > 0) {
    const existing = listResult.actor.account.alerts.policiesSearch.policies[0];
    console.log(`Personal policy for "${developer}" already exists (id: ${existing.id}). Use --teardown to reset.`);
    return;
  }

  const createResult = await nerdgraph<CreatePolicyResult>(apiKey!, CREATE_POLICY_MUTATION, {
    accountId,
    name: policy.name,
    incidentPreference: policy.incidentPreference,
  });
  const policyId = createResult.alertsPolicyCreate.id;
  console.log(`Created personal policy "${policy.name}" (id: ${policyId})`);

  for (const cond of conditions) {
    const result = await deployCondition(apiKey!, accountId, policyId, cond);
    console.log(`  Created: ${result.alertsNrqlConditionStaticCreate.name}`);
  }
  return;
}

// ... existing team policy deploy continues here
```

Extract the existing per-condition NerdGraph call into a named helper `deployCondition` to avoid duplication between the team and personal paths.

---

## Step 4 — Write tests

Create `packages/nr-ai-mcp-server/src/alerts/personal-alerts.test.ts`.

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERSONAL_THRESHOLDS } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const conditionsDir = resolve(__dirname, 'conditions-personal');

const rawFiles = readdirSync(conditionsDir).filter(f => f.endsWith('.json')).sort();

describe('Personal alert condition files', () => {
  it('has exactly 5 condition files', () => {
    expect(rawFiles).toHaveLength(5);
  });

  it('all files contain {{developer}} in name and nrqlQuery', () => {
    for (const file of rawFiles) {
      const raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      expect(raw).toContain('{{developer}}');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      expect(obj.name as string).toContain('{{developer}}');
      expect(obj.nrqlQuery as string).toContain("'{{developer}}'");
    }
  });

  it('all files contain at least one threshold placeholder', () => {
    const placeholders = ['__dailyCostUsd__', '__sessionCostUsd__', '__efficiencyScoreMin__', '__antiPatternRateMax__', '__stuckLoopCountMax__'];
    for (const file of rawFiles) {
      const raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      const hasPlaceholder = placeholders.some(p => raw.includes(p));
      expect(hasPlaceholder).toBe(true);
    }
  });

  it('after substitution with defaults + developer, produces valid AlertConditionDefinition', () => {
    const developer = 'testuser';
    const thresholdMap: Record<string, number> = {
      __dailyCostUsd__:       DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
      __sessionCostUsd__:     DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
      __efficiencyScoreMin__: DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
      __antiPatternRateMax__: DEFAULT_PERSONAL_THRESHOLDS.antiPatternRateMax,
      __stuckLoopCountMax__:  DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
    };

    for (const file of rawFiles) {
      let raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      raw = raw.replaceAll('{{developer}}', developer);
      for (const [placeholder, value] of Object.entries(thresholdMap)) {
        raw = raw.replace(`"${placeholder}"`, String(value));
      }

      const cond = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof cond.name).toBe('string');
      expect((cond.name as string)).toContain(developer);
      expect(typeof cond.nrqlQuery).toBe('string');
      expect((cond.nrqlQuery as string)).toContain(`'${developer}'`);
      expect(typeof cond.thresholdCritical).toBe('object');
      const threshold = (cond.thresholdCritical as Record<string, unknown>).value;
      expect(typeof threshold).toBe('number');
    }
  });

  it('no two conditions share the same name template', () => {
    const nameTemplates = rawFiles.map(f => {
      const raw = readFileSync(resolve(conditionsDir, f), 'utf-8');
      return (JSON.parse(raw) as Record<string, unknown>).name as string;
    });
    expect(new Set(nameTemplates).size).toBe(nameTemplates.length);
  });
});
```

---

## Step 5 — Document in README and setup wizard

In `README.md`, add a section after the existing alerts section:

```markdown
### Personal alert conditions

Deploy alert conditions scoped to a single developer:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-alerts.ts --developer cdehaan
```

This creates a separate policy named "AI Coding — Personal — cdehaan" with tighter thresholds.

To customise personal thresholds, add an `alerts.personal` section to `~/.nr-ai-observe/config.json`:

```json
{
  "alerts": {
    "personal": {
      "dailyCostUsd": 3,
      "sessionCostUsd": 0.75,
      "efficiencyScoreMin": 35
    }
  }
}
```

To remove:
```bash
npx tsx scripts/deploy-alerts.ts --developer cdehaan --teardown
```
```

In `setup-wizard.ts`, after the alerts deploy hint, add:

```typescript
print(`\nFor personal alerts scoped to you:`);
print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-alerts.ts --developer ${developer}`);
```

---

## Acceptance criteria

- [ ] `src/alerts/conditions-personal/` contains exactly 5 JSON files
- [ ] Every personal condition file contains `{{developer}}` in `name` and `nrqlQuery`
- [ ] Every personal condition file contains a threshold placeholder (`__xxx__`)
- [ ] After substitution with a developer name and default thresholds, all conditions produce valid `AlertConditionDefinition` objects with numeric threshold values
- [ ] `deploy-alerts.ts --developer testuser --dry-run` prints 5 personal conditions without hitting the API
- [ ] `deploy-alerts.ts --dry-run` (no `--developer`) still prints only the 5 team conditions
- [ ] `deploy-alerts.ts --developer testuser --teardown` deletes only the personal policy, not the team policy
- [ ] `DEFAULT_PERSONAL_THRESHOLDS` is exported from `types.ts` and its values match the documented defaults
- [ ] `npm run build && npm test && npm run lint` all pass

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/alerts/conditions-personal/01-personal-daily-cost.json
packages/nr-ai-mcp-server/src/alerts/conditions-personal/02-personal-session-cost.json
packages/nr-ai-mcp-server/src/alerts/conditions-personal/03-personal-low-efficiency.json
packages/nr-ai-mcp-server/src/alerts/conditions-personal/04-personal-anti-pattern-rate.json
packages/nr-ai-mcp-server/src/alerts/conditions-personal/05-personal-stuck-loop.json
packages/nr-ai-mcp-server/src/alerts/personal-alerts.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/alerts/types.ts       — add PersonalAlertThresholds, DEFAULT_PERSONAL_THRESHOLDS
packages/nr-ai-mcp-server/src/config.ts              — add personalAlertThresholds to McpServerConfig + loadMcpConfig()
packages/nr-ai-mcp-server/scripts/deploy-alerts.ts   — add --developer flag, loadPersonalDefinitions(), loadPersonalThresholds()
packages/nr-ai-mcp-server/src/install/setup-wizard.ts — add personal alerts deploy hint
README.md                                             — add personal alerts section
```
