/**
 * Session Persistence — enriched session summaries with data from all trackers.
 *
 * `FullSessionSummary` extends the minimal `SessionSummary` type with fields
 * aggregated from SessionTracker, CostTracker, TaskDetector, AntiPatternDetector,
 * and EfficiencyScorer.
 *
 * `SessionStore` wraps filesystem operations for saving and loading session files
 * with a `YYYY-MM-DD_sessionId.json` naming convention.
 *
 * `buildSessionSummary()` pulls getMetrics() from each tracker and aggregates
 * task-level data into a single FullSessionSummary.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createLogger } from '@nr-ai-observatory/shared';
import type { SessionSummary } from './types.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import type { CostTracker } from '../metrics/cost-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { AntiPatternDetector } from '../metrics/anti-patterns.js';
import type { EfficiencyScorer } from '../metrics/efficiency-score.js';

const logger = createLogger('session-store');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FullSessionSummary extends SessionSummary {
  readonly model: string | null;
  readonly toolBreakdown: Record<string, number>;
  readonly filesRead: string[];
  readonly filesModified: string[];
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly bashCommandCount: number;
  readonly testRunCount: number;
  readonly testPassCount: number;
  readonly buildRunCount: number;
  readonly buildPassCount: number;
  readonly estimatedCostUsd: number | null;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly tokensThinking: number;
  readonly efficiencyScore: number | null;
  readonly antiPatterns: Array<{ type: string; count: number }>;
  readonly taskCount: number;
  readonly taskSuccessRate: number | null;
  readonly toolSuccessRate: number | null;
  readonly contextCompressions: number;
  readonly agentSpawns: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly userCorrections: number;
  readonly outcome: string;
  readonly platform?: string;
}

export interface SessionFileInfo {
  readonly filename: string;
  readonly sessionId: string;
  readonly date: string;
}

export interface ListSessionsOptions {
  since?: Date;
  developer?: string;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(options: { storagePath: string }) {
    this.sessionsDir = join(options.storagePath, 'sessions');
  }

  getSessionsDir(): string {
    return this.sessionsDir;
  }

  saveSession(summary: FullSessionSummary): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(summary.sessionId)) {
      logger.warn('Rejecting invalid sessionId for file path', { sessionId: summary.sessionId });
      return;
    }

    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }

    const date = new Date(summary.startTime).toISOString().slice(0, 10);
    const filename = `${date}_${summary.sessionId}.json`;
    const filepath = resolve(this.sessionsDir, filename);
    if (!filepath.startsWith(this.sessionsDir + sep)) {
      throw new Error(`Session path escaped storage directory: ${filepath}`);
    }

    writeFileSync(filepath, JSON.stringify(summary, null, 2) + '\n');
    logger.debug('Session saved', { sessionId: summary.sessionId, filename });
  }

  loadSession(sessionId: string): FullSessionSummary | null {
    if (!existsSync(this.sessionsDir)) return null;

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      if (parseSessionFilename(file)?.sessionId !== sessionId) continue;

      try {
        const raw = readFileSync(join(this.sessionsDir, file), 'utf-8');
        return deserializeSession(raw);
      } catch {
        logger.warn('Failed to read session file', { file });
      }
    }

    return null;
  }

  listSessions(options?: ListSessionsOptions): SessionFileInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    const sinceDate = options?.since ? formatDate(options.since) : null;
    const results: SessionFileInfo[] = [];

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;

      const parsed = parseSessionFilename(file);
      if (!parsed) continue;

      if (sinceDate && parsed.date < sinceDate) continue;

      if (options?.developer) {
        try {
          const raw = readFileSync(join(this.sessionsDir, file), 'utf-8');
          const session = deserializeSession(raw);
          if (session?.developer !== options.developer) continue;
        } catch {
          continue;
        }
      }

      results.push(parsed);
    }

    return results.sort((a, b) => a.date.localeCompare(b.date) || a.sessionId.localeCompare(b.sessionId));
  }

  loadAllSessions(options?: ListSessionsOptions): FullSessionSummary[] {
    if (!existsSync(this.sessionsDir)) return [];

    const sinceDate = options?.since ? formatDate(options.since) : null;
    const results: FullSessionSummary[] = [];

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;

      const parsed = parseSessionFilename(file);
      if (!parsed) continue;

      if (sinceDate && parsed.date < sinceDate) continue;

      try {
        const raw = readFileSync(join(this.sessionsDir, file), 'utf-8');
        const session = deserializeSession(raw);
        if (!session) continue;

        if (options?.developer && session.developer !== options.developer) continue;

        results.push(session);
      } catch {
        logger.warn('Failed to read session file', { file });
      }
    }

    return results.sort((a, b) => a.startTime - b.startTime);
  }
}

// ---------------------------------------------------------------------------
// buildSessionSummary
// ---------------------------------------------------------------------------

export interface BuildSessionSummarySources {
  sessionTracker: SessionTracker;
  costTracker?: CostTracker;
  taskDetector?: TaskDetector;
  antiPatternDetector?: AntiPatternDetector;
  efficiencyScorer?: EfficiencyScorer;
  developer: string;
}

export function buildSessionSummary(sources: BuildSessionSummarySources): FullSessionSummary {
  const {
    sessionTracker,
    costTracker,
    taskDetector,
    antiPatternDetector,
    efficiencyScorer,
    developer,
  } = sources;

  const sessionMetrics = sessionTracker.getMetrics();
  const costMetrics = costTracker?.getMetrics() ?? null;
  const taskMetrics = taskDetector?.getMetrics() ?? null;

  // Aggregate task-level data
  const allFilesRead = new Set<string>();
  const allFilesModified = new Set<string>();
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;
  let totalTestsRun = 0;
  let totalTestsPassed = 0;
  let totalBuildsRun = 0;
  let totalBuildsPassed = 0;
  let totalAgentSpawns = 0;
  const allToolCalls: import('../storage/types.js').ToolCallRecord[] = [];

  if (taskMetrics) {
    const allTasks = [...taskMetrics.completedTasks];
    const activeTask = taskDetector?.getCurrentTask();
    if (activeTask) allTasks.push(activeTask);

    for (const task of allTasks) {
      for (const f of task.filesRead) allFilesRead.add(f);
      for (const f of task.filesModified) allFilesModified.add(f);
      totalLinesAdded += task.linesAdded;
      totalLinesRemoved += task.linesRemoved;
      totalTestsRun += task.testsRun;
      totalTestsPassed += task.testsPassed;
      totalBuildsRun += task.buildRun;
      totalBuildsPassed += task.buildPassed;
      totalAgentSpawns += task.subAgentsSpawned;
      allToolCalls.push(...task.toolCalls);
    }
  }

  // Anti-pattern analysis
  const antiPatternResults = antiPatternDetector && allToolCalls.length > 0
    ? antiPatternDetector.analyze(allToolCalls)
    : null;

  const antiPatterns: Array<{ type: string; count: number }> = [];
  if (antiPatternResults) {
    const grouped = new Map<string, number>();
    for (const p of antiPatternResults.patterns) {
      grouped.set(p.type, (grouped.get(p.type) ?? 0) + 1);
    }
    for (const [type, count] of grouped) {
      antiPatterns.push({ type, count });
    }
  }

  // Efficiency score
  const efficiencyAvg = efficiencyScorer?.getSessionAverage() ?? null;

  // Task success rate: ratio of test passes to test runs across all tasks
  const taskSuccessRate = totalTestsRun > 0
    ? Math.round((totalTestsPassed / totalTestsRun) * 1000) / 1000
    : null;

  const now = Date.now();

  return {
    sessionId: sessionMetrics.sessionId,
    startTime: sessionMetrics.sessionStartTime,
    endTime: now,
    durationMs: sessionMetrics.sessionDurationMs,
    toolCallCount: sessionMetrics.toolCallCount,
    developer,
    model: costMetrics?.model ?? null,
    toolBreakdown: { ...sessionMetrics.toolCallCountByTool },
    filesRead: [...allFilesRead].sort(),
    filesModified: [...allFilesModified].sort(),
    linesAdded: totalLinesAdded,
    linesRemoved: totalLinesRemoved,
    bashCommandCount: sessionMetrics.bashCommandsRun,
    testRunCount: totalTestsRun,
    testPassCount: totalTestsPassed,
    buildRunCount: totalBuildsRun,
    buildPassCount: totalBuildsPassed,
    estimatedCostUsd: costMetrics?.sessionTotalCostUsd ?? null,
    tokensInput: costMetrics?.totalInputTokens ?? 0,
    tokensOutput: costMetrics?.totalOutputTokens ?? 0,
    tokensThinking: costMetrics?.totalThinkingTokens ?? 0,
    efficiencyScore: efficiencyAvg?.score ?? null,
    antiPatterns,
    taskCount: (taskMetrics?.totalTasksCompleted ?? 0) + (taskMetrics?.currentTaskActive ? 1 : 0),
    taskSuccessRate,
    toolSuccessRate: sessionMetrics.toolSuccessRate,
    contextCompressions: 0,
    agentSpawns: totalAgentSpawns,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'completed',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * N-06: Explicitly extract known fields from a raw session JSON string rather
 * than blindly casting JSON.parse output. Prevents untrusted keys from disk
 * being misinterpreted as typed properties.
 */
