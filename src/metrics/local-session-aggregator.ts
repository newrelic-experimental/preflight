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
import { localDateKey } from '../lib/date.js';
import type { ReplayTimelineEntry, ToolCallRecord } from '../storage/types.js';
import { hasAttributableActivity, type FullSessionSummary } from '../storage/session-store.js';
import { backfillAgentId } from './agent-partition.js';
import type { ModelBreakdownEntry } from './model-usage-tracker.js';
import { QualityProxyTracker } from './quality-proxy-tracker.js';
import { ToolSelectionScorer, toToolSelectionSummary } from './tool-selection-scorer.js';

/** Matches SessionTracker's own cap so session files stay bounded. */
const MAX_TIMELINE_ENTRIES = 10_000;

const GIT_OPTS = {
  encoding: 'utf-8' as const,
  timeout: 2000,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
  // GIT_DIR/GIT_WORK_TREE (set by git for hook subprocesses, among other
  // cases) override `-C <dir>`, silently redirecting these calls to whatever
  // repo the ambient env points at instead of the target directory.
  get env() {
    return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  },
};

export interface ModelBreakdownTally {
  requestCount: number;
  input: number;
  output: number;
  cost: number;
  cacheRead: number;
  cacheCreation: number;
  thinking: number;
}

/**
 * What an existing `sessions/*.json` already says about a session's cost.
 * `FullSessionSummary` structurally satisfies this, so `SessionStore.loadSession`
 * can be passed as `persistedCostBaseline` unchanged.
 */
export type PersistedCostBaseline = Pick<
  FullSessionSummary,
  'estimatedCostUsd' | 'subagentCostUsd' | 'costByDayUsd' | 'subagentCostByDayUsd'
>;

export interface LocalSessionAggregatorOptions {
  /**
   * Called at most once per session, on that session's first subagent
   * (`agentId`-tagged) usage — not at rollup creation, because an unscoped
   * process creates a rollup from a session's first drained hook event,
   * before that session's engine has written anything to disk (see
   * `recordTokenUsage`'s doc comment). Returning null means "nothing on
   * disk yet"; the rollup then starts at 0 as before.
   */
  readonly persistedCostBaseline?: (sessionId: string) => PersistedCostBaseline | null;
}

export interface LocalSessionRollup {
  sessionId: string;
  startTime: number;
  endTime: number;
  toolCallCount: number;
  toolBreakdown: Record<string, number>;
  filesRead: Set<string>;
  filesModified: Set<string>;
  cwd: string | null;
  /**
   * First non-null platform seen on this session's own records. A drained
   * session almost never belongs to the draining process — e.g. a
   * dashboard's own `activePlatform` reflects *its* environment, not the
   * Copilot/Claude Code process whose buffer it drained (see the module doc
   * above) — so this must win over `toSummaries()`'s `context.platform`
   * fallback, the same way `nr-ingest.ts` prefers `record.sessionId` over
   * the ingesting process's own trace id.
   */
  platform: string | null;
  timeline: ReplayTimelineEntry[];
  /** Live records kept for sequence-sensitive tool-selection scoring. */
  records: ToolCallRecord[];
  /** Per-session quality tracker, so raw counts survive into the summary. */
  quality: QualityProxyTracker;
  modelBreakdown: Map<string, ModelBreakdownTally>;
  costUsd: number;
  /** All-in cost by local-day key (`localDateKey(usage.timestamp)`); same key
   *  space as `CostTracker.recordTokenUsage`, so a `--stdio`-written bucket
   *  and a `--local`-written bucket for the same turn agree on the day. */
  costByDayUsd: Map<string, number>;
  /** Portion of costUsd from agentId-tagged (subagent) usage. */
  subagentCostUsd: number;
  /** Subagent-attributed portion of costByDayUsd, same key space. */
  subagentCostByDayUsd: Map<string, number>;
  /** Set once the persisted baseline has been folded in — see recordTokenUsage. */
  costBaselineApplied: boolean;
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
 * Strips heredoc bodies from a shell command so its *text* is not mistaken for
 * its *actions*. Agents routinely pipe scripts inline (`python3 - <<'PY' ...`),
 * and a body that merely mentions git words made the command classify as a real
 * `push`/`log` and made a `cd` inside the script hijack repo attribution.
 *
 * The line introducing the heredoc is kept — `git commit -F- <<'MSG'` is still
 * a commit.
 */
export function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;

