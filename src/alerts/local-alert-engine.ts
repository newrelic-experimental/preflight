import { createLogger } from '../shared/index.js';

import type { AlertEvent } from '../dashboard/live-event-bus.js';
import type { SnapshotWindowSpec } from './alert-snapshot-collector.js';
import type { OsNotifier } from './os-notifier.js';
import type {
  LocalAlertRule,
  BudgetSessionRule,
  BudgetDailyRule,
  BudgetWeeklyRule,
  CostWindowRule,
  EfficiencyBelowRule,
  AntiPatternCountRule,
  LatencyPercentileRule,
  ToolFailureRule,
  AlertOperator,
} from './local-alert-rule.js';

const logger = createLogger('local-alert-engine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// AlertSnapshot lives in alert-snapshot-collector.ts. Re-exported here to
// keep Phase 1 imports stable.
export type { AlertSnapshot } from './alert-snapshot-collector.js';
import type { AlertSnapshot } from './alert-snapshot-collector.js';

export interface LocalAlertEngineOptions {
  readonly clock?: () => number;
  /**
   * Optional OS notifier. When present AND `osNotificationsEnabled` is true
   * AND the firing rule's `channels` includes `'os'`, the engine fires an
   * out-of-band OS notification. Notifier failures are swallowed by
   * OsNotifier itself; this engine never awaits the call.
   */
  readonly osNotifier?: OsNotifier;
  /**
   * Master switch from `config.alerts.osNotifications`. When false (the
   * default) OS notifications are suppressed even if a rule opts into the
   * `'os'` channel.
   */
  readonly osNotificationsEnabled?: boolean;
}

type BudgetPeriod = 'session' | 'daily' | 'weekly';

function budgetPeriodForRule(
  rule: BudgetSessionRule | BudgetDailyRule | BudgetWeeklyRule,
): BudgetPeriod {
  switch (rule.type) {
    case 'budget.session':
      return 'session';
    case 'budget.daily':
      return 'daily';
    case 'budget.weekly':
      return 'weekly';
  }
}

// Internal per-rule state. Budget rules and threshold rules share this
// shape. The engine uses:
// - `status` to dedupe (a rule that's firing shouldn't re-fire) and to
//   know whether to emit a `cleared` event when the condition resolves.
// - `lastFiredAt` for the firedAt timestamp on cleared events.
// - `lastClearedAt` for post-clear deduplication (`deduplicateSeconds`).
// - `firstBelowAt` is only used by `efficiency.below` to track when the
//   sustained-below window started. Reset whenever the underlying
//   condition is no longer true.
// - `firedPeriodKey` is only used by `budget.*` rules for per-period dedup.
interface RuleState {
  status: 'idle' | 'firing';
  lastFiredAt: number;
  lastClearedAt: number;
  firedPeriodKey?: string;
  firstBelowAt?: number;
}

// ---------------------------------------------------------------------------
// Operator helpers
// ---------------------------------------------------------------------------

function compareOp(value: number, threshold: number, op: AlertOperator): boolean {
  switch (op) {
    case 'above':
      return value > threshold;
    case 'below':
      return value < threshold;
    case 'above_or_equals':
      return value >= threshold;
    case 'below_or_equals':
      return value <= threshold;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class LocalAlertEngine {
  private readonly clock: () => number;
  private rules: LocalAlertRule[] = [];
  private readonly state = new Map<string, RuleState>();
  private onAlert: ((event: AlertEvent) => void) | undefined;
  private readonly osNotifier: OsNotifier | undefined;
  private readonly osNotificationsEnabled: boolean;

  constructor(opts: LocalAlertEngineOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.osNotifier = opts.osNotifier;
    this.osNotificationsEnabled = opts.osNotificationsEnabled === true;
  }

  loadRules(rules: readonly LocalAlertRule[]): void {
    // Atomic swap: replace rule list and prune state for rules that no longer
    // exist. Existing-rule state is preserved so a rule that was firing stays
    // firing across reloads.
    const idsAfter = new Set(rules.map((r) => r.id));
    for (const id of [...this.state.keys()]) {
      if (!idsAfter.has(id)) this.state.delete(id);
    }
    this.rules = [...rules];
    // Warn about rules that the v1.1 collector cannot evaluate (today/week
    // cost variants). The rule still loads — it just never fires.
    for (const rule of rules) {
      if (
        rule.enabled &&
        rule.type === 'cost.window' &&
        (rule.costPeriod === 'today' || rule.costPeriod === 'week')
      ) {
        logger.warn(
          'cost.window rule will not fire — today/week cost is stubbed in v1.1; use costPeriod: "session" until v1.2',
          { ruleId: rule.id, costPeriod: rule.costPeriod },
        );
      }
    }
    logger.debug('Loaded alert rules', { count: this.rules.length });
  }

  setOnAlert(callback: (event: AlertEvent) => void): void {
    this.onAlert = callback;
  }

  evaluate(snapshot: AlertSnapshot, now: number): readonly AlertEvent[] {
    if (this.rules.length === 0) return [];
    const emitted: AlertEvent[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const events = this.evaluateRule(rule, snapshot, now);
      for (const ev of events) {
        emitted.push(ev);
        try {
          this.onAlert?.(ev);
        } catch (err) {
          logger.error('onAlert callback threw', { error: String(err), ruleId: rule.id });
        }
        this.maybeFireOsNotification(rule, ev);
      }
    }

    return emitted;
  }

  /**
   * Fire an out-of-band OS notification for a firing event when both the
   * global `osNotificationsEnabled` flag is true AND the rule opts into the
   * `'os'` channel. `cleared` events do not trigger notifications — clearing
   * is a quiet UX. The call is fire-and-forget; OsNotifier swallows its own
   * errors.
   */
  private maybeFireOsNotification(rule: LocalAlertRule, ev: AlertEvent): void {
    if (!this.osNotifier) return;
    if (!this.osNotificationsEnabled) return;
    if (ev.state !== 'firing') return;
    if (!rule.channels.includes('os')) return;
    void this.osNotifier.notify({ title: ev.title, body: ev.description });
  }

  private evaluateRule(
    rule: LocalAlertRule,
    snapshot: AlertSnapshot,
    now: number,
  ): AlertEvent[] {
    // Exhaustive switch so TS catches missing rule-type handlers.
    switch (rule.type) {
      case 'budget.session':
      case 'budget.daily':
      case 'budget.weekly':
        return this.evaluateBudgetRule(rule, snapshot, now);
      case 'cost.window':
        return this.evaluateThresholdRule(
          rule,
          this.computeCostWindowValue(rule, snapshot),
          now,
        );
      case 'efficiency.below':
        return this.evaluateEfficiencyBelowRule(rule, snapshot, now);
      case 'antipattern.count':
        return this.evaluateThresholdRule(
          rule,
          this.computeAntiPatternCountValue(rule, snapshot),
          now,
        );
      case 'latency.percentile':
        return this.evaluateThresholdRule(
          rule,
          this.computeLatencyValue(rule, snapshot),
          now,
        );
      case 'tool.failure':
        return this.evaluateThresholdRule(
          rule,
          this.computeToolFailureValue(rule, snapshot),
          now,
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Threshold-rule core
  // ---------------------------------------------------------------------------

  /**
   * Common state machine for the non-budget rule types. Caller has already
   * computed the rule's current numeric `value`; if `value` is null the
   * rule cannot be evaluated this cycle (e.g. no efficiency score yet) and
   * neither fires nor clears.
   *
   * Deduplication semantics: when a rule has just cleared, it cannot
   * re-fire until `deduplicateSeconds` after `lastClearedAt`. While in the
   * dedupe window, the engine suppresses the firing event AND keeps the
   * state machine at `'idle'` — so on the next evaluation past the window,
   * a still-true condition will fire normally.
   */
  private evaluateThresholdRule(
    rule:
      | CostWindowRule
      | AntiPatternCountRule
      | LatencyPercentileRule
      | ToolFailureRule,
    value: number | null,
    now: number,
  ): AlertEvent[] {
    if (value === null) return [];
    const triggered = compareOp(value, rule.threshold, rule.operator);
    return this.applyThresholdState(rule, value, triggered, now);
  }

  /**
   * Special-case for `efficiency.below`: the trigger condition only counts
   * after it's been continuously true for `windowSeconds`. We track when
   * the condition first became true (`firstBelowAt`); the rule can only
   * fire once `now - firstBelowAt >= windowSeconds * 1000`.
   */
  private evaluateEfficiencyBelowRule(
    rule: EfficiencyBelowRule,
    snapshot: AlertSnapshot,
    now: number,
  ): AlertEvent[] {
    const value = snapshot.efficiency.score;
    if (value === null) return [];
    const conditionTrue = compareOp(value, rule.threshold, rule.operator);
    const state = this.getOrInitState(rule.id);

    if (!conditionTrue) {
      state.firstBelowAt = undefined;
      return this.applyThresholdState(rule, value, false, now);
    }

    if (state.firstBelowAt === undefined) {
      state.firstBelowAt = now;
    }
    const sustained = now - state.firstBelowAt >= rule.windowSeconds * 1000;
    return this.applyThresholdState(rule, value, sustained, now);
  }

  private applyThresholdState(
    rule:
      | CostWindowRule
      | EfficiencyBelowRule
      | AntiPatternCountRule
      | LatencyPercentileRule
      | ToolFailureRule,
    value: number,
    triggered: boolean,
    now: number,
  ): AlertEvent[] {
    const out: AlertEvent[] = [];
    const state = this.getOrInitState(rule.id);

    if (triggered) {
      if (state.status === 'firing') return out;
      // idle → firing, but only if outside the post-clear dedupe window.
      const dedupMs = rule.deduplicateSeconds * 1000;
      if (state.lastClearedAt > 0 && now - state.lastClearedAt < dedupMs) {
        // Suppress fire and keep state at idle so the next evaluation
        // past the window can still fire.
        return out;
      }
      state.status = 'firing';
      state.lastFiredAt = now;
      out.push({
        id: rule.id,
        state: 'firing',
        severity: rule.severity,
        title: rule.name,
        description: rule.description ?? defaultDescription(rule, value),
        value,
        threshold: rule.threshold,
        firedAt: now,
      });
    } else if (state.status === 'firing') {
      // firing → idle.
      state.status = 'idle';
      const lastFiredAt = state.lastFiredAt;
      state.lastClearedAt = now;
      out.push({
        id: rule.id,
        state: 'cleared',
        severity: rule.severity,
        title: rule.name,
        description: rule.description ?? defaultDescription(rule, value),
        value,
        threshold: rule.threshold,
        firedAt: lastFiredAt,
      });
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Per-rule value extractors
  // ---------------------------------------------------------------------------

  /**
   * v1.1 cost windows are session/today/week cumulative — not a true rolling
   * window. The engine reads whichever bucket the rule names; v1.2 will
   * swap in a real rolling-N-second cost calculation.
   */
  private computeCostWindowValue(
    rule: CostWindowRule,
    snapshot: AlertSnapshot,
  ): number | null {
    switch (rule.costPeriod) {
      case 'session':
        return snapshot.cost.sessionUsd;
      case 'today':
        return snapshot.cost.todayUsd;
      case 'week':
        return snapshot.cost.weekUsd;
    }
  }

  private computeAntiPatternCountValue(
    rule: AntiPatternCountRule,
    snapshot: AlertSnapshot,
  ): number | null {
    const windowMs = rule.windowSeconds * 1000;
    const wantedKey = rule.patternType ?? '*';
    let total = 0;
    let matched = false;
    for (const entry of snapshot.antiPatterns) {
      if (entry.windowMs !== windowMs) continue;
      if (entry.type !== wantedKey) continue;
      total += entry.count;
      matched = true;
    }
    return matched ? total : 0;
  }

  private computeLatencyValue(
    rule: LatencyPercentileRule,
    snapshot: AlertSnapshot,
  ): number | null {
    if (snapshot.latency.length === 0) return null;
    const pickPercentile = (entry: AlertSnapshot['latency'][number]): number => {
      switch (rule.percentile) {
        case 50:
          return entry.p50Ms;
        case 95:
          return entry.p95Ms;
        case 99:
          return entry.p99Ms;
      }
    };
    if (rule.tool) {
      const entry = snapshot.latency.find((l) => l.tool === rule.tool);
      return entry ? pickPercentile(entry) : null;
    }
    // No tool filter → take the worst (max) value at the requested percentile
    // across all observed tools.
    let max = -Infinity;
    for (const entry of snapshot.latency) {
      const v = pickPercentile(entry);
      if (v > max) max = v;
    }
    return max === -Infinity ? null : max;
  }

  private computeToolFailureValue(
    rule: ToolFailureRule,
    snapshot: AlertSnapshot,
  ): number | null {
    const windowMs = rule.windowSeconds * 1000;
    const entry = snapshot.toolFailures.find(
      (f) => f.tool === rule.tool && f.windowMs === windowMs,
    );
    return entry ? entry.failurePct : null;
  }

  private evaluateBudgetRule(
    rule: BudgetSessionRule | BudgetDailyRule | BudgetWeeklyRule,
    snapshot: AlertSnapshot,
    now: number,
  ): AlertEvent[] {
    const out: AlertEvent[] = [];
    const period = budgetPeriodForRule(rule);
    const thresholds = snapshot.budgetThresholds ?? [];
    const matching = thresholds.find(
      (t) => t.period === period && t.thresholdPct >= rule.threshold,
    );

    const state = this.getOrInitState(rule.id);

    if (matching) {
      // Edge-trigger: build a per-period key so the same threshold doesn't
      // fire twice in the same period unless deduplicateSeconds has elapsed
      // and a higher threshold crossed (BudgetTracker dedupes within a
      // period; this guards against duplicate calls into evaluate()).
      const periodKey = `${matching.period}|${matching.thresholdPct}|${this.periodKey(matching.period, now)}`;
      if (state.firedPeriodKey === periodKey) {
        return out;
      }
      if (
        state.status === 'firing' &&
        state.firedPeriodKey &&
        now - state.lastFiredAt < rule.deduplicateSeconds * 1000
      ) {
        return out;
      }
      state.status = 'firing';
      state.lastFiredAt = now;
      state.firedPeriodKey = periodKey;
      out.push({
        id: rule.id,
        state: 'firing',
        severity: rule.severity,
        title: rule.name,
        description:
          rule.description ??
          `Budget threshold ${matching.thresholdPct}% reached for ${matching.period}`,
        value: matching.thresholdPct,
        threshold: rule.threshold,
        firedAt: now,
      });
    } else if (state.status === 'firing') {
      // No matching threshold this cycle. Budget rules clear when the period
      // turns over — i.e. when the periodKey portion of firedPeriodKey no
      // longer matches the current period. Until then, keep the rule firing
      // (no clear event yet). This avoids flapping when BudgetTracker stops
      // re-emitting after the initial fire within a period.
      const stored = state.firedPeriodKey;
      if (stored) {
        const [, , storedPeriodKey] = stored.split('|');
        const currentPeriodKey = this.periodKey(period, now);
        if (storedPeriodKey !== currentPeriodKey) {
          state.status = 'idle';
          const lastFiredAt = state.lastFiredAt;
          state.lastFiredAt = now;
          state.firedPeriodKey = undefined;
          out.push({
            id: rule.id,
            state: 'cleared',
            severity: rule.severity,
            title: rule.name,
            description:
              rule.description ?? `Budget rule cleared for ${period}`,
            value: 0,
            threshold: rule.threshold,
            firedAt: lastFiredAt,
          });
        }
      }
    }

    return out;
  }

  private getOrInitState(ruleId: string): RuleState {
    let state = this.state.get(ruleId);
    if (!state) {
      state = { status: 'idle', lastFiredAt: 0, lastClearedAt: 0 };
      this.state.set(ruleId, state);
    }
    return state;
  }

  private periodKey(period: BudgetPeriod, now: number): string {
    const d = new Date(now);
    if (period === 'session') return 'session:infinite';
    if (period === 'daily') {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    // weekly — match BudgetTracker.currentPeriodId() shape
    const year = d.getFullYear();
    const jan4 = new Date(year, 0, 4);
    const weekStart = new Date(jan4);
    weekStart.setDate(jan4.getDate() - jan4.getDay());
    const week = Math.ceil((d.getTime() - weekStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
    const weekNum = String(Math.max(1, week)).padStart(2, '0');
    return `${year}-W${weekNum}`;
  }

  // For tests + Phase 2 hand-off: read-only view of currently firing rules.
  getFiringRuleIds(): readonly string[] {
    const ids: string[] = [];
    for (const [id, st] of this.state.entries()) {
      if (st.status === 'firing') ids.push(id);
    }
    return ids;
  }

  /**
   * Inspect the loaded rule set and return the windows the snapshot
   * collector needs to populate. Each entry is one (kind, key, windowMs)
   * the engine will look for in `evaluate()`. Duplicates are de-duplicated.
   */
  getRequiredWindows(): readonly SnapshotWindowSpec[] {
    const seen = new Set<string>();
    const out: SnapshotWindowSpec[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.type === 'antipattern.count') {
        const key = rule.patternType ?? '*';
        const windowMs = rule.windowSeconds * 1000;
        const seenKey = `antipattern:${key}:${windowMs}`;
        if (!seen.has(seenKey)) {
          seen.add(seenKey);
          out.push({ kind: 'antipattern', key, windowMs });
        }
      } else if (rule.type === 'tool.failure') {
        const windowMs = rule.windowSeconds * 1000;
        const seenKey = `tool-failure:${rule.tool}:${windowMs}`;
        if (!seen.has(seenKey)) {
          seen.add(seenKey);
          out.push({ kind: 'tool-failure', key: rule.tool, windowMs });
        }
      }
    }
    return out;
  }

  /** Exposed for Phase 2 wiring; returns the current monotonic clock reading. */
  now(): number {
    return this.clock();
  }
}

// ---------------------------------------------------------------------------
// Description helpers
// ---------------------------------------------------------------------------

function defaultDescription(rule: LocalAlertRule, value: number): string {
  switch (rule.type) {
    case 'cost.window':
      return `Cost ${rule.costPeriod} ${formatOp(rule.operator)} $${rule.threshold} (current: $${value.toFixed(2)})`;
    case 'efficiency.below':
      return `Efficiency score ${formatOp(rule.operator)} ${rule.threshold} (current: ${value})`;
    case 'antipattern.count': {
      const target = rule.patternType ?? 'any';
      return `Anti-pattern (${target}) count ${formatOp(rule.operator)} ${rule.threshold} (current: ${value})`;
    }
    case 'latency.percentile': {
      const target = rule.tool ?? 'any tool';
      return `p${rule.percentile} latency for ${target} ${formatOp(rule.operator)} ${rule.threshold}ms (current: ${value}ms)`;
    }
    case 'tool.failure':
      return `Failure rate for ${rule.tool} ${formatOp(rule.operator)} ${rule.threshold}% (current: ${value.toFixed(1)}%)`;
    case 'budget.session':
    case 'budget.daily':
    case 'budget.weekly':
      return `Budget threshold reached`;
  }
}

function formatOp(op: AlertOperator): string {
  switch (op) {
    case 'above':
      return '>';
    case 'below':
      return '<';
    case 'above_or_equals':
      return '>=';
    case 'below_or_equals':
      return '<=';
  }
}
