# Implementation Plan: Cost Budgets and Forecasting

**Roadmap item:** [04 — Cost Budgets and Forecasting](../../ROADMAP.md#4-cost-budgets-and-forecasting)
**Effort estimate:** ~1 day
**Prerequisites:** Read `packages/nr-ai-mcp-server/src/metrics/cost-tracker.ts`, `packages/nr-ai-mcp-server/src/config.ts`, `packages/nr-ai-mcp-server/src/tools/cost-tools.ts`, and `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts` before starting.

---

## Goal

Add per-session and per-day budget caps to `McpServerConfig`. Introduce a `BudgetTracker` class that monitors accumulated cost against those caps and emits warning events to New Relic when thresholds are crossed (50%, 80%, 100%). Expose two new MCP tools: `nr_observe_get_budget_status` and `nr_observe_get_cost_forecast`.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-mcp-server/src/metrics/cost-tracker.ts` — `CostTracker.getMetrics()` shape; `BudgetTracker` will depend on this
- `packages/nr-ai-mcp-server/src/config.ts` — `McpServerConfig` interface and `loadMcpConfig()` function; budget fields go here
- `packages/nr-ai-mcp-server/src/tools/cost-tools.ts` — pattern for registering new cost-related MCP tools
- `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts` — `NrIngestOptions` and `ingestToolCall()`; the budget tracker hooks in here
- `packages/nr-ai-mcp-server/src/index.ts` — where all trackers are instantiated and wired together

---

## Step 1 — Add budget fields to `McpServerConfig`

Open `packages/nr-ai-mcp-server/src/config.ts`.

### 1a — Add to the `McpServerConfig` interface

Add these fields after the `harvestIntervalMs` field:

```typescript
readonly sessionBudgetUsd: number | null;
readonly dailyBudgetUsd: number | null;
readonly weeklyBudgetUsd: number | null;
```

### 1b — Add env/file loading in `loadMcpConfig()`

In the `config` object construction block, after `harvestIntervalMs`, add:

```typescript
sessionBudgetUsd:
  process.env.NEW_RELIC_AI_SESSION_BUDGET_USD
    ? parseFloat(process.env.NEW_RELIC_AI_SESSION_BUDGET_USD)
    : (typeof file.sessionBudgetUsd === 'number' ? file.sessionBudgetUsd : null),

dailyBudgetUsd:
  process.env.NEW_RELIC_AI_DAILY_BUDGET_USD
    ? parseFloat(process.env.NEW_RELIC_AI_DAILY_BUDGET_USD)
    : (typeof file.dailyBudgetUsd === 'number' ? file.dailyBudgetUsd : null),

weeklyBudgetUsd:
  process.env.NEW_RELIC_AI_WEEKLY_BUDGET_USD
    ? parseFloat(process.env.NEW_RELIC_AI_WEEKLY_BUDGET_USD)
    : (typeof file.weeklyBudgetUsd === 'number' ? file.weeklyBudgetUsd : null),
```

> Budget fields are optional (`null` = no limit). Do not validate them as required — the server must still start if they're absent.

### 1c — Update the debug log at the end of `loadMcpConfig()`

Add `sessionBudgetUsd`, `dailyBudgetUsd`, `weeklyBudgetUsd` to the `logger.debug('Configuration loaded', ...)` call.

---

## Step 2 — Create `BudgetTracker`

Create `packages/nr-ai-mcp-server/src/metrics/budget-tracker.ts`.

### Interface definitions

```typescript
export type BudgetPeriod = 'session' | 'daily' | 'weekly';

export interface BudgetThresholdEvent {
  readonly period: BudgetPeriod;
  readonly thresholdPct: 50 | 80 | 100;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly timestamp: number;
}

export interface BudgetStatus {
  readonly session: {
    readonly budgetUsd: number | null;
    readonly spentUsd: number;
    readonly remainingUsd: number | null;
    readonly pctUsed: number | null;
    readonly exceeded: boolean;
  };
  readonly daily: {
    readonly budgetUsd: number | null;
    readonly spentUsd: number;
    readonly remainingUsd: number | null;
    readonly pctUsed: number | null;
    readonly exceeded: boolean;
  };
  readonly weekly: {
    readonly budgetUsd: number | null;
    readonly spentUsd: number;
    readonly remainingUsd: number | null;
    readonly pctUsed: number | null;
    readonly exceeded: boolean;
  };
  readonly alerts: readonly BudgetThresholdEvent[];
}

export interface BudgetOptions {
  readonly sessionBudgetUsd: number | null;
  readonly dailyBudgetUsd: number | null;
  readonly weeklyBudgetUsd: number | null;
  readonly onThreshold?: (event: BudgetThresholdEvent) => void;
}
```

### Class implementation

```typescript
const THRESHOLD_LEVELS: Array<50 | 80 | 100> = [50, 80, 100];

export class BudgetTracker {
  private readonly sessionBudgetUsd: number | null;
  private readonly dailyBudgetUsd: number | null;
  private readonly weeklyBudgetUsd: number | null;
  private readonly onThreshold: ((event: BudgetThresholdEvent) => void) | undefined;

  private sessionSpentUsd = 0;
  private dailySpentUsd = 0;
  private weeklySpentUsd = 0;

  // Tracks which thresholds have already fired to avoid duplicate events
  private firedThresholds = new Set<string>(); // `${period}_${pct}`
  private alerts: BudgetThresholdEvent[] = [];

  constructor(options: BudgetOptions) {
    this.sessionBudgetUsd = options.sessionBudgetUsd;
    this.dailyBudgetUsd = options.dailyBudgetUsd;
    this.weeklyBudgetUsd = options.weeklyBudgetUsd;
    this.onThreshold = options.onThreshold;
  }

  /** Call this every time the cost tracker reports new tokens/costs. */
  updateCost(sessionCostUsd: number, dailyCostUsd: number, weeklyCostUsd: number): void {
    this.sessionSpentUsd = sessionCostUsd;
    this.dailySpentUsd = dailyCostUsd;
    this.weeklySpentUsd = weeklyCostUsd;
    this.checkThresholds();
  }

  private checkThresholds(): void {
    this.checkPeriod('session', this.sessionSpentUsd, this.sessionBudgetUsd);
    this.checkPeriod('daily', this.dailySpentUsd, this.dailyBudgetUsd);
    this.checkPeriod('weekly', this.weeklySpentUsd, this.weeklyBudgetUsd);
  }

  private checkPeriod(
    period: BudgetPeriod,
    spent: number,
    budget: number | null,
  ): void {
    if (budget === null || budget <= 0) return;
    const pctUsed = (spent / budget) * 100;
    for (const level of THRESHOLD_LEVELS) {
      const key = `${period}_${level}`;
      if (pctUsed >= level && !this.firedThresholds.has(key)) {
        this.firedThresholds.add(key);
        const event: BudgetThresholdEvent = {
          period,
          thresholdPct: level,
          spentUsd: spent,
          budgetUsd: budget,
          timestamp: Date.now(),
        };
        this.alerts.push(event);
        this.onThreshold?.(event);
      }
    }
  }

  getStatus(): BudgetStatus {
    return {
      session: this.buildPeriodStatus(this.sessionSpentUsd, this.sessionBudgetUsd),
      daily: this.buildPeriodStatus(this.dailySpentUsd, this.dailyBudgetUsd),
      weekly: this.buildPeriodStatus(this.weeklySpentUsd, this.weeklyBudgetUsd),
      alerts: [...this.alerts],
    };
  }

  private buildPeriodStatus(spent: number, budget: number | null) {
    if (budget === null) {
      return {
        budgetUsd: null,
        spentUsd: spent,
        remainingUsd: null,
        pctUsed: null,
        exceeded: false,
      };
    }
    const remaining = Math.max(0, budget - spent);
    const pctUsed = (spent / budget) * 100;
    return {
      budgetUsd: budget,
      spentUsd: spent,
      remainingUsd: remaining,
      pctUsed,
      exceeded: spent > budget,
    };
  }

  resetSession(): void {
    this.sessionSpentUsd = 0;
    // Clear session-level fired thresholds only
    for (const key of this.firedThresholds) {
      if (key.startsWith('session_')) this.firedThresholds.delete(key);
    }
    this.alerts = this.alerts.filter(a => a.period !== 'session');
  }
}
```

---

## Step 3 — Add cost forecast logic

Create `packages/nr-ai-mcp-server/src/metrics/cost-forecast.ts`.

The forecast is a simple linear extrapolation: given `spentUsd` over `elapsedMs`, project the cost at `targetMs` (e.g., end of day, end of session).

```typescript
export interface CostForecast {
  readonly elapsedMs: number;
  readonly spentUsd: number;
  readonly rateUsdPerMs: number;
  readonly forecastEndOfDayUsd: number | null;
  readonly forecastEndOfWeekUsd: number | null;
  readonly forecastSessionEndUsd: number | null;
  readonly confidenceNote: string;
}

export function buildCostForecast(
  spentUsd: number,
  sessionStartMs: number,
  nowMs: number = Date.now(),
): CostForecast {
  const elapsedMs = nowMs - sessionStartMs;
  if (elapsedMs <= 0 || spentUsd <= 0) {
    return {
      elapsedMs: 0,
      spentUsd: 0,
      rateUsdPerMs: 0,
      forecastEndOfDayUsd: null,
      forecastEndOfWeekUsd: null,
      forecastSessionEndUsd: null,
      confidenceNote: 'Insufficient data for forecast.',
    };
  }

  const rateUsdPerMs = spentUsd / elapsedMs;

  // End of current UTC day
  const now = new Date(nowMs);
  const endOfDay = new Date(now);
  endOfDay.setUTCHours(23, 59, 59, 999);
  const msUntilEndOfDay = endOfDay.getTime() - nowMs;
  const forecastEndOfDayUsd = spentUsd + rateUsdPerMs * msUntilEndOfDay;

  // End of current UTC week (Sunday)
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  const msUntilEndOfWeek = (6 - dayOfWeek) * 86_400_000 + msUntilEndOfDay;
  const forecastEndOfWeekUsd = spentUsd + rateUsdPerMs * msUntilEndOfWeek;

  // Typical session end (8 hours from start)
  const SESSION_TARGET_MS = 8 * 60 * 60 * 1000;
  const msUntilSessionEnd = Math.max(0, SESSION_TARGET_MS - elapsedMs);
  const forecastSessionEndUsd = spentUsd + rateUsdPerMs * msUntilSessionEnd;

  const elapsedMinutes = elapsedMs / 60_000;
  const confidenceNote =
    elapsedMinutes < 10
      ? 'Low confidence — less than 10 minutes of data.'
      : elapsedMinutes < 30
        ? 'Moderate confidence — based on less than 30 minutes of data.'
        : 'Reasonable confidence — based on 30+ minutes of data.';

  return {
    elapsedMs,
    spentUsd,
    rateUsdPerMs,
    forecastEndOfDayUsd,
    forecastEndOfWeekUsd,
    forecastSessionEndUsd,
    confidenceNote,
  };
}
```

---

## Step 4 — Add NrIngest budget warning events

Open `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts`.

### 4a — Add `budgetTracker` to `NrIngestOptions`

```typescript
/** Budget tracker for emitting budget threshold warning events. */
budgetTracker?: BudgetTracker;
```

Import `BudgetTracker` and `BudgetThresholdEvent` from `'../metrics/budget-tracker.js'`.

### 4b — Add `ingestBudgetWarning()` method

```typescript
ingestBudgetWarning(event: BudgetThresholdEvent): void {
  const nrEvent: NrEventData = {
    eventType: 'AiBudgetWarning',
    timestamp: event.timestamp,
    developer: this.developer,
    appName: this.appName,
    budgetPeriod: event.period,
    thresholdPct: event.thresholdPct,
    spentUsd: event.spentUsd,
    budgetUsd: event.budgetUsd,
    remainingUsd: Math.max(0, event.budgetUsd - event.spentUsd),
  };
  this.harvester.enqueueEvent(nrEvent);
}
```

---

## Step 5 — Add MCP tool handlers

Open `packages/nr-ai-mcp-server/src/tools/cost-tools.ts`.

### 5a — Add `BUDGET_STATUS_TOOL` definition

```typescript
export const BUDGET_STATUS_TOOL = {
  name: 'nr_observe_get_budget_status',
  description:
    'Get current AI spend vs. configured budget caps (session, daily, weekly). Returns remaining budget, % used, and any threshold alerts fired this session.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};
```

### 5b — Add `COST_FORECAST_TOOL` definition

```typescript
export const COST_FORECAST_TOOL = {
  name: 'nr_observe_get_cost_forecast',
  description:
    'Project AI spending forward based on current session rate. Returns forecast cost for end-of-day, end-of-week, and end-of-session (8h), with a confidence note.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  annotations: { readOnlyHint: true },
};
```

### 5c — Add handler functions

Import `BudgetTracker` and `buildCostForecast` at the top of the file.

```typescript
export function handleGetBudgetStatus(
  budgetTracker: BudgetTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  const status = budgetTracker.getStatus();
  return { content: [{ type: 'text', text: JSON.stringify(status) }] };
}

export function handleGetCostForecast(
  costTracker: CostTracker, // existing import
  sessionStartMs: number,
): { content: Array<{ type: 'text'; text: string }> } {
  const metrics = costTracker.getMetrics();
  const spentUsd = metrics.sessionTotalCostUsd ?? 0;
  const forecast = buildCostForecast(spentUsd, sessionStartMs);
  return { content: [{ type: 'text', text: JSON.stringify(forecast) }] };
}
```

---

## Step 6 — Register the new tools in `registerTools()`

Open `packages/nr-ai-mcp-server/src/tools/session-stats.ts`.

### 6a — Update the `RegisterToolsOptions` interface

Add:

```typescript
budgetTracker?: BudgetTracker;
sessionStartMs?: number;
```

### 6b — Import new tool definitions and handlers from `cost-tools.ts`

```typescript
import {
  // existing imports ...
  BUDGET_STATUS_TOOL,
  COST_FORECAST_TOOL,
  handleGetBudgetStatus,
  handleGetCostForecast,
} from './cost-tools.js';
```

### 6c — Register the tools in `registerTools()`

Inside `registerTools()`, after the existing cost tools registration, add:

```typescript
if (options.budgetTracker) {
  toolList.push(BUDGET_STATUS_TOOL);
}
if (options.costTracker && options.sessionStartMs !== undefined) {
  toolList.push(COST_FORECAST_TOOL);
}
```

And in the `CallToolRequestSchema` handler's switch/map:

```typescript
case 'nr_observe_get_budget_status':
  if (!options.budgetTracker) throw new McpError(ErrorCode.MethodNotFound, 'Budget tracker not configured');
  return handleGetBudgetStatus(options.budgetTracker);

case 'nr_observe_get_cost_forecast':
  if (!options.costTracker || options.sessionStartMs === undefined) {
    throw new McpError(ErrorCode.MethodNotFound, 'Cost tracker or session start time not configured');
  }
  return handleGetCostForecast(options.costTracker, options.sessionStartMs);
```

---

## Step 7 — Wire everything together in `index.ts`

Open `packages/nr-ai-mcp-server/src/index.ts`.

### 7a — Instantiate `BudgetTracker`

After `const efficiencyScorer = new EfficiencyScorer();`, add:

```typescript
const sessionStartMs = Date.now();

const budgetTracker = new BudgetTracker({
  sessionBudgetUsd: config.sessionBudgetUsd,
  dailyBudgetUsd: config.dailyBudgetUsd,
  weeklyBudgetUsd: config.weeklyBudgetUsd,
  onThreshold: (event) => {
    capturedNrIngest.ingestBudgetWarning(event);
    logger.warn('Budget threshold reached', {
      period: event.period,
      pct: event.thresholdPct,
      spentUsd: event.spentUsd.toFixed(4),
      budgetUsd: event.budgetUsd.toFixed(2),
    });
  },
});
```

> Note: `capturedNrIngest` is already used in the `onRecord` closure pattern. Follow the same capture pattern here.

### 7b — Update cost accumulation in `onRecord`

Inside the `onRecord` callback (where `costTracker.recordEstimatedTokens` is called), add after any cost tracker update:

```typescript
const costMetrics = costTracker.getMetrics();
if (costMetrics.sessionTotalCostUsd !== null) {
  budgetTracker.updateCost(
    costMetrics.sessionTotalCostUsd,
    costMetrics.sessionTotalCostUsd, // daily is approximated by session until cross-session cost tracking lands
    costMetrics.sessionTotalCostUsd, // same for weekly
  );
}
```

### 7c — Pass to `registerTools()`

Add `budgetTracker` and `sessionStartMs` to the `registerTools()` call:

```typescript
registerTools(mcpServer.server, {
  // ... existing options ...
  budgetTracker,
  sessionStartMs,
});
```

### 7d — Pass to `NrIngestManager`

Add `budgetTracker` to the `NrIngestManager` constructor options:

```typescript
nrIngest = new NrIngestManager({
  // ... existing options ...
  budgetTracker,
});
```

---

## Step 8 — Write tests

### `packages/nr-ai-mcp-server/src/metrics/budget-tracker.test.ts`

Key cases:

```typescript
import { BudgetTracker } from './budget-tracker.js';

describe('BudgetTracker', () => {
  it('returns null status when no budgets configured', () => {
    const t = new BudgetTracker({ sessionBudgetUsd: null, dailyBudgetUsd: null, weeklyBudgetUsd: null });
    const s = t.getStatus();
    expect(s.session.budgetUsd).toBeNull();
    expect(s.session.pctUsed).toBeNull();
    expect(s.session.exceeded).toBe(false);
  });

  it('tracks pctUsed correctly', () => {
    const t = new BudgetTracker({ sessionBudgetUsd: 10, dailyBudgetUsd: null, weeklyBudgetUsd: null });
    t.updateCost(5, 0, 0);
    expect(t.getStatus().session.pctUsed).toBeCloseTo(50);
  });

  it('fires 50% threshold callback once', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: e => events.push(e),
    });
    t.updateCost(5, 0, 0);
    t.updateCost(5.1, 0, 0); // still above 50%, should not fire again
    expect(events).toHaveLength(1);
    expect((events[0] as { thresholdPct: number }).thresholdPct).toBe(50);
  });

  it('fires 80% and 100% thresholds independently', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: e => events.push(e),
    });
    t.updateCost(8, 0, 0); // 80%
    t.updateCost(10, 0, 0); // 100%
    expect(events).toHaveLength(2);
  });

  it('marks exceeded when spent > budget', () => {
    const t = new BudgetTracker({ sessionBudgetUsd: 5, dailyBudgetUsd: null, weeklyBudgetUsd: null });
    t.updateCost(6, 0, 0);
    expect(t.getStatus().session.exceeded).toBe(true);
    expect(t.getStatus().session.remainingUsd).toBe(0);
  });

  it('resetSession clears session spend and re-arms thresholds', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: e => events.push(e),
    });
    t.updateCost(6, 0, 0); // fires 50%
    t.resetSession();
    t.updateCost(6, 0, 0); // should fire 50% again
    expect(events).toHaveLength(2);
  });
});
```

### `packages/nr-ai-mcp-server/src/metrics/cost-forecast.test.ts`

```typescript
import { buildCostForecast } from './cost-forecast.js';

