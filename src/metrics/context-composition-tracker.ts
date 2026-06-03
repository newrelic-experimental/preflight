import type { MetricAggregator } from '../shared/index.js';
import { createLogger } from '../shared/index.js';

const logger = createLogger('context-composition');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextCategory =
  | 'system_prompt'
  | 'conversation_history'
  | 'tool_results'
  | 'injected_file_content'
  | 'other';

export interface TurnComposition {
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly totalTokens: number;
  readonly breakdown: Readonly<Record<ContextCategory, number>>;
  readonly fillPercent: number;
  readonly dominantCategory: ContextCategory | null;
}

export interface ContextThresholdAlert {
  readonly threshold: number;
  readonly fillPercent: number;
  readonly timestamp: number;
  readonly turnNumber: number;
  readonly dominantCategory: ContextCategory;
  readonly dominantPercent: number;
}

export interface CategoryDominanceAlert {
  readonly category: ContextCategory;
  readonly percent: number;
  readonly timestamp: number;
  readonly turnNumber: number;
}

export interface ContextCompositionMetrics {
  readonly currentFillPercent: number;
  readonly currentBreakdown: Readonly<Record<ContextCategory, number>>;
  readonly turnCount: number;
  readonly thresholdAlerts: readonly ContextThresholdAlert[];
  readonly dominanceAlerts: readonly CategoryDominanceAlert[];
  readonly history: readonly TurnComposition[];
}

export interface ContextCompositionOptions {
  readonly modelContextWindow?: number;
  readonly fillThresholds?: readonly number[];
  readonly dominanceThreshold?: number;
  readonly maxHistorySize?: number;
  readonly onThresholdAlert?: (alert: ContextThresholdAlert) => void;
  readonly onDominanceAlert?: (alert: CategoryDominanceAlert) => void;
}

export interface TurnTokenReport {
  readonly systemPromptTokens: number;
  readonly conversationHistoryTokens: number;
  readonly toolResultTokens: number;
  readonly injectedFileContentTokens: number;
  readonly otherTokens: number;
  readonly totalTokens: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_FILL_THRESHOLDS = [50, 75, 90] as const;
const DEFAULT_DOMINANCE_THRESHOLD = 60;
const DEFAULT_MAX_HISTORY = 500;

// ---------------------------------------------------------------------------
// ContextCompositionTracker
// ---------------------------------------------------------------------------

export class ContextCompositionTracker {
  private readonly modelContextWindow: number;
  private readonly fillThresholds: readonly number[];
  private readonly dominanceThreshold: number;
  private readonly maxHistorySize: number;
  private readonly onThresholdAlert: ((alert: ContextThresholdAlert) => void) | null;
  private readonly onDominanceAlert: ((alert: CategoryDominanceAlert) => void) | null;

  private turnCount = 0;
  private currentBreakdown: Record<ContextCategory, number> = {
    system_prompt: 0,
    conversation_history: 0,
    tool_results: 0,
    injected_file_content: 0,
    other: 0,
  };
  private currentTotalTokens = 0;
  private readonly history: TurnComposition[] = [];
  private readonly thresholdAlerts: ContextThresholdAlert[] = [];
  private readonly dominanceAlerts: CategoryDominanceAlert[] = [];
  private readonly firedThresholds = new Set<number>();

  constructor(options?: ContextCompositionOptions) {
    this.modelContextWindow = options?.modelContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.fillThresholds = options?.fillThresholds ?? DEFAULT_FILL_THRESHOLDS;
    this.dominanceThreshold = options?.dominanceThreshold ?? DEFAULT_DOMINANCE_THRESHOLD;
    this.maxHistorySize = options?.maxHistorySize ?? DEFAULT_MAX_HISTORY;
    this.onThresholdAlert = options?.onThresholdAlert ?? null;
    this.onDominanceAlert = options?.onDominanceAlert ?? null;
  }

  recordTurn(report: TurnTokenReport): TurnComposition {
    this.turnCount++;
    const now = Date.now();

    this.currentBreakdown = {
      system_prompt: report.systemPromptTokens,
      conversation_history: report.conversationHistoryTokens,
      tool_results: report.toolResultTokens,
      injected_file_content: report.injectedFileContentTokens,
      other: report.otherTokens,
    };
    this.currentTotalTokens = report.totalTokens;

    const fillPercent = (report.totalTokens / this.modelContextWindow) * 100;
    const dominantCategory = this.findDominantCategory();

    const composition: TurnComposition = {
      turnNumber: this.turnCount,
      timestamp: now,
      totalTokens: report.totalTokens,
      breakdown: { ...this.currentBreakdown },
      fillPercent,
      dominantCategory,
    };

    this.history.push(composition);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    this.checkFillThresholds(fillPercent, now);
    this.checkDominance(now);

    return composition;
  }

