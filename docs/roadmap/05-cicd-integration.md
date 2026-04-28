# Implementation Plan: CI/CD Integration

**Roadmap item:** [03 — CI/CD Integration](../../ROADMAP.md#3-cicd-integration)
**Effort estimate:** ~1.5 days
**Prerequisites:** Working New Relic account with AI telemetry data. Read the dashboard deploy script pattern in `packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts` before starting.

---

## Goal

A new `packages/nr-ai-cicd/` package that provides an `nr-ai-report` CLI binary. The binary queries New Relic via NRQL, computes cost/efficiency deltas for the current branch, and emits a formatted markdown report. A GitHub Actions composite action wraps the CLI and posts the report as a PR comment. A GitLab CI job template does the same.

---

## Background reading

Before starting, read these files:

- `packages/nr-ai-mcp-server/scripts/deploy-dashboard.ts` — NerdGraph query pattern, `fetch()` call structure
- `packages/nr-ai-mcp-server/src/config.ts` — `loadMcpConfig()`, env var naming conventions
- `packages/shared/src/transport/http-client.ts` — HTTP client pattern used in the shared package
- Root `package.json` — workspace structure (`"workspaces": ["packages/*"]`)
- Root `tsconfig.json` — project references pattern; the new package must add itself here

---

## Step 1 — Create the new package

### `packages/nr-ai-cicd/package.json`

```json
{
  "name": "nr-ai-cicd",
  "version": "0.1.0",
  "type": "module",
  "description": "CI/CD integration for NR AI Observatory — posts AI coding cost reports to PRs",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "nr-ai-report": "dist/report-cli.js"
  },
  "scripts": {
    "test": "jest --passWithNoTests"
  },
  "dependencies": {
    "@nr-ai-observatory/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

### `packages/nr-ai-cicd/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "declarationDir": "dist"
  },
  "references": [
    { "path": "../shared" }
  ],
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

> Check the root `tsconfig.base.json` to confirm the `extends` path is correct.

### Add to root `tsconfig.json`

In the root `tsconfig.json`, add `packages/nr-ai-cicd` to the `references` array:

```json
{ "path": "packages/nr-ai-cicd" }
```

---

## Step 2 — Create `src/nrql-client.ts`

A thin NRQL query executor. Reuses the same NerdGraph pattern as the deploy scripts.

```typescript
const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

const NRQL_QUERY = `
query NrqlQuery($accountId: Int!, $nrql: String!) {
  actor {
    account(id: $accountId) {
      nrql(query: $nrql) {
        results
      }
    }
  }
}`;

interface NrqlResult {
  actor: {
    account: {
      nrql: {
        results: Array<Record<string, unknown>>;
      };
    };
  };
}

export async function runNrql(
  apiKey: string,
  accountId: number,
  nrql: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
    body: JSON.stringify({ query: NRQL_QUERY, variables: { accountId, nrql } }),
  });
  if (!resp.ok) {
    throw new Error(`NerdGraph HTTP ${resp.status}: ${await resp.text()}`);
  }
  const json = await resp.json() as {
    data?: NrqlResult;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(`NerdGraph errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  return json.data?.actor.account.nrql.results ?? [];
}
```

---

## Step 3 — Create `src/metrics-fetcher.ts`

Fetches the three sets of data needed for the report: current session metrics, 7-day baseline, and top anti-patterns. Each function takes `apiKey`, `accountId`, and `developer` (string).

```typescript
import { runNrql } from './nrql-client.js';

export interface SessionMetrics {
  totalCostUsd: number;
  efficiencyScore: number | null;
  sessionCount: number;
  topAntiPatterns: Array<{ type: string; count: number }>;
  modelBreakdown: Array<{ model: string; costUsd: number }>;
}

export interface BaselineMetrics {
  avgDailyCostUsd: number;
  avgEfficiencyScore: number | null;
}