describe('buildCostForecast', () => {
  it('returns zero-state for no spend', () => {
    const f = buildCostForecast(0, Date.now() - 60_000);
    expect(f.forecastEndOfDayUsd).toBeNull();
  });

  it('returns a positive end-of-day forecast for ongoing spend', () => {
    const startMs = Date.now() - 30 * 60_000; // 30 minutes ago
    const f = buildCostForecast(1.5, startMs);
    expect(f.forecastEndOfDayUsd).toBeGreaterThan(1.5);
    expect(f.rateUsdPerMs).toBeGreaterThan(0);
  });

  it('confidenceNote mentions low confidence for <10 minutes', () => {
    const startMs = Date.now() - 5 * 60_000;
    const f = buildCostForecast(0.1, startMs);
    expect(f.confidenceNote).toMatch(/Low confidence/i);
  });
});
```

### `packages/nr-ai-mcp-server/src/config.test.ts`

The existing config test file should already exist. Add cases:

- `sessionBudgetUsd` loaded from env var `NEW_RELIC_AI_SESSION_BUDGET_USD=5.00` → `5.0`
- `dailyBudgetUsd` loaded from config file `{ "dailyBudgetUsd": 20 }` → `20`
- Budget fields default to `null` when absent

---

## Acceptance criteria

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — all `budget-tracker.test.ts` and `cost-forecast.test.ts` assertions pass
- [ ] `McpServerConfig` has `sessionBudgetUsd`, `dailyBudgetUsd`, `weeklyBudgetUsd` fields (all nullable)
- [ ] Setting `NEW_RELIC_AI_SESSION_BUDGET_USD=5` in env and spending $5 in a session triggers a `100%` threshold callback
- [ ] `nr_observe_get_budget_status` tool is registered and returns `BudgetStatus` JSON
- [ ] `nr_observe_get_cost_forecast` tool is registered and returns `CostForecast` JSON
- [ ] Budget threshold events are emitted to NR as `AiBudgetWarning` event type
- [ ] Tools are absent (not registered) when `budgetTracker` is not configured
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/metrics/budget-tracker.ts
packages/nr-ai-mcp-server/src/metrics/budget-tracker.test.ts
packages/nr-ai-mcp-server/src/metrics/cost-forecast.ts
packages/nr-ai-mcp-server/src/metrics/cost-forecast.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/config.ts              — add 3 budget fields
packages/nr-ai-mcp-server/src/tools/cost-tools.ts    — add 2 tool definitions + handlers
packages/nr-ai-mcp-server/src/tools/session-stats.ts — register new tools
packages/nr-ai-mcp-server/src/transport/nr-ingest.ts — add budgetTracker + ingestBudgetWarning()
packages/nr-ai-mcp-server/src/index.ts               — instantiate + wire BudgetTracker
packages/nr-ai-mcp-server/src/config.test.ts         — add budget field tests
```
