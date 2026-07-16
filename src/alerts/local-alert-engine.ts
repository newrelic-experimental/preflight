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
// keep imports stable.
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
  // For budget.session rules: the snapshot's spentUsd at fire time.
  // When the next snapshot's session cost drops below this value, the
  // CostTracker has reset (a new session started) and the rule should clear.
  firedSpentUsd?: number;
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
    // Note: the warning about cost.window today/week rules
    // lives in loadAlertRulesFromDisk (src/index.ts) so it fires once
    // per disk load with the rule id and exact costPeriod inline. We
    // deliberately don't duplicate it here — programmatic callers (tests,
    // future code) get the rule loaded without stderr noise; the user-
    // facing path that reads rules.json still surfaces the warning.
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

  private evaluateRule(rule: LocalAlertRule, snapshot: AlertSnapshot, now: number): AlertEvent[] {
    // Exhaustive switch so TS catches missing rule-type handlers.
    switch (rule.type) {
      case 'budget.session':
      case 'budget.daily':
      case 'budget.weekly':
        return this.evaluateBudgetRule(rule, snapshot, now);
      case 'cost.window':
        return this.evaluateThresholdRule(rule, this.computeCostWindowValue(rule, snapshot), now);
      case 'efficiency.below':
        return this.evaluateEfficiencyBelowRule(rule, snapshot, now);
      case 'antipattern.count':
        return this.evaluateThresholdRule(
          rule,
          this.computeAntiPatternCountValue(rule, snapshot),
          now,
        );
      case 'latency.percentile':
        return this.evaluateThresholdRule(rule, this.computeLatencyValue(rule, snapshot), now);
      case 'tool.failure':
        return this.evaluateThresholdRule(rule, this.computeToolFailureValue(rule, snapshot), now);
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
    rule: CostWindowRule | AntiPatternCountRule | LatencyPercentileRule | ToolFailureRule,
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
   * Cost windows are session/today/week cumulative — not a true rolling
   * window. The engine reads whichever bucket the rule names; a real
   * rolling-N-second cost calculation is not yet implemented.
   */
  private computeCostWindowValue(rule: CostWindowRule, snapshot: AlertSnapshot): number | null {
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
    return matched ? total : null;
  }

  private computeLatencyValue(rule: LatencyPercentileRule, snapshot: AlertSnapshot): number | null {
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

  private computeToolFailureValue(rule: ToolFailureRule, snapshot: AlertSnapshot): number | null {
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
    // Find the HIGHEST matching threshold so escalation from 50% → 80% produces
    // a new periodKey and fires again rather than being blocked by the 50% key.
    const matching = thresholds
      .filter((t) => t.period === period && t.thresholdPct >= rule.threshold)
      .reduce(
        (best: (typeof thresholds)[number] | null, t) =>
          best === null || t.thresholdPct > best.thresholdPct ? t : best,
        null,
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
      state.firedSpentUsd = matching.spentUsd;
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
        // Session period rolls over via CostTracker reset (new Claude Code
        // session) rather than calendar turnover, so periodKey() returns the
        // constant `'session:infinite'` and storedPeriodKey === currentPeriodKey
        // forever. Detect the reset by watching for sessionUsd dropping below
        // the spent value at fire time.
        const sessionReset =
          period === 'session' &&
          state.firedSpentUsd !== undefined &&
          snapshot.cost.sessionUsd < state.firedSpentUsd;
        if (storedPeriodKey !== currentPeriodKey || sessionReset) {
          state.status = 'idle';
          const lastFiredAt = state.lastFiredAt;
          // Do not update lastFiredAt here — it must reflect the fire time so
          // that the deduplicateSeconds window for the new period is measured
          // from when the rule last fired, not when it cleared.
          state.firedPeriodKey = undefined;
          state.firedSpentUsd = undefined;
          out.push({
            id: rule.id,
            state: 'cleared',
            severity: rule.severity,
            title: rule.name,
            description: rule.description ?? `Budget rule cleared for ${period}`,
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
    // ISO 8601 week — mirrors BudgetTracker.currentPeriodId() exactly so
    // period keys match when comparing alert engine state to budget thresholds.
    const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayOfWeek = utc.getUTCDay() || 7; // 1=Mon … 7=Sun
    utc.setUTCDate(utc.getUTCDate() + 4 - dayOfWeek); // nearest Thursday
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    const isoYear = utc.getUTCFullYear();
    const weekNum = String(week).padStart(2, '0');
    return `${isoYear}-W${weekNum}`;
  }

  // For tests: read-only view of currently firing rules.
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

  /** Exposed for tests; returns the current monotonic clock reading. */
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