function deserializeSession(raw: string): FullSessionSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const toolBreakdown = Object.create(null) as Record<string, number>;
  if (typeof obj.toolBreakdown === 'object' && obj.toolBreakdown !== null) {
    for (const [k, v] of Object.entries(obj.toolBreakdown as Record<string, unknown>)) {
      if (typeof v === 'number') toolBreakdown[k] = v;
    }
  }

  const antiPatterns: Array<{ type: string; count: number }> = [];
  if (Array.isArray(obj.antiPatterns)) {
    for (const ap of obj.antiPatterns as unknown[]) {
      if (typeof ap === 'object' && ap !== null) {
        const a = ap as Record<string, unknown>;
        if (typeof a.type === 'string' && typeof a.count === 'number') {
          antiPatterns.push({ type: a.type, count: a.count });
        }
      }
    }
  }

  return {
    sessionId:            typeof obj.sessionId === 'string'  ? obj.sessionId  : '',
    startTime:            typeof obj.startTime === 'number'  ? obj.startTime  : 0,
    endTime:              typeof obj.endTime === 'number'    ? obj.endTime    : 0,
    durationMs:           typeof obj.durationMs === 'number' ? obj.durationMs : 0,
    toolCallCount:        typeof obj.toolCallCount === 'number' ? obj.toolCallCount : 0,
    developer:            typeof obj.developer === 'string'  ? obj.developer  : 'unknown',
    model:                typeof obj.model === 'string'      ? obj.model      : null,
    toolBreakdown,
    filesRead:     Array.isArray(obj.filesRead)     ? (obj.filesRead as unknown[]).filter((f): f is string => typeof f === 'string')     : [],
    filesModified: Array.isArray(obj.filesModified) ? (obj.filesModified as unknown[]).filter((f): f is string => typeof f === 'string') : [],
    linesAdded:           typeof obj.linesAdded === 'number'           ? obj.linesAdded           : 0,
    linesRemoved:         typeof obj.linesRemoved === 'number'         ? obj.linesRemoved         : 0,
    bashCommandCount:     typeof obj.bashCommandCount === 'number'     ? obj.bashCommandCount     : 0,
    testRunCount:         typeof obj.testRunCount === 'number'         ? obj.testRunCount         : 0,
    testPassCount:        typeof obj.testPassCount === 'number'        ? obj.testPassCount        : 0,
    buildRunCount:        typeof obj.buildRunCount === 'number'        ? obj.buildRunCount        : 0,
    buildPassCount:       typeof obj.buildPassCount === 'number'       ? obj.buildPassCount       : 0,
    estimatedCostUsd:     typeof obj.estimatedCostUsd === 'number'     ? obj.estimatedCostUsd     : null,
    tokensInput:          typeof obj.tokensInput === 'number'          ? obj.tokensInput          : 0,
    tokensOutput:         typeof obj.tokensOutput === 'number'         ? obj.tokensOutput         : 0,
    tokensThinking:       typeof obj.tokensThinking === 'number'       ? obj.tokensThinking       : 0,
    efficiencyScore:      typeof obj.efficiencyScore === 'number'      ? obj.efficiencyScore      : null,
    antiPatterns,
    taskCount:            typeof obj.taskCount === 'number'            ? obj.taskCount            : 0,
    taskSuccessRate:      typeof obj.taskSuccessRate === 'number'      ? obj.taskSuccessRate      : null,
    toolSuccessRate:      typeof obj.toolSuccessRate === 'number'      ? obj.toolSuccessRate      : null,
    contextCompressions:  typeof obj.contextCompressions === 'number'  ? obj.contextCompressions  : 0,
    agentSpawns:          typeof obj.agentSpawns === 'number'          ? obj.agentSpawns          : 0,
    userMessages:         typeof obj.userMessages === 'number'         ? obj.userMessages         : 0,
    assistantMessages:    typeof obj.assistantMessages === 'number'    ? obj.assistantMessages    : 0,
    userCorrections:      typeof obj.userCorrections === 'number'      ? obj.userCorrections      : 0,
    outcome:              typeof obj.outcome === 'string'              ? obj.outcome              : 'unknown',
    platform:             typeof obj.platform === 'string'             ? obj.platform             : undefined,
  };
}

function parseSessionFilename(filename: string): SessionFileInfo | null {
  // Expected format: YYYY-MM-DD_sessionId.json
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(.+)\.json$/);
  if (!match) return null;
  return {
    filename,
    date: match[1],
    sessionId: match[2],
  };
}
