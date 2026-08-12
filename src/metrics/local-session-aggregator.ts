/**
 * Per-real-session aggregation for `--local` (and other unscoped) dashboard
 * processes.
 *
 * Background: a session's own MCP engine normally owns `buffer-<sessionId>.jsonl`
 * (announced via an `active-<sessionId>.pid` heartbeat) and persists that
 * session itself. A `--local` dashboard has no such ownership — it drains every
 * *unowned* buffer destructively and folds the events into trackers keyed by its
 * own synthetic `local-<ts>` identity, which `persistSession()` deliberately
 * skips. Under Claude Code that is fine, because every session has an engine.
 *
 * Under GitHub Copilot it is not: VS Code runs one MCP server per *window* and
 * that engine pins a single session id at startup, while a window has many chat
 * sessions. Tool calls made in any other chat land in an unowned buffer, get
 * drained by the dashboard, and are therefore never written to disk — the live
 * view is correct and rich while `sessions/` stays empty or all-zero.
 *
 * Every drained record already carries its true `sessionId` (that is how
 * `/api/sessions/live` reconstructs per-session timelines), so the dashboard has
 * everything it needs to persist real sessions itself. This module keeps a
 * lightweight per-session rollup so it can do exactly that.
 */

import { spawnSync } from 'node:child_process';
import type { ReplayTimelineEntry, ToolCallRecord } from '../storage/types.js';
import type { ModelBreakdownEntry } from './model-usage-tracker.js';
import { QualityProxyTracker } from './quality-proxy-tracker.js';
import { ToolSelectionScorer, toToolSelectionSummary } from './tool-selection-scorer.js';

/** Matches SessionTracker's own cap so session files stay bounded. */
const MAX_TIMELINE_ENTRIES = 10_000;

const GIT_OPTS = {
  encoding: 'utf-8' as const,
  timeout: 2000,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
};

export interface LocalSessionRollup {
  sessionId: string;
  startTime: number;
  endTime: number;
  toolCallCount: number;
  toolBreakdown: Record<string, number>;
  filesModified: Set<string>;
  cwd: string | null;
  timeline: ReplayTimelineEntry[];
  /** Live records kept for sequence-sensitive tool-selection scoring. */
  records: ToolCallRecord[];
  /** Per-session quality tracker, so raw counts survive into the summary. */
  quality: QualityProxyTracker;
  modelBreakdown: Map<
    string,
    { requestCount: number; input: number; output: number; cost: number }
  >;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  models: Set<string>;
  successCount: number;
}

/** Parse `owner/name` out of a git remote URL. Null when it isn't recognizable. */
export function repoNameFromRemote(remote: string | null | undefined): string | null {
  if (typeof remote !== 'string') return null;
  const match = remote.trim().match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

/**
 * Resolves a directory to its repo's `owner/name`, shelling out at most once per
 * distinct directory. Returns null for non-repos and for repos with no origin.
 */
export class RepoNameResolver {
  private readonly cache = new Map<string, string | null>();

  resolve(dir: string | null | undefined): string | null {
    if (typeof dir !== 'string' || dir.length === 0) return null;
    const cached = this.cache.get(dir);
    if (cached !== undefined) return cached;

    let repoName: string | null = null;
    try {
      const remote = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], GIT_OPTS);
      if (remote.status === 0 && typeof remote.stdout === 'string') {
        repoName = repoNameFromRemote(remote.stdout);
      }
    } catch {
      repoName = null;
    }
    this.cache.set(dir, repoName);
    return repoName;
  }

  /** Repo root (`git rev-parse --show-toplevel`) for a directory, or null. */
  root(dir: string | null | undefined): string | null {
    if (typeof dir !== 'string' || dir.length === 0) return null;
    try {
      const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], GIT_OPTS);
      if (result.status === 0 && typeof result.stdout === 'string') {
        const root = result.stdout.trim();
        return root.length > 0 ? root : null;
      }
    } catch {
      /* not a repo */
    }
    return null;
  }
}