  const startRe = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;
  const kept: string[] = [];
  const pending: { tag: string; stripTabs: boolean }[] = [];

  for (const line of command.split('\n')) {
    if (pending.length > 0) {
      const current = pending[0];
      const candidate = current.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate.trim() === current.tag) pending.shift();
      continue;
    }

    kept.push(line);
    startRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = startRe.exec(line)) !== null) {
      const tag = match[2] ?? match[3] ?? match[4];
      if (tag) pending.push({ tag, stripTabs: match[1] === '-' });
    }
  }

  return kept.join('\n');
}

/**
 * Directory a git command actually acts on. Work is often driven from one
 * workspace but targeted at another repo (`git -C <path>`, or `cd <path> &&
 * git ...`), so the tool call's cwd alone would mislabel those events with the
 * driving repo instead of the one being changed.
 */
export function gitCommandTargetDir(
  rawCommand: string,
  cwd: string | null | undefined,
): string | null {
  const command = stripHeredocBodies(rawCommand);
  const dashC = /(?:^|[|&;]\s*)git\s+(?:-c\s+\S+\s+)*-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(
    command,
  );
  if (dashC) return dashC[1] ?? dashC[2] ?? dashC[3] ?? null;

  // `cd <path> && git ...` — the last cd before the git call wins.
  const cd = /(?:^|[|&;]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/.exec(command);
  if (cd) {
    const dir = cd[1] ?? cd[2] ?? cd[3] ?? null;
    if (dir && !dir.startsWith('-')) return dir;
  }

  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
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
  /** Repo dirs targeted by git commands but never entered as a cwd. */
  private readonly gitTargetDirs = new Set<string>();
  private readonly persistedCostBaseline: LocalSessionAggregatorOptions['persistedCostBaseline'];

  constructor(options: LocalSessionAggregatorOptions = {}) {
    this.persistedCostBaseline = options.persistedCostBaseline;
  }

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
        filesRead: new Set(),
        filesModified: new Set(),
        cwd: null,
        platform: null,
        timeline: [],
        records: [],
        quality: new QualityProxyTracker(),
        modelBreakdown: new Map(),
        costUsd: 0,
        costByDayUsd: new Map(),
        subagentCostUsd: 0,
        subagentCostByDayUsd: new Map(),
        costBaselineApplied: false,
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
    platform?: string | null;
    /** Join key for a late `backfillAgentId()` pass in `toSummaries()`. */
    toolUseId?: unknown;
    agentId?: unknown;
  }): void {
    if (!LocalSessionAggregator.isReal(record.sessionId)) return;
    const timestamp = record.timestamp ?? Date.now();
    const rollup = this.ensure(record.sessionId, timestamp);
    rollup.toolCallCount += 1;
    if (record.success !== false) rollup.successCount += 1;
    const tool = record.toolName ?? 'unknown';
    rollup.toolBreakdown[tool] = (rollup.toolBreakdown[tool] ?? 0) + 1;
    if (typeof record.cwd === 'string' && record.cwd.length > 0) rollup.cwd = record.cwd;
    if (
      rollup.platform === null &&
      typeof record.platform === 'string' &&
      record.platform.length > 0
    ) {
      rollup.platform = record.platform;
    }
    // A `git -C <path>` / `cd <path> && git` command works on a repo that the
    // cwd never names, so without this the repo would be invisible to commit
    // hydration — the whole point of driving other repos from one workspace.
    if (typeof record.command === 'string' && /(?:^|[|&;]\s*)(?:cd\s|git\s)/.test(record.command)) {
      const target = gitCommandTargetDir(record.command, record.cwd as string | undefined);
      if (target) this.gitTargetDirs.add(target);
    }
    // Matches TaskDetector's Read-vs-Write/Edit split (task-detector.ts) —
    // without gating by tool, a read-only exploration session would come
    // back as filesModified: [...everything it opened], which misclassifies
    // it in cost-per-outcome (classifySessionOutcome branches on
    // filesModified.length > 0) and, once merged into a real engine's own
    // accurate list via mergeSummaries()'s union, permanently pollutes it.
    if (typeof record.filePath === 'string' && record.filePath.length > 0) {
      if (tool === 'Read') {
        rollup.filesRead.add(record.filePath);
      } else if (tool === 'Write' || tool === 'Edit') {
        rollup.filesModified.add(record.filePath);
      }
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
        ...(typeof record.cwd === 'string' && { cwd: record.cwd }),
        ...(record.isTestCommand === true && { isTestCommand: true }),
        ...(record.isBuildCommand === true && { isBuildCommand: true }),
        ...(record.isLintCommand === true && { isLintCommand: true }),
        ...(typeof record.errorType === 'string' && { errorType: record.errorType }),
        ...(typeof record.agentId === 'string' && { agentId: record.agentId }),
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
      thinkingTokens?: number;
      /**
       * Present iff this usage came from a subagent transcript turn — the SAME
       * discriminator `CostTracker.recordTokenUsage`'s `ctx.agentId` uses, so
       * "what counts as subagent cost" has one definition across both
       * trackers. Absent for parent-transcript token events.
       */
      agentId?: string;
    },
  ): void {
    if (!LocalSessionAggregator.isReal(sessionId)) return;
    const timestamp = usage.timestamp ?? Date.now();
    const rollup = this.ensure(sessionId, timestamp);
    // Seed from disk on this session's first subagent-attributed usage, not at
    // rollup creation: an unscoped process creates a rollup from a session's
    // first drained hook event, which happens before that session's own
    // engine has written anything to sessions/*.json — seeding at creation
    // would read nothing and lose the engine's eventual total on restart
    // under the max-based merge in mergeSummaries.
    if (usage.agentId !== undefined && !rollup.costBaselineApplied) {
      this.applyPersistedBaseline(sessionId, rollup);
    }
    const dayKey = localDateKey(timestamp);
    const usd = usage.costUsd ?? 0;
    rollup.costUsd += usd;
    rollup.costByDayUsd.set(dayKey, (rollup.costByDayUsd.get(dayKey) ?? 0) + usd);
    if (usage.agentId !== undefined) {
      rollup.subagentCostUsd += usd;
      rollup.subagentCostByDayUsd.set(dayKey, (rollup.subagentCostByDayUsd.get(dayKey) ?? 0) + usd);
    }
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
        cacheRead: 0,
        cacheCreation: 0,
        thinking: 0,
      };
      entry.requestCount += 1;
      entry.input += usage.inputTokens ?? 0;
      entry.output += usage.outputTokens ?? 0;
      entry.cost += usage.costUsd ?? 0;
      entry.cacheRead += usage.cacheReadTokens ?? 0;
      entry.cacheCreation += usage.cacheCreationTokens ?? 0;
      entry.thinking += usage.thinkingTokens ?? 0;
      rollup.modelBreakdown.set(usage.model, entry);
    }
  }

  /**
   * Folds a session's on-disk cost quadruple into the rollup, additively,
   * once. Additive (not assigned) because the rollup may already hold parent
   * cost this process drained during the engine's pending-session window,
   * which no other process saw — assigning would discard it. The whole
   * quadruple (not just the subagent pair) is seeded so the persisted
   * invariant `estimatedCostUsd >= subagentCostUsd` survives the fold; seeding
   * only the subagent pair could leave a merged file whose subagent figure
   * exceeds its all-in figure.
   */
  private applyPersistedBaseline(sessionId: string, rollup: LocalSessionRollup): void {
    rollup.costBaselineApplied = true;
    const baseline = this.persistedCostBaseline?.(sessionId) ?? null;
    if (baseline === null) return;
    rollup.costUsd += baseline.estimatedCostUsd ?? 0;
    rollup.subagentCostUsd += baseline.subagentCostUsd;
    for (const [day, usd] of Object.entries(baseline.costByDayUsd ?? {})) {
      rollup.costByDayUsd.set(day, (rollup.costByDayUsd.get(day) ?? 0) + usd);
    }
    for (const [day, usd] of Object.entries(baseline.subagentCostByDayUsd ?? {})) {
      rollup.subagentCostByDayUsd.set(day, (rollup.subagentCostByDayUsd.get(day) ?? 0) + usd);
    }
  }

  /** Distinct working directories seen across all sessions. */
  cwds(): string[] {
    const out = new Set<string>(this.gitTargetDirs);
    for (const rollup of this.sessions.values()) {
      if (rollup.cwd) out.add(rollup.cwd);
    }
    return [...out];
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Session summaries ready for `SessionStore.saveSession()`. Only sessions
   * with attributable activity are returned (see `hasAttributableActivity`) —
   * a rollup with neither tool calls nor subagent spend would be filtered out
   * of `/api/sessions` anyway, and writing it would burn a file that the
   * empty-summary guard then has to defend. A subagent-only rollup (dead
   * parent, tail still being read) DOES qualify: it has real dollars even
   * though its parent timeline and toolCallCount are both zero.
   */
  toSummaries(context: {
    developer: string;
    platform?: string | null;
    outcome: string;
    repoResolver: RepoNameResolver;
    toolSelectionScorer: ToolSelectionScorer;
    /**
     * Live `toolUseId → agentId` map from this process's SubagentWatcher.
     * Applied immediately before `scoreSession()`, matching the late
     * `backfillAgentId()` pass in `src/index.ts` before anti-pattern
     * analysis — session-close has had more time than hook-buffer intake
     * for transcript-tailing to catch up (#683).
     */
    toolUseIdToAgentId?: ReadonlyMap<string, string>;
  }): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const rollup of this.sessions.values()) {
      if (!hasAttributableActivity(rollup)) continue;
      const models = [...rollup.models];
      // Intake may have missed the join (~100ms hook poll vs ~2s transcript
      // poll). Re-apply here when the live map is available. Records are
      // not mutated — backfillAgentId returns a new object only on a hit.
      const toolUseIdToAgentId = context.toolUseIdToAgentId;
      const scoredRecords = toolUseIdToAgentId
        ? rollup.records.map((r) => backfillAgentId(r, toolUseIdToAgentId))
        : rollup.records;
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
        filesRead: [...rollup.filesRead],
        filesModified: [...rollup.filesModified],
        timeline: rollup.timeline.length > 0 ? [...rollup.timeline] : undefined,
        // These three fields are what let the dashboard rebuild its
        // Model Usage / Quality / Tool Selection panels after a restart: the
        // API combines them across today's persisted sessions. Without them a
        // restarted process shows empty panels despite having the history.
        modelBreakdown: modelBreakdownOf(rollup),
        qualityProxy: rollup.quality.getRawCounts(),
        toolSelectionMetrics:
          scoredRecords.length > 0
            ? toToolSelectionSummary(context.toolSelectionScorer.scoreSession(scoredRecords))
            : null,
        linesAdded: 0,
        linesRemoved: 0,
        bashCommandCount: 0,
        testRunCount: 0,
        testPassCount: 0,
        buildRunCount: 0,
        buildPassCount: 0,
        estimatedCostUsd: rollup.costUsd > 0 ? rollup.costUsd : null,
        subagentCostUsd: rollup.subagentCostUsd,
        // Emitted ONLY when non-empty. `undefined` is the documented "this
        // rollup has no per-day buckets, fall back to the timeline pro-rate"
        // signal the aggregate route keys on; writing `{}` would assert
        // "authoritatively $0 today" and silently zero a row that should have
        // pro-rated. Absent and empty are NOT the same value here.
        ...(rollup.costByDayUsd.size > 0
          ? { costByDayUsd: Object.fromEntries(rollup.costByDayUsd) }
          : {}),
        ...(rollup.subagentCostByDayUsd.size > 0
          ? { subagentCostByDayUsd: Object.fromEntries(rollup.subagentCostByDayUsd) }
          : {}),
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
        platform: rollup.platform ?? context.platform ?? null,
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
  /** The worktree root this commit is attributed to — see
   *  `collectCommitsAcrossRepos`'s two-pass ordering for how that's chosen
   *  among several roots that can all see the same commit. */
  root: string;
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

/**
 * A root is its own primary checkout when its `--git-dir` and
 * `--git-common-dir` are the same path — true for a normal clone, false for
 * a linked worktree (whose `--git-dir` is `<repoKey>/worktrees/<name>`).
 * Both are read from one `rev-parse` call to keep this to a single extra
 * `gitOut` per root.
 */
const primaryCheckoutCache = new Map<string, boolean>();

function isPrimaryCheckout(root: string): boolean {
  const cached = primaryCheckoutCache.get(root);
  if (cached !== undefined) return cached;
  const out = gitOut(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  ]);
  const [gitDir, commonDir] = (out ?? '').split('\n');
  const primary = out === null || gitDir === commonDir;
  primaryCheckoutCache.set(root, primary);
  return primary;
}