export async function fetchCurrentMetrics(
  apiKey: string,
  accountId: number,
  developer: string,
  sinceHours: number,
): Promise<SessionMetrics> {
  // Cost
  const costRows = await runNrql(
    apiKey,
    accountId,
    `SELECT sum(numeric(cost.totalUsd)) AS totalCost
     FROM Metric
     WHERE metricName = 'ai.cost.session' AND developer = '${developer}'
     SINCE ${sinceHours} hours ago`,
  );
  const totalCostUsd = Number(costRows[0]?.totalCost ?? 0);

  // Efficiency
  const effRows = await runNrql(
    apiKey,
    accountId,
    `SELECT average(numeric(efficiency.score)) AS avgScore
     FROM Metric
     WHERE metricName = 'ai.efficiency.score' AND developer = '${developer}'
     SINCE ${sinceHours} hours ago`,
  );
  const efficiencyScore =
    effRows[0]?.avgScore != null ? Number(effRows[0].avgScore) : null;

  // Session count
  const sessionRows = await runNrql(
    apiKey,
    accountId,
    `SELECT uniqueCount(sessionId) AS sessions
     FROM AiToolCall
     WHERE developer = '${developer}'
     SINCE ${sinceHours} hours ago`,
  );
  const sessionCount = Number(sessionRows[0]?.sessions ?? 0);

  // Top anti-patterns
  const patternRows = await runNrql(
    apiKey,
    accountId,
    `SELECT count(*) AS cnt, patternType
     FROM AiAntiPattern
     WHERE developer = '${developer}'
     SINCE ${sinceHours} hours ago
     FACET patternType
     LIMIT 5`,
  );
  const topAntiPatterns = patternRows.map(r => ({
    type: String(r.patternType ?? 'unknown'),
    count: Number(r.cnt ?? 0),
  }));

  // Model breakdown
  const modelRows = await runNrql(
    apiKey,
    accountId,
    `SELECT sum(numeric(cost.totalUsd)) AS cost, model
     FROM Metric
     WHERE metricName = 'ai.cost.session' AND developer = '${developer}'
     SINCE ${sinceHours} hours ago
     FACET model
     LIMIT 10`,
  );
  const modelBreakdown = modelRows.map(r => ({
    model: String(r.model ?? 'unknown'),
    costUsd: Number(r.cost ?? 0),
  }));

  return { totalCostUsd, efficiencyScore, sessionCount, topAntiPatterns, modelBreakdown };
}

