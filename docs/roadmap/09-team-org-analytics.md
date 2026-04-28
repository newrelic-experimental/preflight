# Implementation Plan: Team and Org Analytics

**Roadmap item:** [07 — Team and Org Analytics](../../ROADMAP.md#7-team-and-org-analytics)
**Effort estimate:** ~1.5 days
**Prerequisites:** Read the following files before starting.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-mcp-server/src/config.ts` — `McpServerConfig`; new `teamId`/`projectId`/`orgId` fields go here
- `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts` — `toolCallToNrEvent()` and `proxyToolCallToNrEvent()`; team dimensions are added to every event here
- `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts` — pattern for cross-session MCP tools; the new `nr_observe_get_team_summary` follows this pattern
- `packages/nr-ai-mcp-server/src/dashboards/` — inspect an existing dashboard JSON to understand the dashboard format before creating the manager dashboard

---

## Goal

Tag all NR events and metrics with `teamId`, `projectId`, and `orgId` dimensions. Provide a `nr_observe_get_team_summary` MCP tool that queries NR for aggregated team-level data. Ship a "manager dashboard" JSON that shows cost and efficiency per developer without tool-call content. Git remote URL is used to auto-derive `projectId` when not explicitly configured.

---

## Step 1 — Add team fields to `McpServerConfig`

Open `packages/nr-ai-mcp-server/src/config.ts`.

### 1a — Add to the `McpServerConfig` interface

Add these three fields after the `developer` field:

```typescript
readonly teamId: string | null;
readonly projectId: string | null;
readonly orgId: string | null;
```

### 1b — Add a helper to extract `projectId` from git remote URL

```typescript
function inferProjectId(): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    // Extract "org/repo" from HTTPS or SSH remotes:
    // https://github.com/org/repo.git  → org/repo
    // git@github.com:org/repo.git      → org/repo
    const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
```

### 1c — Add env/file loading in `loadMcpConfig()`

After the `developer` field construction, add:

```typescript
teamId:
  process.env.NEW_RELIC_AI_TEAM_ID ??
  (typeof file.teamId === 'string' ? file.teamId : null),

projectId:
  process.env.NEW_RELIC_AI_PROJECT_ID ??
  (typeof file.projectId === 'string' ? file.projectId : inferProjectId()),

orgId:
  process.env.NEW_RELIC_AI_ORG_ID ??
  (typeof file.orgId === 'string' ? file.orgId : null),
```

### 1d — Update the debug log

Add `teamId`, `projectId`, `orgId` to the `logger.debug('Configuration loaded', ...)` call.

---

## Step 2 — Add team dimensions to all NR events

Open `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts`.

### 2a — Update `NrIngestOptions`

Add three new fields:

```typescript
teamId?: string | null;
projectId?: string | null;
orgId?: string | null;
```

Store them as private fields on the class (`this.teamId`, etc.).

### 2b — Update `toolCallToNrEvent()`

The function signature becomes:

```typescript
export function toolCallToNrEvent(
  record: ToolCallRecord,
  attrs: { developer: string; appName: string; teamId?: string | null; projectId?: string | null; orgId?: string | null },
): NrEventData
```

In the event object construction, after `app_name`, add:

```typescript
if (attrs.teamId) event.team_id = attrs.teamId;
if (attrs.projectId) event.project_id = attrs.projectId;
if (attrs.orgId) event.org_id = attrs.orgId;
```

Apply the same pattern to `proxyToolCallToNrEvent()`, `aiCodingTaskToNrEvent()`, `antiPatternToNrEvent()`, `auditRecordToNrEvent()`, and any other event builder functions in this file.

### 2c — Thread team attrs through all callers

In `NrIngestManager`, update every call to the event builder functions to pass `teamId`, `projectId`, `orgId` from `this.teamId` etc.

---

## Step 3 — Add team dimensions to NR metrics

In the `HarvestScheduler` metric emission code (look for where `MetricAggregator` or gauge/count metrics are emitted), add `team_id`, `project_id`, `org_id` as attributes to every metric where they are non-null.

The `MetricAggregator` from the shared package accepts an attributes map. Thread the team fields through.

---

## Step 4 — Wire team config through `index.ts`

Open `packages/nr-ai-mcp-server/src/index.ts`.

In the `NrIngestManager` constructor call, pass:

```typescript
nrIngest = new NrIngestManager({
  // ... existing options ...
  teamId: config.teamId,
  projectId: config.projectId,
  orgId: config.orgId,
});
```

---

## Step 5 — Create `nr_observe_get_team_summary` MCP tool

Open `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`.

### 5a — Tool definition

```typescript
export const TEAM_SUMMARY_TOOL = {
  name: 'nr_observe_get_team_summary',
  description:
    'Get aggregated AI coding cost and efficiency metrics for all developers in the configured team, queried via New Relic NRQL. Requires teamId to be set in config.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      since: {
        type: 'string',
        description: 'Time window (e.g. "7 days ago", "1 day ago"). Default: "7 days ago".',
      },
    },
  },
  annotations: { readOnlyHint: true },
};
```

### 5b — Handler

The handler queries NR via NRQL (using the license key as a NerdGraph API key is not ideal — the handler should accept an optional `nrApiKey` field in config or fall back to a graceful error when the team summary requires a User API key).

```typescript
export async function handleGetTeamSummary(
  options: {
    teamId: string | null;
    accountId: string;
    nrApiKey: string | null; // NEW_RELIC_API_KEY (User key, NRAK-...)
    since?: string;
  },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!options.teamId) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'teamId is not configured. Set NEW_RELIC_AI_TEAM_ID or teamId in config.',
        }),
      }],
    };
  }

  if (!options.nrApiKey) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'NEW_RELIC_API_KEY (User key) is required for team summary queries.',
        }),
      }],
    };
  }

  const since = options.since ?? '7 days ago';
  const accountId = parseInt(options.accountId, 10);

  const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';
  const query = `query($accountId: Int!, $nrql: String!) {
    actor { account(id: $accountId) { nrql(query: $nrql) { results } } }
  }`;

  async function runNrql(nrql: string): Promise<Array<Record<string, unknown>>> {
    const resp = await fetch(NERDGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': options.nrApiKey! },
      body: JSON.stringify({ query, variables: { accountId, nrql } }),
    });
    const json = await resp.json() as { data?: { actor: { account: { nrql: { results: unknown[] } } } }; errors?: unknown[] };
    return (json.data?.actor.account.nrql.results ?? []) as Array<Record<string, unknown>>;
  }

  const [costRows, effRows, antiPatternRows] = await Promise.all([
    runNrql(
      `SELECT developer, sum(numeric(cost.totalUsd)) AS totalCost
       FROM Metric WHERE metricName = 'ai.cost.session' AND team_id = '${options.teamId}'
       SINCE ${since} FACET developer LIMIT 50`,
    ),
    runNrql(
      `SELECT developer, average(numeric(efficiency.score)) AS avgScore
       FROM Metric WHERE metricName = 'ai.efficiency.score' AND team_id = '${options.teamId}'
       SINCE ${since} FACET developer LIMIT 50`,
    ),
    runNrql(
      `SELECT developer, count(*) AS antiPatterns
       FROM AiAntiPattern WHERE team_id = '${options.teamId}'
       SINCE ${since} FACET developer LIMIT 50`,
    ),
  ]);

  // Merge by developer
  const byDev: Record<string, { costUsd: number; efficiencyScore: number | null; antiPatterns: number }> = {};
  for (const row of costRows) {
    const dev = String(row.developer ?? 'unknown');
    if (!byDev[dev]) byDev[dev] = { costUsd: 0, efficiencyScore: null, antiPatterns: 0 };
    byDev[dev].costUsd = Number(row.totalCost ?? 0);
  }
  for (const row of effRows) {
    const dev = String(row.developer ?? 'unknown');
    if (!byDev[dev]) byDev[dev] = { costUsd: 0, efficiencyScore: null, antiPatterns: 0 };
    byDev[dev].efficiencyScore = row.avgScore != null ? Number(row.avgScore) : null;
  }
  for (const row of antiPatternRows) {
    const dev = String(row.developer ?? 'unknown');
    if (!byDev[dev]) byDev[dev] = { costUsd: 0, efficiencyScore: null, antiPatterns: 0 };
    byDev[dev].antiPatterns = Number(row.antiPatterns ?? 0);
  }

  const result = {
    teamId: options.teamId,
    since,
    developers: Object.entries(byDev).map(([developer, stats]) => ({ developer, ...stats })),
    totals: {
      costUsd: Object.values(byDev).reduce((s, d) => s + d.costUsd, 0),
      developerCount: Object.keys(byDev).length,
    },
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
```

### 5c — Register the tool

In `registerTools()` (in `session-stats.ts`), add `TEAM_SUMMARY_TOOL` to the conditionally-registered tools when `options.config?.teamId` is non-null and `options.config?.nrApiKey` is non-null.

Add `nrApiKey?: string | null` to `RegisterToolsOptions`.

---

## Step 6 — Add `NEW_RELIC_API_KEY` to config

In `McpServerConfig`, add:

```typescript
readonly nrApiKey: string | null;
```

In `loadMcpConfig()`:

```typescript
nrApiKey:
  process.env.NEW_RELIC_API_KEY ??
  (typeof file.nrApiKey === 'string' ? file.nrApiKey : null),
```

> This is a User API key (NRAK-...), distinct from the license key. It is only needed for team summary NRQL queries. Do not log it.

---

## Step 7 — Create manager dashboard JSON

Create `packages/nr-ai-mcp-server/src/dashboards/ai-coding-assistant-manager-view.json`.

This dashboard shows team-level cost and efficiency data. It intentionally omits tool-call content and session-level detail.

Structure:

```json
{
  "name": "AI Coding Assistant — Manager View",
  "description": "Team-level AI coding cost and efficiency. No session content.",
  "permissions": "PUBLIC_READ_ONLY",
  "pages": [
    {
      "name": "Team Overview",
      "widgets": [
        {
          "title": "Total AI Cost (7 days)",
          "layout": { "column": 1, "row": 1, "width": 3, "height": 3 },
          "visualization": { "id": "viz.billboard" },
          "rawConfiguration": {
            "nrqlQueries": [{
              "accountIds": [],
              "query": "SELECT sum(numeric(cost.totalUsd)) AS 'Total Cost (USD)' FROM Metric WHERE metricName = 'ai.cost.session' SINCE 7 days ago"
            }]
          }
        },
        {
          "title": "Cost by Developer (7 days)",
          "layout": { "column": 4, "row": 1, "width": 5, "height": 3 },
          "visualization": { "id": "viz.bar" },
          "rawConfiguration": {
            "nrqlQueries": [{
              "accountIds": [],
              "query": "SELECT sum(numeric(cost.totalUsd)) FROM Metric WHERE metricName = 'ai.cost.session' SINCE 7 days ago FACET developer"
            }]
          }
        },
        {
          "title": "Avg Efficiency Score by Developer",
          "layout": { "column": 9, "row": 1, "width": 4, "height": 3 },
          "visualization": { "id": "viz.bar" },
          "rawConfiguration": {
            "nrqlQueries": [{
              "accountIds": [],
              "query": "SELECT average(numeric(efficiency.score)) FROM Metric WHERE metricName = 'ai.efficiency.score' SINCE 7 days ago FACET developer"
            }]
          }
        },
        {
          "title": "Daily AI Cost Trend",
          "layout": { "column": 1, "row": 4, "width": 6, "height": 3 },
          "visualization": { "id": "viz.line" },
          "rawConfiguration": {
            "nrqlQueries": [{
              "accountIds": [],
              "query": "SELECT sum(numeric(cost.totalUsd)) FROM Metric WHERE metricName = 'ai.cost.session' SINCE 30 days ago FACET developer TIMESERIES 1 day"
            }]
          }
        },
        {
          "title": "Efficiency Score Trend",
          "layout": { "column": 7, "row": 4, "width": 6, "height": 3 },
          "visualization": { "id": "viz.line" },
          "rawConfiguration": {
            "nrqlQueries": [{
              "accountIds": [],
              "query": "SELECT average(numeric(efficiency.score)) FROM Metric WHERE metricName = 'ai.efficiency.score' SINCE 30 days ago FACET developer TIMESERIES 1 day"
            }]
          }
        },
        {
          "title": "Anti-patterns by Developer",
          "layout": { "column": 1, "row": 7, "width": 6, "height": 3 },
          "visualization": { "id": "viz.bar" },
          "rawConfiguration": {
            "nrqlQueries": [{
              "accountIds": [],
              "query": "SELECT count(*) FROM AiAntiPattern SINCE 7 days ago FACET developer"
            }]
          }
        },
        {
          "title": "Cost by Project",
          "layout": { "column": 7, "row": 7, "width": 6, "height": 3 },
          "visualization": { "id": "viz.bar" },
          "rawConfiguration": {
            "nrqlQueries": [{
              "accountIds": [],
              "query": "SELECT sum(numeric(cost.totalUsd)) FROM Metric WHERE metricName = 'ai.cost.session' SINCE 7 days ago FACET project_id"
            }]
          }
        }
      ]
    }
  ]
}
```

Add this dashboard to `deploy-dashboard.ts` so `--all` deploys it.

In `dashboard.test.ts`, add:

```typescript
describe('Manager View dashboard', () => {
  const managerView = dashboards.find(d => d.file === 'ai-coding-assistant-manager-view.json');

  it('exists', () => expect(managerView).toBeDefined());

  it('has the correct name', () => {
    expect(managerView!.dashboard.name).toBe('AI Coding Assistant — Manager View');
  });

  it('includes FACET developer queries for per-developer breakdown', () => {
    const queries = getAllQueries(managerView!.dashboard);
    const developerFacetQueries = queries.filter(q => q.includes('FACET developer'));
    expect(developerFacetQueries.length).toBeGreaterThanOrEqual(3);
  });

  it('does not include tool-call content fields', () => {
    const queries = getAllQueries(managerView!.dashboard);
    for (const q of queries) {
      expect(q).not.toMatch(/system_prompt|last_user_message|response_text/i);
    }
  });
});
```

---

## Step 8 — Write tests

### `packages/nr-ai-mcp-server/src/config.test.ts` additions

- `teamId` loaded from `NEW_RELIC_AI_TEAM_ID=my-team` → `'my-team'`
- `projectId` uses config file value when no env var set
- `projectId` is null when git remote is not available

### `packages/nr-ai-mcp-server/src/transport/nr-ingest.test.ts` additions

- `toolCallToNrEvent()` includes `team_id` when `teamId` is non-null
- `toolCallToNrEvent()` omits `team_id` when `teamId` is null
- Same for `project_id` and `org_id`

---

## Acceptance criteria

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — new tests pass, existing tests not broken
- [ ] `McpServerConfig` has `teamId`, `projectId`, `orgId`, `nrApiKey` fields (all nullable)
- [ ] All NR events include `team_id`, `project_id`, `org_id` when the config values are non-null
- [ ] All NR events omit `team_id`/`project_id`/`org_id` when config values are null (no null-valued attributes)
- [ ] `inferProjectId()` correctly extracts `org/repo` from HTTPS and SSH remote URLs
- [ ] `nr_observe_get_team_summary` returns an error message (not a stack trace) when `teamId` is not configured
- [ ] `nr_observe_get_team_summary` is only registered when `teamId` and `nrApiKey` are both non-null
- [ ] Manager dashboard JSON validates against the existing `dashboard.test.ts` structural checks
- [ ] Manager dashboard has no queries referencing `system_prompt`, `last_user_message`, or `response_text`
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/dashboards/ai-coding-assistant-manager-view.json
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/config.ts              — add teamId, projectId, orgId, nrApiKey fields
packages/nr-ai-mcp-server/src/transport/nr-ingest.ts — add team dimensions to all events
packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts — add TEAM_SUMMARY_TOOL
packages/nr-ai-mcp-server/src/tools/session-stats.ts — register TEAM_SUMMARY_TOOL
packages/nr-ai-mcp-server/src/index.ts               — pass team config to NrIngestManager
packages/nr-ai-mcp-server/src/dashboard.test.ts      — add manager view tests
packages/nr-ai-mcp-server/src/config.test.ts         — add team field tests
packages/nr-ai-mcp-server/src/transport/nr-ingest.test.ts — add team dimension tests
```