/**
 * Accumulates tool-call and token activity per real session id. Synthetic ids
 * (`local-`, `proxy-`, `pending-`) are rejected: they are MCP-internal
 * bookkeeping, not real sessions, and persisting them produces the confusing
 * duplicate rows `persistSession()` already guards against.
 */
export class LocalSessionAggregator {
  private readonly sessions = new Map<string, LocalSessionRollup>();

  private static isReal(sessionId: string | null | undefined): sessionId is string {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    return (
      !sessionId.startsWith('local-') &&
      !sessionId.startsWith('proxy-') &&
      !sessionId.startsWith('pending-')
    );
  }

  private ensure(sessionId: string, timestamp: number): LocalSessionRollup {
    let rollup = this.sessions.get(sessionId);
    if (!rollup) {
      rollup = {
        sessionId,
        startTime: timestamp,
        endTime: timestamp,
        toolCallCount: 0,
        toolBreakdown: {},
        filesModified: new Set(),
        cwd: null,
        timeline: [],
        records: [],
        quality: new QualityProxyTracker(),
        modelBreakdown: new Map(),
        costUsd: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        models: new Set(),
        successCount: 0,
      };
      this.sessions.set(sessionId, rollup);
    }
    if (timestamp < rollup.startTime) rollup.startTime = timestamp;
    if (timestamp > rollup.endTime) rollup.endTime = timestamp;
    return rollup;
  }

  recordToolCall(record: {
    sessionId?: string | null;
    toolName?: string;
    timestamp?: number;
    durationMs?: number | null;
    success?: boolean;
    cwd?: unknown;
    filePath?: unknown;
    command?: unknown;
    isTestCommand?: boolean;
    isBuildCommand?: boolean;
    isLintCommand?: boolean;
    errorType?: unknown;
  }): void {
    if (!LocalSessionAggregator.isReal(record.sessionId)) return;
    const timestamp = record.timestamp ?? Date.now();
    const rollup = this.ensure(record.sessionId, timestamp);
    rollup.toolCallCount += 1;
    if (record.success !== false) rollup.successCount += 1;
    const tool = record.toolName ?? 'unknown';
    rollup.toolBreakdown[tool] = (rollup.toolBreakdown[tool] ?? 0) + 1;
    if (typeof record.cwd === 'string' && record.cwd.length > 0) rollup.cwd = record.cwd;
    if (typeof record.filePath === 'string' && record.filePath.length > 0) {
      rollup.filesModified.add(record.filePath);
    }

    // Persisting the per-call timeline is what lets a restarted process replay
    // this session (git activity, anti-pattern analysis). Capped the same way
    // SessionTracker caps its own timeline so a long session can't grow the
    // session file without bound.
    if (rollup.timeline.length < MAX_TIMELINE_ENTRIES) {
      rollup.timeline.push({
        timestamp,
        toolName: tool,
        durationMs: record.durationMs ?? null,
        success: record.success !== false,
        ...(typeof record.filePath === 'string' && { filePath: record.filePath }),
        ...(typeof record.command === 'string' && { command: record.command }),
        ...(record.isTestCommand === true && { isTestCommand: true }),
        ...(record.isBuildCommand === true && { isBuildCommand: true }),
        ...(record.isLintCommand === true && { isLintCommand: true }),
        ...(typeof record.errorType === 'string' && { errorType: record.errorType }),
      });
    }

    // Feed the real trackers rather than reimplementing their heuristics, so a
    // rehydrated panel shows exactly what the live one would have shown.
    const fullRecord = record as unknown as ToolCallRecord;
    rollup.quality.recordToolCall(fullRecord);
    if (rollup.records.length < MAX_TIMELINE_ENTRIES) rollup.records.push(fullRecord);
  }