  getMetrics(): ContextCompositionMetrics {
    const fillPercent = this.modelContextWindow > 0
      ? (this.currentTotalTokens / this.modelContextWindow) * 100
      : 0;

    return {
      currentFillPercent: Math.round(fillPercent * 100) / 100,
      currentBreakdown: { ...this.currentBreakdown },
      turnCount: this.turnCount,
      thresholdAlerts: this.thresholdAlerts,
      dominanceAlerts: this.dominanceAlerts,
      history: this.history,
    };
  }

  emitMetrics(aggregator: MetricAggregator): void {
    const fillPercent = this.modelContextWindow > 0
      ? (this.currentTotalTokens / this.modelContextWindow) * 100
      : 0;
    aggregator.record('ai.context.fill_percent', fillPercent);
    aggregator.record('ai.context.total_tokens', this.currentTotalTokens);

    for (const [category, tokens] of Object.entries(this.currentBreakdown)) {
      aggregator.record('ai.context.category_tokens', tokens, { category });
    }
  }

  reset(_sessionId: string): void {
    this.turnCount = 0;
    this.currentBreakdown = {
      system_prompt: 0,
      conversation_history: 0,
      tool_results: 0,
      injected_file_content: 0,
      other: 0,
    };
    this.currentTotalTokens = 0;
    this.history.length = 0;
    this.thresholdAlerts.length = 0;
    this.dominanceAlerts.length = 0;
    this.firedThresholds.clear();
  }

  private findDominantCategory(): ContextCategory | null {
    if (this.currentTotalTokens === 0) return null;

    let maxCategory: ContextCategory | null = null;
    let maxPercent = 0;

    for (const [category, tokens] of Object.entries(this.currentBreakdown)) {
      const percent = (tokens / this.currentTotalTokens) * 100;
      if (percent > maxPercent) {
        maxPercent = percent;
        maxCategory = category as ContextCategory;
      }
    }

    return maxPercent >= this.dominanceThreshold ? maxCategory : null;
  }

  private checkFillThresholds(fillPercent: number, now: number): void {
    for (const threshold of this.fillThresholds) {
      if (fillPercent >= threshold && !this.firedThresholds.has(threshold)) {
        this.firedThresholds.add(threshold);

        const dominant = this.findDominantCategory() ?? 'other';
        const dominantPercent = this.currentTotalTokens > 0
          ? (this.currentBreakdown[dominant] / this.currentTotalTokens) * 100
          : 0;

        const alert: ContextThresholdAlert = {
          threshold,
          fillPercent: Math.round(fillPercent * 100) / 100,
          timestamp: now,
          turnNumber: this.turnCount,
          dominantCategory: dominant,
          dominantPercent: Math.round(dominantPercent * 100) / 100,
        };

        this.thresholdAlerts.push(alert);

        logger.warn(`Context window ${threshold}% full`, {
          fillPercent: alert.fillPercent,
          dominant,
          dominantPercent: alert.dominantPercent,
          turn: this.turnCount,
        });

        if (this.onThresholdAlert) {
          this.onThresholdAlert(alert);
        }
      }
    }
  }

  private checkDominance(now: number): void {
    if (this.currentTotalTokens === 0) return;

    for (const [category, tokens] of Object.entries(this.currentBreakdown)) {
      const percent = (tokens / this.currentTotalTokens) * 100;
      if (percent > this.dominanceThreshold) {
        const alert: CategoryDominanceAlert = {
          category: category as ContextCategory,
          percent: Math.round(percent * 100) / 100,
          timestamp: now,
          turnNumber: this.turnCount,
        };

        this.dominanceAlerts.push(alert);

        logger.warn(`Context dominated by ${category}`, {
          percent: alert.percent,
          turn: this.turnCount,
        });

        if (this.onDominanceAlert) {
          this.onDominanceAlert(alert);
        }
        break; // only one dominant category per turn
      }
    }
  }
}
