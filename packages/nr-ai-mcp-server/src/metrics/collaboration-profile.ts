/**
 * Developer Collaboration Profile — computes four profile dimensions from
 * historical session data to characterize how a developer works with AI.
 *
 * Dimensions (each normalized to 0–1):
 *   1. Specificity — how detailed are the developer's prompts?
 *   2. Autonomy — how independently does the AI work?
 *   3. Correction Rate — how rarely does the developer redirect the AI? (inverted)
 *   4. Task Complexity — how complex are the tasks given to the AI?
 *
 * Classifications based on dimension thresholds:
 *   - "Power User": high specificity + high autonomy
 *   - "Delegator": low specificity + high autonomy
 *   - "Learning": low specificity + frequent corrections
 *   - "Collaborative": everything else
 */

import type { MetricAggregator } from '@nr-ai-observatory/shared';
import type { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import { getIsoWeekId } from '../storage/weekly-summary.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileDimensions {
  readonly specificity: number;
  readonly autonomy: number;
  readonly correctionRate: number;
  readonly taskComplexity: number;
}

export interface WeeklyProfile {
  readonly week: string;
  readonly dimensions: ProfileDimensions;
}

export interface DeveloperProfile {
  readonly developer: string;
  readonly dimensions: ProfileDimensions;
  readonly weeklyProfiles: WeeklyProfile[];
  readonly classification: string;
  readonly sessionCount: number;
}

export interface TeamBaseline {
  readonly dimensions: ProfileDimensions;
  readonly developerCount: number;
  readonly sessionCount: number;
}

export interface TeamComparison {
  readonly developer: string;
  readonly developerDimensions: ProfileDimensions;
  readonly teamDimensions: ProfileDimensions;
  readonly deltas: ProfileDimensions;
}

// ---------------------------------------------------------------------------
// CollaborationProfiler
// ---------------------------------------------------------------------------

export class CollaborationProfiler {
  private readonly sessionStore: SessionStore;

  constructor(options: { sessionStore: SessionStore }) {
    this.sessionStore = options.sessionStore;
  }

  computeProfile(developer: string, options?: { since?: Date }): DeveloperProfile {
    const sessions = this.sessionStore.loadAllSessions({
      since: options?.since,
      developer,
    });

    const dimensions = computeDimensions(sessions);
    const weeklyProfiles = computeWeeklyProfiles(sessions);
    const classification = classify(dimensions);

    return {
      developer,
      dimensions,
      weeklyProfiles,
      classification,
      sessionCount: sessions.length,
    };
  }

  computeTeamBaseline(options?: { since?: Date }): TeamBaseline {
    const allSessions = this.sessionStore.loadAllSessions({ since: options?.since });

    // Group by developer and compute per-developer dimensions
    const byDeveloper = new Map<string, FullSessionSummary[]>();
    for (const s of allSessions) {
      const list = byDeveloper.get(s.developer) ?? [];
      list.push(s);
      byDeveloper.set(s.developer, list);
    }

    if (byDeveloper.size === 0) {
      return {
        dimensions: { specificity: 0, autonomy: 0, correctionRate: 0, taskComplexity: 0 },
        developerCount: 0,
        sessionCount: 0,
      };
    }

    let totalSpecificity = 0;
    let totalAutonomy = 0;
    let totalCorrectionRate = 0;
    let totalTaskComplexity = 0;

    for (const [, devSessions] of byDeveloper) {
      const dims = computeDimensions(devSessions);
      totalSpecificity += dims.specificity;
      totalAutonomy += dims.autonomy;
      totalCorrectionRate += dims.correctionRate;
      totalTaskComplexity += dims.taskComplexity;
    }

    const n = byDeveloper.size;

    return {
      dimensions: {
        specificity: round(totalSpecificity / n, 3),
        autonomy: round(totalAutonomy / n, 3),
        correctionRate: round(totalCorrectionRate / n, 3),
        taskComplexity: round(totalTaskComplexity / n, 3),
      },
      developerCount: n,
      sessionCount: allSessions.length,
    };
  }

  compareToTeam(developer: string, options?: { since?: Date }): TeamComparison {
    const profile = this.computeProfile(developer, options);
    const baseline = this.computeTeamBaseline(options);

    return {
      developer,
      developerDimensions: profile.dimensions,
      teamDimensions: baseline.dimensions,
      deltas: {
        specificity: round(profile.dimensions.specificity - baseline.dimensions.specificity, 3),
        autonomy: round(profile.dimensions.autonomy - baseline.dimensions.autonomy, 3),
        correctionRate: round(profile.dimensions.correctionRate - baseline.dimensions.correctionRate, 3),
        taskComplexity: round(profile.dimensions.taskComplexity - baseline.dimensions.taskComplexity, 3),
      },
    };
  }