  recordTokenUsage(
    sessionId: string | null | undefined,
    usage: {
      timestamp?: number;
      costUsd?: number;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): void {
    if (!LocalSessionAggregator.isReal(sessionId)) return;
    const rollup = this.ensure(sessionId, usage.timestamp ?? Date.now());
    rollup.costUsd += usage.costUsd ?? 0;
    rollup.tokensInput += usage.inputTokens ?? 0;
    rollup.tokensOutput += usage.outputTokens ?? 0;
    rollup.tokensCacheRead += usage.cacheReadTokens ?? 0;
    rollup.tokensCacheCreation += usage.cacheCreationTokens ?? 0;
    if (usage.model) {
      rollup.models.add(usage.model);
      const entry = rollup.modelBreakdown.get(usage.model) ?? {
        requestCount: 0,
        input: 0,
        output: 0,
        cost: 0,
      };
      entry.requestCount += 1;
      entry.input += usage.inputTokens ?? 0;
      entry.output += usage.outputTokens ?? 0;
      entry.cost += usage.costUsd ?? 0;
      rollup.modelBreakdown.set(usage.model, entry);
    }
  }

  /** Distinct working directories seen across all sessions. */
  cwds(): string[] {
    const out = new Set<string>();
    for (const rollup of this.sessions.values()) {
      if (rollup.cwd) out.add(rollup.cwd);
    }
    return [...out];
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Session summaries ready for `SessionStore.saveSession()`. Only sessions with
   * observed tool calls are returned — a token-only rollup would be filtered out
   * of `/api/sessions` anyway (it requires `toolCallCount > 0`), and writing it
   * would burn a file that the empty-summary guard then has to defend.
   */
  toSummaries(context: {
    developer: string;
    platform?: string | null;
    outcome: string;
    repoResolver: RepoNameResolver;
    toolSelectionScorer: ToolSelectionScorer;
  }): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const rollup of this.sessions.values()) {
      if (rollup.toolCallCount === 0) continue;
      const models = [...rollup.models];
      out.push({
        sessionId: rollup.sessionId,
        sessionName: null,
        repoName: context.repoResolver.resolve(rollup.cwd),
        startTime: rollup.startTime,
        endTime: rollup.endTime,
        durationMs: Math.max(0, rollup.endTime - rollup.startTime),
        toolCallCount: rollup.toolCallCount,
        toolBreakdown: { ...rollup.toolBreakdown },
        developer: context.developer,
        model: models.length === 1 ? models[0] : null,
        filesRead: [],
        filesModified: [...rollup.filesModified],
        timeline: rollup.timeline.length > 0 ? [...rollup.timeline] : undefined,
        // These three fields are what let the dashboard rebuild its
        // Model Usage / Quality / Tool Selection panels after a restart: the
        // API combines them across today's persisted sessions. Without them a
        // restarted process shows empty panels despite having the history.
        modelBreakdown: modelBreakdownOf(rollup),
        qualityProxy: rollup.quality.getRawCounts(),
        toolSelectionMetrics:
          rollup.records.length > 0
            ? toToolSelectionSummary(context.toolSelectionScorer.scoreSession(rollup.records))
            : null,
        linesAdded: 0,
        linesRemoved: 0,
        bashCommandCount: 0,
        testRunCount: 0,
        testPassCount: 0,
        buildRunCount: 0,
        buildPassCount: 0,
        estimatedCostUsd: rollup.costUsd > 0 ? rollup.costUsd : null,
        subagentCostUsd: 0,
        tokensInput: rollup.tokensInput,
        tokensOutput: rollup.tokensOutput,
        tokensThinking: 0,
        tokensCacheRead: rollup.tokensCacheRead,
        tokensCacheCreation: rollup.tokensCacheCreation,
        cacheSavingsUsd: 0,
        efficiencyScore: null,
        antiPatterns: [],
        taskCount: 0,
        taskSuccessRate: null,
        toolSuccessRate:
          rollup.toolCallCount > 0 ? rollup.successCount / rollup.toolCallCount : null,
        contextCompressions: 0,
        agentSpawns: 0,
        userMessages: 0,
        assistantMessages: 0,
        userCorrections: 0,
        outcome: context.outcome,
        platform: context.platform ?? null,
      });
    }
    return out;
  }
}

