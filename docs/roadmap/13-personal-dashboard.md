# Implementation Plan: Personal Developer Dashboard

**Roadmap item:** [13 — Personal Developer Dashboard](../../ROADMAP.md#13-personal-developer-dashboard)
**Effort estimate:** ~1 day
**Prerequisites:** Item 12 (developer identity normalisation) — the dashboard uses the normalised developer name as a default variable value.

---

## Goal

Create a new dashboard JSON file (`ai-coding-assistant-personal.json`) designed for individual self-reflection. Unlike the existing overview dashboard — which uses `{{developer}}` as an optional filter on team-level data — this dashboard treats the developer as the fixed subject: every widget is pre-scoped to one person, with a 30-day window, and the page structure surfaces personal trends, patterns, and best sessions.

Also extend `deploy-dashboard.ts` with a `--developer <name>` flag that substitutes the developer's normalised identity into the dashboard's template variable `defaultValues` at deploy time, so the dashboard opens pre-filtered on first load.

---

## Background reading

Before starting, read these files:

- `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-overview.json` — understand the JSON schema: `pages`, `widgets`, `layout`, `visualization.id`, `rawConfiguration.nrqlQueries`, `variables`
- `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-session-detail.json` — example of a multi-page dashboard with detailed widgets
- `packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts` — understand how `--all`, `--update`, and `--print` flags work; you will add `--developer` alongside them
- `packages/nr-ai-mcp-server/src/config.ts` — `normalizeDeveloperName()` — use this function in the deploy script to normalise the CLI value

---

## Step 1 — Create the personal dashboard JSON

Create `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-personal.json`.

The dashboard has **three pages** and **one template variable** (`developer`). The `developer` variable uses a NRQL-driven dropdown but also has a `defaultValues` entry that the deploy script will fill in with the actual developer name (see Step 2).

### Top-level structure

```json
{
  "name": "AI Coding Assistant — Personal",
  "description": "Self-reflection dashboard for a single developer. Pre-filtered to your identity. Deploy with: npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer <your-name>",
  "permissions": "PRIVATE",
  "pages": [ /* see below */ ],
  "variables": [
    {
      "name": "developer",
      "title": "Developer",
      "type": "NRQL",
      "nrqlQuery": {
        "query": "SELECT uniques(developer) FROM AiToolCall SINCE 90 days ago",
        "accountIds": [0]
      },
      "isMultiSelection": false,
      "defaultValues": [],
      "replacementStrategy": "STRING",
      "options": { "excluded": false }
    }
  ]
}
```

> `"permissions": "PRIVATE"` ensures the dashboard is only visible to the deploying user by default.  
> `defaultValues` is intentionally empty here — the deploy script populates it at deploy time.

---

### Page 1: "My Trends" (8 widgets)

This page shows 30-day rolling trends scoped to the configured developer.

All NRQL queries must include `WHERE developer = {{developer}}`.

| # | Title | Visualization | NRQL |
|---|-------|---------------|------|
| 1 | Daily AI Spend | `viz.line` | `SELECT sum(numeric(cost.totalUsd)) FROM Metric WHERE metricName = 'ai.cost.session' AND developer = {{developer}} SINCE 30 days ago TIMESERIES 1 day` |
| 2 | Efficiency Score Trend | `viz.line` | `SELECT average(numeric(efficiency.score)) FROM Metric WHERE metricName = 'ai.efficiency.score' AND developer = {{developer}} SINCE 30 days ago TIMESERIES 1 day` |
| 3 | Tool Calls Per Day | `viz.bar` | `SELECT count(*) FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago TIMESERIES 1 day` |
| 4 | Model Cost Mix | `viz.pie` | `SELECT sum(numeric(cost.totalUsd)) FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago FACET model` |
| 5 | Sessions Per Day | `viz.bar` | `SELECT uniqueCount(session_id) FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago TIMESERIES 1 day` |
| 6 | 30-Day Total Spend | `viz.billboard` | `SELECT sum(numeric(cost.totalUsd)) AS 'Total Spend (USD)' FROM Metric WHERE metricName = 'ai.cost.session' AND developer = {{developer}} SINCE 30 days ago` |
| 7 | Avg Efficiency This Week | `viz.billboard` | `SELECT average(numeric(efficiency.score)) AS 'Avg Efficiency Score' FROM Metric WHERE metricName = 'ai.efficiency.score' AND developer = {{developer}} SINCE 7 days ago` |
| 8 | Total Sessions This Month | `viz.billboard` | `SELECT uniqueCount(session_id) AS 'Sessions' FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago` |

Widget layout: rows of 4 columns each (width 3 each for billboards, width 6 for charts). Use `"column"` and `"row"` values so all 8 widgets fit without overlap. Example layout grid:

```
Row 1: widgets 6 (col 1, w 4), 7 (col 5, w 4), 8 (col 9, w 4)
Row 2: widget 1 (col 1, w 6, h 3), widget 4 (col 7, w 6, h 3)
Row 3: continues row 2
Row 4: widget 2 (col 1, w 6, h 3), widget 3 (col 7, w 6, h 3)
Row 5: continues row 4
Row 6: widget 5 (col 1, w 6, h 3)
```

---

### Page 2: "My Patterns" (7 widgets)

This page surfaces repeating behaviours and potential inefficiencies for the configured developer.

| # | Title | Visualization | NRQL |
|---|-------|---------------|------|
| 1 | My Top Anti-Patterns | `viz.bar` | `SELECT count(*) FROM AiAntiPattern WHERE developer = {{developer}} SINCE 30 days ago FACET patternType` |
| 2 | Anti-Pattern Rate Over Time | `viz.line` | `SELECT count(*) FROM AiAntiPattern WHERE developer = {{developer}} SINCE 30 days ago TIMESERIES 1 day` |
| 3 | Most-Read Files (Top 10) | `viz.table` | `SELECT count(*) AS 'Reads' FROM AiToolCall WHERE developer = {{developer}} AND toolName = 'Read' AND filePath IS NOT NULL SINCE 30 days ago FACET filePath LIMIT 10` |
| 4 | Re-Read Rate | `viz.billboard` | `SELECT filter(count(*), WHERE toolName = 'Read') / filter(count(*), WHERE toolName IN ('Read','Edit','Write')) AS 'Re-Read Rate' FROM AiToolCall WHERE developer = {{developer}} SINCE 7 days ago` |
| 5 | Tool Usage Breakdown | `viz.pie` | `SELECT count(*) FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago FACET toolName` |
| 6 | Avg Tools Per Session | `viz.billboard` | `SELECT count(*) / uniqueCount(session_id) AS 'Avg Tools / Session' FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago` |
| 7 | Edit vs. Read Ratio | `viz.line` | `SELECT filter(count(*), WHERE toolName IN ('Edit','Write')) / filter(count(*), WHERE toolName = 'Read') AS 'Edit:Read Ratio' FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago TIMESERIES 1 day` |

---

### Page 3: "My Best Sessions" (5 widgets)

This page highlights the developer's top-performing sessions to help them understand what worked well.

| # | Title | Visualization | NRQL |
|---|-------|---------------|------|
| 1 | Top 5 Sessions by Efficiency | `viz.table` | `SELECT max(numeric(efficiency.score)) AS 'Peak Score', sum(numeric(cost.totalUsd)) AS 'Cost (USD)', uniqueCount(toolName) AS 'Tool Types' FROM AiToolCall WHERE developer = {{developer}} SINCE 90 days ago FACET session_id LIMIT 5` |
| 2 | All-Time Best Efficiency Score | `viz.billboard` | `SELECT max(numeric(efficiency.score)) AS 'Personal Best' FROM Metric WHERE metricName = 'ai.efficiency.score' AND developer = {{developer}} SINCE 90 days ago` |
| 3 | Avg Cost Per Completed Task | `viz.line` | `SELECT sum(numeric(cost.totalUsd)) / filter(count(*), WHERE outcome = 'completed') AS 'Cost / Task (USD)' FROM AiToolCall WHERE developer = {{developer}} SINCE 30 days ago TIMESERIES 1 week` |
| 4 | Sessions With Zero Anti-Patterns | `viz.billboard` | `SELECT uniqueCount(session_id) AS 'Clean Sessions' FROM AiToolCall WHERE developer = {{developer}} AND session_id NOT IN (SELECT uniques(session_id) FROM AiAntiPattern WHERE developer = {{developer}} SINCE 30 days ago) SINCE 30 days ago` |
| 5 | Most Productive Day of Week | `viz.bar` | `SELECT count(*) AS 'Tool Calls' FROM AiToolCall WHERE developer = {{developer}} SINCE 90 days ago FACET weekdayOf(timestamp)` |

---

## Step 2 — Add `--developer` flag to `deploy-dashboard.ts`

In `packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts`, add support for a `--developer <name>` flag. When provided, the script substitutes the developer name into the `defaultValues` of the `developer` template variable in the dashboard JSON before deploying.

### 2a — Parse the flag

In the `main()` function, alongside the existing flag parsing:

```typescript
const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const deployAll = args.includes('--all');
const updateMode = args.includes('--update');

// New: --developer <name>
const developerFlagIndex = args.indexOf('--developer');
const developerOverride: string | null = developerFlagIndex !== -1
  ? (args[developerFlagIndex + 1] ?? null)
  : null;

const fileArgs = args.filter((a: string) => !a.startsWith('--') && a !== args[developerFlagIndex + 1]);
```

### 2b — Import `normalizeDeveloperName`

The deploy script is in `scripts/`, not `src/`, so import it via the compiled dist or inline the normalisation logic. Because the script uses `npx tsx` (which runs TypeScript directly), import from the source:

```typescript
import { normalizeDeveloperName } from '../src/config.js';
```

### 2c — Apply the developer default before deploying

Create a helper `injectDeveloperDefault` that mutates the parsed dashboard JSON object:

```typescript
function injectDeveloperDefault(
  dashboard: Record<string, unknown>,
  developer: string,
): void {
  const variables = dashboard.variables;
  if (!Array.isArray(variables)) return;

  for (const variable of variables) {
    if (
      typeof variable === 'object' &&
      variable !== null &&
      (variable as Record<string, unknown>).name === 'developer'
    ) {
      (variable as Record<string, unknown>).defaultValues = [
        { value: { string: developer } },
      ];
      return;
    }
  }
}
```

Call this helper after parsing the JSON and before deploying, when `developerOverride` is set:

```typescript
const rawJson = readFileSync(filePath, 'utf-8');
const dashboardObj = JSON.parse(rawJson) as Record<string, unknown>;

if (developerOverride) {
  const normalised = normalizeDeveloperName(developerOverride);
  injectDeveloperDefault(dashboardObj, normalised);
  console.log(`  Developer default set to: ${normalised}`);
}

// Use JSON.stringify(dashboardObj) instead of rawJson when passing to NerdGraph
```

> Note: This only affects the personal dashboard. The `injectDeveloperDefault` function is a no-op on dashboards that do not have a `developer` variable.

---

## Step 3 — Write tests

Create `packages/nr-ai-mcp-server/src/dashboards/personal-dashboard.test.ts`.

```typescript
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardsDir = resolve(__dirname, '..', '..', '..', 'dashboards');

function loadDashboard(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(dashboardsDir, name), 'utf-8')) as Record<string, unknown>;
}

describe('ai-coding-assistant-personal.json', () => {
  const dashboard = loadDashboard('ai-coding-assistant-personal.json');

  it('has a name', () => expect(typeof dashboard.name).toBe('string'));

  it('has exactly 3 pages', () => {
    expect(Array.isArray(dashboard.pages)).toBe(true);
    expect((dashboard.pages as unknown[]).length).toBe(3);
  });

  it('has a developer template variable', () => {
    const variables = dashboard.variables as Array<Record<string, unknown>>;
    expect(Array.isArray(variables)).toBe(true);
    const devVar = variables.find(v => v.name === 'developer');
    expect(devVar).toBeDefined();
    expect(devVar?.replacementStrategy).toBe('STRING');
  });

  it('all NRQL queries reference {{developer}}', () => {
    const pages = dashboard.pages as Array<Record<string, unknown>>;
    for (const page of pages) {
      const widgets = page.widgets as Array<Record<string, unknown>>;
      for (const widget of widgets) {
        const config = widget.rawConfiguration as Record<string, unknown>;
        const queries = config?.nrqlQueries as Array<Record<string, unknown>>;
        if (!queries) continue;
        for (const q of queries) {
          const query = q.query as string;
          expect(query).toMatch(/\{\{developer\}\}/);
        }
      }
    }
  });

  it('permissions is PRIVATE', () => {
    expect(dashboard.permissions).toBe('PRIVATE');
  });

  it('all widgets have non-empty titles', () => {
    const pages = dashboard.pages as Array<Record<string, unknown>>;
    for (const page of pages) {
      const widgets = page.widgets as Array<Record<string, unknown>>;
      for (const widget of widgets) {
        expect(typeof widget.title).toBe('string');
        expect((widget.title as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('no two widgets in the same page overlap in layout', () => {
    const pages = dashboard.pages as Array<Record<string, unknown>>;
    for (const page of pages) {
      const widgets = page.widgets as Array<Record<string, unknown>>;
      const occupied = new Set<string>();
      for (const widget of widgets) {
        const layout = widget.layout as Record<string, number>;
        for (let c = layout.column; c < layout.column + layout.width; c++) {
          for (let r = layout.row; r < layout.row + layout.height; r++) {
            const cell = `${c},${r}`;
            expect(occupied.has(cell)).toBe(false);
            occupied.add(cell);
          }
        }
      }
    }
  });
});
```

---

## Step 4 — Update README and setup wizard output

In `README.md`, in the dashboard deploy section, add an example for deploying the personal dashboard:

```markdown
### Personal developer dashboard

Deploy a self-reflection dashboard pre-filtered to your identity:

```bash
NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 \
  npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer cdehaan
```

The `--developer` flag sets the default filter so the dashboard opens pre-scoped to your data.
```

In `packages/nr-ai-mcp-server/src/install/setup-wizard.ts`, at the dashboard deploy step (around line 131), add the personal dashboard to the printed command examples:

```typescript
print('\nTo deploy dashboards, run:');
print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-dashboard.ts --all`);
print(`\nFor a personal dashboard pre-filtered to you:`);
print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer ${developer}`);
```

---

## Acceptance criteria

- [ ] `packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-personal.json` exists and is valid JSON
- [ ] Dashboard has exactly 3 pages: "My Trends", "My Patterns", "My Best Sessions"
- [ ] Every NRQL query in every widget contains `{{developer}}`
- [ ] A `developer` template variable with `replacementStrategy: "STRING"` exists
- [ ] `permissions` is `"PRIVATE"`
- [ ] No two widgets in the same page overlap in layout coordinates
- [ ] `npm test` passes — all personal dashboard tests pass
- [ ] `npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --print --developer testuser` prints dashboard JSON with `defaultValues` containing `testuser`
- [ ] `deploy-dashboard.ts --all` still deploys all files including the new personal dashboard without errors
- [ ] `npm run build && npm run lint` pass

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/dashboards/ai-coding-assistant-personal.json
packages/nr-ai-mcp-server/src/dashboards/personal-dashboard.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts  — add --developer flag and injectDeveloperDefault()
packages/nr-ai-mcp-server/src/install/setup-wizard.ts  — add personal dashboard deploy example
README.md                                               — add personal dashboard deploy section
```