export function collectCommitsAcrossRepos(
  repoRoots: readonly string[],
  since: string,
  authorEmail: string | null,
): CollectedCommit[] {
  const seen = new Set<string>();
  const commits: CollectedCommit[] = [];

  // Primary checkouts first: a commit on `main` is reachable from both the
  // primary and a feature worktree, and the first root to see it wins.
  const primary = new Map(repoRoots.map((root) => [root, isPrimaryCheckout(root)]));
  const orderedRoots = [...repoRoots].sort(
    (a, b) => Number(!primary.get(a)) - Number(!primary.get(b)),
  );

  const remotes = new Map<string, string | null>();
  const collect = (root: string, extraArgs: readonly string[]): void => {
    // %x1f (unit separator) can't appear in a hash, epoch, or subject, so it is
    // a safe delimiter where a space would break on multi-word subjects.
    // Author date (%at), not committer date: a rebase restamps every commit
    // with one committer time, which would move commits across days and
    // defeat pairing with the hook records that saw them being made.
    const args = ['log', `--since=${since}T00:00:00`, '--format=%H%x1f%at%x1f%s', ...extraArgs];
    if (authorEmail) args.push(`--author=${authorEmail}`);

    const stdout = gitOut(root, args);
    if (stdout === null) return;

    if (!remotes.has(root)) remotes.set(root, gitOut(root, ['remote', 'get-url', 'origin']));
    const remote = remotes.get(root) ?? null;
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
        root,
      });
    }
  };

  // Pass 1: HEAD-only, same as before — covers the overwhelmingly common
  // case (commits on the branch actually checked out) cheaply.
  for (const root of orderedRoots) collect(root, []);
  // Pass 2: every branch, so a commit whose worktree was since removed (the
  // branch itself still exists) still gets counted, attributed to whichever
  // remaining root can still see it.
  for (const root of orderedRoots) collect(root, ['--branches']);

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
  modelBreakdown: Map<string, ModelBreakdownTally>;
}): Record<string, ModelBreakdownEntry> {
  const out: Record<string, ModelBreakdownEntry> = {};
  for (const [model, e] of rollup.modelBreakdown) {
    out[model] = {
      requestCount: e.requestCount,
      totalInputTokens: e.input,
      totalOutputTokens: e.output,
      totalCostUsd: e.cost,
      totalCacheReadTokens: e.cacheRead,
      totalCacheCreationTokens: e.cacheCreation,
      totalThinkingTokens: e.thinking,
    };
  }
  return out;
}