/**
 * Collects today's commits across several repos.
 *
 * The stock hydration runs `git log` with no `cwd`, so it inherits the dashboard
 * process's own working directory — reporting whichever repo the dashboard
 * happens to have been started in rather than the repos actually being worked
 * on, and (having no `--author` filter) counting other people's commits in it.
 * Scanning an explicit set of roots and filtering by author fixes both.
 *
 * `since` is passed per call rather than captured once so a long-lived process
 * rolls over at midnight instead of reporting "today" relative to its start day.
 */
export interface CollectedCommit {
  hash: string;
  timestamp: number;
  repo: string | null;
  subject: string | null;
  url: string | null;
}

/**
 * Build a browsable GitHub commit URL from a git remote. Handles both SSH
 * (`git@github.com:owner/repo.git`) and HTTPS remotes, and returns null for
 * hosts we can't confidently map so the UI degrades to plain text rather than
 * rendering a broken link.
 */
export function commitUrlFromRemote(remote: string | null, hash: string): string | null {
  if (!remote || !hash) return null;
  const trimmed = remote.trim().replace(/\.git$/, '');
  const ssh = /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+)$/.exec(trimmed);
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(trimmed);
  const match = ssh ?? https;
  if (!match) return null;
  const [, host, path] = match;
  if (!host || !path) return null;
  return `https://${host}/${path}/commit/${hash}`;
}

function gitOut(root: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync('git', ['-C', root, ...args], GIT_OPTS);
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function collectCommitsAcrossRepos(
  repoRoots: readonly string[],
  since: string,
  authorEmail: string | null,
): CollectedCommit[] {
  const seen = new Set<string>();
  const commits: CollectedCommit[] = [];

  for (const root of repoRoots) {
    // %x1f (unit separator) can't appear in a hash, epoch, or subject, so it is
    // a safe delimiter where a space would break on multi-word subjects.
    const args = ['log', `--since=${since}T00:00:00`, '--format=%H%x1f%ct%x1f%s'];
    if (authorEmail) args.push(`--author=${authorEmail}`);

    const stdout = gitOut(root, args);
    if (stdout === null) continue;

    const remote = gitOut(root, ['remote', 'get-url', 'origin']);
    const repo = repoNameFromRemote(remote);

    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const [hash, epochStr, subject] = line.split('\x1f');
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      commits.push({
        hash,
        timestamp: parseInt(epochStr ?? '0', 10) * 1000,
        repo,
        subject: subject ?? null,
        url: commitUrlFromRemote(remote, hash),
      });
    }
  }

  return commits;
}

/** Current git identity, used to keep other contributors' commits out of the count. */
export function resolveAuthorEmail(dir: string): string | null {
  try {
    const result = spawnSync('git', ['-C', dir, 'config', 'user.email'], GIT_OPTS);
    if (result.status === 0 && typeof result.stdout === 'string') {
      const email = result.stdout.trim();
      return email.length > 0 ? email : null;
    }
  } catch {
    /* no git identity */
  }
  return null;
}

/** Shape the per-model tallies the way `combineBreakdowns()` expects them. */
function modelBreakdownOf(rollup: {
  modelBreakdown: Map<
    string,
    { requestCount: number; input: number; output: number; cost: number }
  >;
}): Record<string, ModelBreakdownEntry> {
  const out: Record<string, ModelBreakdownEntry> = {};
  for (const [model, e] of rollup.modelBreakdown) {
    out[model] = {
      requestCount: e.requestCount,
      totalInputTokens: e.input,
      totalOutputTokens: e.output,
      totalCostUsd: e.cost,
    };
  }
  return out;
}