export async function fetchBaselineMetrics(
  apiKey: string,
  accountId: number,
  developer: string,
): Promise<BaselineMetrics> {
  const costRows = await runNrql(
    apiKey,
    accountId,
    `SELECT sum(numeric(cost.totalUsd)) / 7 AS avgDailyCost
     FROM Metric
     WHERE metricName = 'ai.cost.session' AND developer = '${developer}'
     SINCE 7 days ago`,
  );
  const avgDailyCostUsd = Number(costRows[0]?.avgDailyCost ?? 0);

  const effRows = await runNrql(
    apiKey,
    accountId,
    `SELECT average(numeric(efficiency.score)) AS avgScore
     FROM Metric
     WHERE metricName = 'ai.efficiency.score' AND developer = '${developer}'
     SINCE 7 days ago`,
  );
  const avgEfficiencyScore =
    effRows[0]?.avgScore != null ? Number(effRows[0].avgScore) : null;

  return { avgDailyCostUsd, avgEfficiencyScore };
}
```

---

## Step 4 — Create `src/report-formatter.ts`

Converts fetched metrics into a markdown string suitable for a GitHub PR comment.

```typescript
import type { SessionMetrics, BaselineMetrics } from './metrics-fetcher.js';

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatDelta(current: number, baseline: number): string {
  if (baseline === 0) return '—';
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function efficiencyEmoji(score: number | null): string {
  if (score === null) return '—';
  if (score >= 70) return '🟢';
  if (score >= 40) return '🟡';
  return '🔴';
}

export function formatReport(
  current: SessionMetrics,
  baseline: BaselineMetrics,
  sinceHours: number,
  developer: string,
): string {
  const effScore = current.efficiencyScore !== null
    ? `${efficiencyEmoji(current.efficiencyScore)} ${current.efficiencyScore.toFixed(1)}/100`
    : '—';

  const baselineEffStr = baseline.avgEfficiencyScore !== null
    ? baseline.avgEfficiencyScore.toFixed(1)
    : '—';

  const lines: string[] = [
    `## 🤖 AI Coding Assistant Report`,
    ``,
    `_Developer: \`${developer}\` · Window: last ${sinceHours}h · Baseline: 7-day average_`,
    ``,
    `| Metric | This Period | 7-day Baseline | Delta |`,
    `|--------|-------------|----------------|-------|`,
    `| Cost | ${formatCost(current.totalCostUsd)} | ${formatCost(baseline.avgDailyCostUsd)}/day | ${formatDelta(current.totalCostUsd, baseline.avgDailyCostUsd)} |`,
    `| Efficiency Score | ${effScore} | ${baselineEffStr} | — |`,
    `| Sessions | ${current.sessionCount} | — | — |`,
    ``,
  ];

  if (current.topAntiPatterns.length > 0) {
    lines.push(`### Anti-patterns detected`);
    lines.push(``);
    for (const p of current.topAntiPatterns) {
      lines.push(`- \`${p.type}\`: ${p.count}×`);
    }
    lines.push(``);
  }

  if (current.modelBreakdown.length > 0) {
    lines.push(`### Model usage`);
    lines.push(``);
    lines.push(`| Model | Cost |`);
    lines.push(`|-------|------|`);
    for (const m of current.modelBreakdown) {
      lines.push(`| \`${m.model}\` | ${formatCost(m.costUsd)} |`);
    }
    lines.push(``);
  }

  lines.push(`_Generated by [NR AI Observatory](https://github.com/cdehaan/nr-ai-observatory)_`);

  return lines.join('\n');
}
```

---

## Step 5 — Create `src/report-cli.ts`

The CLI entry point. Accepts flags, fetches data, and writes the markdown to stdout (so it can be piped to `gh pr comment`).

```typescript
#!/usr/bin/env node
/**
 * nr-ai-report — fetch AI coding metrics from New Relic and output a markdown report.
 *
 * Usage:
 *   NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 nr-ai-report [options]
 *
 * Options:
 *   --developer <name>   Developer name (default: $USER or git config user.name)
 *   --since-hours <n>    Look-back window in hours (default: 24)
 *   --fail-below <n>     Exit 1 if efficiency score is below this value (optional)
 *   --output <path>      Write markdown to file instead of stdout
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fetchCurrentMetrics, fetchBaselineMetrics } from './metrics-fetcher.js';
import { formatReport } from './report-formatter.js';

function inferDeveloper(): string {
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  if (process.env.GITHUB_ACTOR) return process.env.GITHUB_ACTOR;
  try {
    return execSync('git config user.name', { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv: string[]): {
  developer: string;
  sinceHours: number;
  failBelow: number | null;
  outputPath: string | null;
} {
  const args = argv.slice(2);
  let developer = inferDeveloper();
  let sinceHours = 24;
  let failBelow: number | null = null;
  let outputPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--developer' && args[i + 1]) {
      developer = args[++i];
    } else if (args[i] === '--since-hours' && args[i + 1]) {
      sinceHours = parseInt(args[++i], 10);
    } else if (args[i] === '--fail-below' && args[i + 1]) {
      failBelow = parseFloat(args[++i]);
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    }
  }

  return { developer, sinceHours, failBelow, outputPath };
}

async function main(): Promise<void> {
  const apiKey = process.env.NEW_RELIC_API_KEY;
  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;

  if (!apiKey) {
    process.stderr.write('Error: NEW_RELIC_API_KEY is required\n');
    process.exit(1);
  }
  if (!accountIdStr) {
    process.stderr.write('Error: NEW_RELIC_ACCOUNT_ID is required\n');
    process.exit(1);
  }

  const accountId = parseInt(accountIdStr, 10);
  const { developer, sinceHours, failBelow, outputPath } = parseArgs(process.argv);

  process.stderr.write(`Fetching metrics for developer "${developer}" (last ${sinceHours}h)...\n`);

  const [current, baseline] = await Promise.all([
    fetchCurrentMetrics(apiKey, accountId, developer, sinceHours),
    fetchBaselineMetrics(apiKey, accountId, developer),
  ]);

  const report = formatReport(current, baseline, sinceHours, developer);

  if (outputPath) {
    writeFileSync(outputPath, report, 'utf-8');
    process.stderr.write(`Report written to ${outputPath}\n`);
  } else {
    process.stdout.write(report + '\n');
  }

  // Quality gate
  if (failBelow !== null && current.efficiencyScore !== null) {
    if (current.efficiencyScore < failBelow) {
      process.stderr.write(
        `Quality gate failed: efficiency score ${current.efficiencyScore.toFixed(1)} < ${failBelow}\n`,
      );
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

---

## Step 6 — Create `src/index.ts`

```typescript
export { runNrql } from './nrql-client.js';
export { fetchCurrentMetrics, fetchBaselineMetrics } from './metrics-fetcher.js';
export type { SessionMetrics, BaselineMetrics } from './metrics-fetcher.js';
export { formatReport } from './report-formatter.js';
```

---

## Step 7 — GitHub Actions composite action

Create `actions/ai-report/action.yml` in the repo root:

```yaml
name: 'NR AI Coding Report'
description: 'Posts an AI coding cost and efficiency report as a PR comment'

inputs:
  new-relic-api-key:
    description: 'New Relic User API key (NRAK-...)'
    required: true
  new-relic-account-id:
    description: 'New Relic account ID'
    required: true
  developer:
    description: 'Developer name to filter metrics (defaults to git commit author)'
    required: false
    default: ''
  since-hours:
    description: 'Look-back window in hours'
    required: false
    default: '24'
  fail-below:
    description: 'Fail the action if efficiency score is below this value (0 = disabled)'
    required: false
    default: '0'
  github-token:
    description: 'GitHub token for posting PR comment'
    required: false
    default: ${{ github.token }}

runs:
  using: 'composite'
  steps:
    - name: Install nr-ai-cicd
      shell: bash
      run: npm install -g nr-ai-cicd

    - name: Generate report
      shell: bash
      env:
        NEW_RELIC_API_KEY: ${{ inputs.new-relic-api-key }}
        NEW_RELIC_ACCOUNT_ID: ${{ inputs.new-relic-account-id }}
      run: |
        DEVELOPER_FLAG=""
        if [ -n "${{ inputs.developer }}" ]; then
          DEVELOPER_FLAG="--developer ${{ inputs.developer }}"
        fi

        FAIL_FLAG=""
        if [ "${{ inputs.fail-below }}" != "0" ]; then
          FAIL_FLAG="--fail-below ${{ inputs.fail-below }}"
        fi

        nr-ai-report \
          --since-hours "${{ inputs.since-hours }}" \
          --output /tmp/ai-report.md \
          $DEVELOPER_FLAG \
          $FAIL_FLAG

    - name: Post PR comment
      if: github.event_name == 'pull_request'
      shell: bash
      env:
        GITHUB_TOKEN: ${{ inputs.github-token }}
      run: |
        gh pr comment "${{ github.event.pull_request.number }}" \
          --body-file /tmp/ai-report.md \
          --repo "${{ github.repository }}"
```

### Example workflow usage

Create `actions/ai-report/README.md` (or add to root README) with usage example:

```yaml
# .github/workflows/ai-report.yml
name: AI Coding Report
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  ai-report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./actions/ai-report
        with:
          new-relic-api-key: ${{ secrets.NEW_RELIC_API_KEY }}
          new-relic-account-id: ${{ secrets.NEW_RELIC_ACCOUNT_ID }}
          fail-below: '30'   # optional quality gate
```

---

## Step 8 — GitLab CI job template

Create `.gitlab-ci-template.yml` in the repo root:

```yaml
# Include this template in your .gitlab-ci.yml:
#
#   include:
#     - project: 'your-org/nr-ai-observatory'
#       file: '.gitlab-ci-template.yml'
#
# Required CI/CD variables:
#   NEW_RELIC_API_KEY    — New Relic User API key
#   NEW_RELIC_ACCOUNT_ID — New Relic account ID

.nr_ai_report:
  image: node:20-alpine
  stage: test
  variables:
    NR_AI_SINCE_HOURS: "24"
    NR_AI_FAIL_BELOW: "0"
    NR_AI_DEVELOPER: ""
  script:
    - npm install -g nr-ai-cicd
    - |
      DEVELOPER_FLAG=""
      if [ -n "$NR_AI_DEVELOPER" ]; then
        DEVELOPER_FLAG="--developer $NR_AI_DEVELOPER"
      fi
      FAIL_FLAG=""
      if [ "$NR_AI_FAIL_BELOW" != "0" ]; then
        FAIL_FLAG="--fail-below $NR_AI_FAIL_BELOW"
      fi
      nr-ai-report \
        --since-hours "$NR_AI_SINCE_HOURS" \
        --output ai-report.md \
        $DEVELOPER_FLAG \
        $FAIL_FLAG
    - |
      if [ -n "$CI_MERGE_REQUEST_IID" ]; then
        curl --request POST \
          --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
          --form "body=@ai-report.md" \
          "$CI_API_V4_URL/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID/notes"
      fi
  artifacts:
    reports:
      dotenv: ai-report.md
    paths:
      - ai-report.md
    expire_in: 1 week
```

---

## Step 9 — Write tests

Create `packages/nr-ai-cicd/src/report-formatter.test.ts`:

```typescript
import { formatReport } from './report-formatter.js';
import type { SessionMetrics, BaselineMetrics } from './metrics-fetcher.js';

function makeCurrentMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    totalCostUsd: 1.23,
    efficiencyScore: 72,
    sessionCount: 3,
    topAntiPatterns: [{ type: 'thrashing', count: 2 }],
    modelBreakdown: [{ model: 'claude-sonnet-4-6', costUsd: 1.23 }],
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<BaselineMetrics> = {}): BaselineMetrics {
  return {
    avgDailyCostUsd: 0.80,
    avgEfficiencyScore: 65,
    ...overrides,
  };
}

describe('formatReport', () => {
  it('produces a markdown string with a heading', () => {
    const report = formatReport(makeCurrentMetrics(), makeBaseline(), 24, 'alice');
    expect(report).toContain('## 🤖 AI Coding Assistant Report');
    expect(report).toContain('alice');
  });

  it('includes cost in the table', () => {
    const report = formatReport(makeCurrentMetrics({ totalCostUsd: 2.5 }), makeBaseline(), 24, 'bob');
    expect(report).toContain('$2.5000');
  });

  it('includes efficiency score with green emoji for high scores', () => {
    const report = formatReport(makeCurrentMetrics({ efficiencyScore: 75 }), makeBaseline(), 24, 'x');
    expect(report).toContain('🟢');
  });

  it('uses yellow emoji for mid-range efficiency', () => {
    const report = formatReport(makeCurrentMetrics({ efficiencyScore: 50 }), makeBaseline(), 24, 'x');
    expect(report).toContain('🟡');
  });

  it('uses red emoji for low efficiency', () => {
    const report = formatReport(makeCurrentMetrics({ efficiencyScore: 20 }), makeBaseline(), 24, 'x');
    expect(report).toContain('🔴');
  });

  it('handles null efficiency score', () => {
    const report = formatReport(makeCurrentMetrics({ efficiencyScore: null }), makeBaseline({ avgEfficiencyScore: null }), 24, 'x');
    expect(report).not.toContain('undefined');
  });

  it('lists anti-patterns when present', () => {
    const report = formatReport(makeCurrentMetrics(), makeBaseline(), 24, 'x');
    expect(report).toContain('thrashing');
    expect(report).toContain('2×');
  });

  it('omits anti-patterns section when none detected', () => {
    const report = formatReport(makeCurrentMetrics({ topAntiPatterns: [] }), makeBaseline(), 24, 'x');
    expect(report).not.toContain('Anti-patterns');
  });
});
```

---

## Acceptance criteria

- [ ] `npm run build` passes with no TypeScript errors (including the new `nr-ai-cicd` package)
- [ ] `npm test` passes — all `report-formatter.test.ts` assertions pass
- [ ] `nr-ai-report --help` (or running with no required env) prints a useful error, not a stack trace
- [ ] `nr-ai-report` with valid env vars outputs valid markdown to stdout
- [ ] `--output path/to/file` writes markdown to the specified file
- [ ] `--fail-below 30` exits 1 when efficiency score is below 30, exits 0 when above
- [ ] GitHub Actions `action.yml` is syntactically valid YAML
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-cicd/package.json
packages/nr-ai-cicd/tsconfig.json
packages/nr-ai-cicd/src/nrql-client.ts
packages/nr-ai-cicd/src/metrics-fetcher.ts
packages/nr-ai-cicd/src/report-formatter.ts
packages/nr-ai-cicd/src/report-formatter.test.ts
packages/nr-ai-cicd/src/report-cli.ts
packages/nr-ai-cicd/src/index.ts
actions/ai-report/action.yml
.gitlab-ci-template.yml
```

Files to **modify**:

```
tsconfig.json   — add packages/nr-ai-cicd to references array
```