  emitMetrics(aggregator: MetricAggregator, options?: { since?: Date }): void {
    const allSessions = this.sessionStore.loadAllSessions({ since: options?.since });

    const byDeveloper = new Map<string, FullSessionSummary[]>();
    for (const s of allSessions) {
      const list = byDeveloper.get(s.developer) ?? [];
      list.push(s);
      byDeveloper.set(s.developer, list);
    }

    for (const [developer, devSessions] of byDeveloper) {
      const dims = computeDimensions(devSessions);
      const attrs = { developer };

      aggregator.record('ai.collaboration.specificity', dims.specificity, attrs);
      aggregator.record('ai.collaboration.autonomy', dims.autonomy, attrs);
      aggregator.record('ai.collaboration.correction_rate', dims.correctionRate, attrs);
      aggregator.record('ai.collaboration.task_complexity', dims.taskComplexity, attrs);
    }
  }
}

// ---------------------------------------------------------------------------
// Dimension computation
// ---------------------------------------------------------------------------

function computeDimensions(sessions: FullSessionSummary[]): ProfileDimensions {
  if (sessions.length === 0) {
    return { specificity: 0, autonomy: 0, correctionRate: 0, taskComplexity: 0 };
  }

  let totalToolCalls = 0;
  let totalUserMessages = 0;
  let totalUserCorrections = 0;
  let totalFiles = 0;
  let totalTasks = 0;
  let totalAgentSpawns = 0;

  for (const s of sessions) {
    totalToolCalls += s.toolCallCount;
    totalUserMessages += s.userMessages;
    totalUserCorrections += s.userCorrections;
    totalFiles += s.filesRead.length + s.filesModified.length;
    totalTasks += s.taskCount;
    totalAgentSpawns += s.agentSpawns;
  }

  return {
    specificity: computeSpecificity(totalToolCalls, totalUserMessages),
    autonomy: computeAutonomy(totalUserCorrections, totalUserMessages),
    correctionRate: computeCorrectionRate(totalUserCorrections, totalUserMessages),
    taskComplexity: computeTaskComplexity(totalFiles, totalToolCalls, totalAgentSpawns, totalTasks),
  };
}

/**
 * Specificity: ratio of tool calls to user messages, normalized so 10:1 = 1.0.
 * When userMessages is 0, falls back to 0.5 (unknown).
 */
function computeSpecificity(toolCalls: number, userMessages: number): number {
  if (userMessages === 0) return 0.5;
  const ratio = toolCalls / userMessages;
  return clamp(round(ratio / 10, 3), 0, 1);
}

/**
 * Autonomy: 1 - (corrections / messages). Low corrections = high autonomy.
 * When userMessages is 0, falls back to 0.8 (assumed autonomous).
 */
function computeAutonomy(corrections: number, userMessages: number): number {
  if (userMessages === 0) return 0.8;
  return clamp(round(1 - corrections / userMessages, 3), 0, 1);
}

/**
 * Correction rate (inverted): 1 - (corrections / messages). 1.0 = no corrections.
 * When userMessages is 0, falls back to 1.0 (no corrections observed).
 */
function computeCorrectionRate(corrections: number, userMessages: number): number {
  if (userMessages === 0) return 1;
  return clamp(round(1 - corrections / userMessages, 3), 0, 1);
}

/**
 * Task complexity: composite of avg files per task, avg tool calls per task,
 * and avg agent spawns per task, each normalized against reasonable baselines.
 */
function computeTaskComplexity(
  totalFiles: number,
  totalToolCalls: number,
  totalAgentSpawns: number,
  totalTasks: number,
): number {
  if (totalTasks === 0) return 0;

  const avgFiles = totalFiles / totalTasks;
  const avgToolCalls = totalToolCalls / totalTasks;
  const avgAgents = totalAgentSpawns / totalTasks;

  // Normalize each component against reasonable baselines
  const filesComponent = avgFiles / 20;        // 20 files per task = max
  const toolCallsComponent = avgToolCalls / 50; // 50 tool calls per task = max
  const agentsComponent = avgAgents / 3;        // 3 agents per task = max

  const composite = (filesComponent + toolCallsComponent + agentsComponent) / 3;
  return clamp(round(composite, 3), 0, 1);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classify(dimensions: ProfileDimensions): string {
  const { specificity, autonomy, correctionRate } = dimensions;

  if (specificity >= 0.6 && autonomy >= 0.6) return 'Power User';
  if (specificity < 0.6 && autonomy >= 0.6) return 'Delegator';
  if (specificity < 0.6 && correctionRate < 0.6) return 'Learning';
  return 'Collaborative';
}

// ---------------------------------------------------------------------------
// Weekly profiles
// ---------------------------------------------------------------------------

function computeWeeklyProfiles(sessions: FullSessionSummary[]): WeeklyProfile[] {
  const byWeek = new Map<string, FullSessionSummary[]>();
  for (const s of sessions) {
    const week = getIsoWeekId(new Date(s.startTime));
    const list = byWeek.get(week) ?? [];
    list.push(s);
    byWeek.set(week, list);
  }

  const profiles: WeeklyProfile[] = [];
  for (const [week, weekSessions] of byWeek) {
    profiles.push({ week, dimensions: computeDimensions(weekSessions) });
  }

  return profiles.sort((a, b) => a.week.localeCompare(b.week));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
