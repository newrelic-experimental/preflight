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

const THRESHOLD_LEVELS: Array<50 | 80 | 100> = [50, 80, 100];

const MAX_ALERTS = 100;

export class BudgetTracker {
  private readonly sessionBudgetUsd: number | null;
  private readonly dailyBudgetUsd: number | null;
  private readonly weeklyBudgetUsd: number | null;
  private onThreshold: ((event: BudgetThresholdEvent) => void) | undefined;

  private sessionSpentUsd = 0;
  private dailySpentUsd = 0;
  private weeklySpentUsd = 0;

  // Map from threshold key (e.g., "daily_50") to period ID (e.g., "day:2026-05-27")
  private firedThresholds = new Map<string, string>();
  private alerts: BudgetThresholdEvent[] = [];

  constructor(options: BudgetOptions) {
    this.sessionBudgetUsd = options.sessionBudgetUsd;
    this.dailyBudgetUsd = options.dailyBudgetUsd;
    this.weeklyBudgetUsd = options.weeklyBudgetUsd;
    this.onThreshold = options.onThreshold;
  }

  setOnThreshold(callback: (event: BudgetThresholdEvent) => void): void {
    this.onThreshold = callback;
  }

  updateCost(sessionCostUsd: number, dailyCostUsd: number, weeklyCostUsd: number): void {
    this.sessionSpentUsd = sessionCostUsd;
    this.dailySpentUsd = dailyCostUsd;
    this.weeklySpentUsd = weeklyCostUsd;
    this.checkThresholds();
  }

  private currentPeriodId(period: BudgetPeriod): string {
    const now = new Date();
    if (period === 'session') {
      return 'session:infinite';
    }
    if (period === 'daily') {
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `day:${year}-${month}-${day}`;
    }
    if (period === 'weekly') {
      // ISO 8601 week number — correct across year boundaries.
      // The ISO week year can differ from the calendar year in early Jan / late Dec.
      const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      const dayOfWeek = d.getUTCDay() || 7; // 1=Mon … 7=Sun
      d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // nearest Thursday
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      const isoYear = d.getUTCFullYear();
      const weekNum = String(week).padStart(2, '0');
      return `week:${isoYear}-W${weekNum}`;
    }
    return '';
  }

  // A threshold that already fired for a past period (e.g. yesterday's
  // "daily_80") must not suppress it firing again once a new period starts —
  // otherwise a session/day/week that repeatedly crosses 50/80/100% would
  // only ever alert once, ever. Drop any fired-threshold entry whose stored
  // period ID no longer matches the current one so it's free to fire again.
  private pruneStaleThresholds(): void {
    for (const [key, periodId] of this.firedThresholds.entries()) {
      const period = key.split('_')[0] as BudgetPeriod;
      const currentPeriod = this.currentPeriodId(period);
      if (periodId !== currentPeriod) {
        this.firedThresholds.delete(key);
      }
    }
  }

  private checkThresholds(): void {
    this.pruneStaleThresholds();
    this.checkPeriod('session', this.sessionSpentUsd, this.sessionBudgetUsd);
    this.checkPeriod('daily', this.dailySpentUsd, this.dailyBudgetUsd);
    this.checkPeriod('weekly', this.weeklySpentUsd, this.weeklyBudgetUsd);
  }

  private checkPeriod(period: BudgetPeriod, spent: number, budget: number | null): void {
    if (budget === null || budget <= 0) return;
    const pctUsed = (spent / budget) * 100;
    const currentPeriod = this.currentPeriodId(period);
    for (const level of THRESHOLD_LEVELS) {
      const key = `${period}_${level}`;
      if (pctUsed >= level && !this.firedThresholds.has(key)) {
        this.firedThresholds.set(key, currentPeriod);
        const event: BudgetThresholdEvent = {
          period,
          thresholdPct: level,
          spentUsd: spent,
          budgetUsd: budget,
          timestamp: Date.now(),
        };
        this.alerts.push(event);
        if (this.alerts.length > MAX_ALERTS) {
          this.alerts.shift();
        }
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
    const pctUsed = Math.round((spent / budget) * 1000) / 10;
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
    for (const key of this.firedThresholds.keys()) {
      if (key.startsWith('session_')) this.firedThresholds.delete(key);
    }
    this.alerts = this.alerts.filter((a) => a.period !== 'session');
  }
}
