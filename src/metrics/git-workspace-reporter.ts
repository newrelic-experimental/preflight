import { spawnSync } from 'node:child_process';

import type { ReplayTimelineEntry, ToolCallRecord } from '../storage/types.js';
import { ActivityStore } from './git-activity-store.js';
import {
  GIT_LOG_SESSION_ID,
  GitActivityRecorder,
  type GitActivityRecord,
} from './git-activity-recorder.js';
import {
  UNATTRIBUTED_WORKSPACE_KEY,
  UNRESOLVED_REPO_KEY_PREFIX,
  WorktreeIdentityResolver,
  isPlaceholderIdentity,
  type WorktreeIdentity,
} from './git-workspace-identity.js';
import type { CollectedCommit } from './local-session-aggregator.js';
import {
  buildGitWorkspaceReport,
  reconcileHydratedCommits,
  type GitWorkspaceReport,
  type ScopeRef,
  type WorktreeLiveState,
} from './git-workspace-report.js';

// Same pattern as git-workspace-identity.ts / local-session-aggregator.ts:
// GIT_DIR/GIT_WORK_TREE (set by git for hook subprocesses, among other cases)
// override `-C <dir>`, silently redirecting these calls to whatever repo the
// ambient env points at instead of the target directory.
const GIT_OPTS = {
  encoding: 'utf-8' as const,
  timeout: 2000,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
  get env() {
    return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  },
};

const DEFAULT_LIVE_STATE_TTL_MS = 5 * 60_000;

/**
 * `GitWorkspaceReport` plus the exact `[since, until)` bounds `report()`
 * queried — the caller (a route/MCP tool) already resolved these from a
 * `window` string, and echoing them back is cheaper and less error-prone
 * than having every consumer re-derive "what does 'week' actually mean"
 * itself just to render a date range. Kept as a supertype of the pure
 * aggregator's own return type rather than a field on `GitWorkspaceReport`
 * itself — `buildGitWorkspaceReport` has no window of its own, only the
 * records it was handed, so it stays untouched.
 */
export interface GitWorkspaceReportWithWindow extends GitWorkspaceReport {
  readonly since: number;
  readonly until: number;
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

/** `internal/main` -> `main`, `origin/main` -> `main`. A ref with no `/` is
 *  returned unchanged. */
function stripRemotePrefix(ref: string): string {
  const idx = ref.indexOf('/');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

/**
 * Owns the live pipeline from raw tool calls to a queryable git workspace
 * report: its own `WorktreeIdentityResolver` + `ActivityStore` +
 * `GitActivityRecorder`, a registry of every workspace identity ever seen,
 * and a short-TTL cache of each workspace's live branch/divergence state.
 */
export class GitWorkspaceReporter {
  private readonly identityResolver = new WorktreeIdentityResolver();
  private readonly store = new ActivityStore<GitActivityRecord>();
  private readonly recorder: GitActivityRecorder;
  private readonly liveStateTtlMs: number;

  // Every workspaceKey ever seen, not just ones with recent activity — a
  // scope picker needs to show a workspace even in a window with no
  // activity in it (see knownWorkspaces()).
  private readonly knownWorkspacesRegistry = new Map<string, WorktreeIdentity>();
  private readonly liveStateCache = new Map<string, WorktreeLiveState>();

  constructor(config?: { readonly liveStateTtlMs?: number }) {
    this.recorder = new GitActivityRecorder(this.store, this.identityResolver);
    this.liveStateTtlMs = config?.liveStateTtlMs ?? DEFAULT_LIVE_STATE_TTL_MS;
  }

  /** Feed every drained tool-call record. Also updates the known-workspaces
   *  registry with whatever identity gets resolved for this record's cwd. */
  recordToolCall(record: ToolCallRecord): void {
    this.recorder.recordToolCall(record);
    const identity = this.identityResolver.resolve(record.cwd as string | undefined);
    if (identity) {
      this.knownWorkspacesRegistry.set(identity.worktreeKey, identity);
    }
  }

  /**
   * Ingest already-classified records directly (bypassing the
   * classify-from-ToolCallRecord path `recordToolCall` uses) — for replayed
   * historical sessions built by `replaySessionToActivityRecords` elsewhere.
   * `identities`, when given, is a workspaceKey -> identity map covering
   * whichever of `records`' workspaceKeys the caller was able to resolve
   * during replay (it already had to resolve identity per-entry to classify
   * cwd-based attribution, so it's the caller's to hand back here) — this is
   * what lets the known-workspaces registry learn about a workspace whose
   * only evidence is replayed history, not live tool calls.
   */
  ingestRecords(
    records: readonly GitActivityRecord[],
    identities?: ReadonlyMap<string, WorktreeIdentity>,
  ): void {
    for (const record of records) {
      this.store.ingest(record);
    }
    if (identities) {
      for (const [workspaceKey, identity] of identities) {
        this.knownWorkspacesRegistry.set(workspaceKey, identity);
      }
    }
  }

  /** Every known workspace's identity, for building a scope picker even
   *  before there's a report to show. */
  knownWorkspaces(): ReadonlyMap<string, WorktreeIdentity> {
    return this.knownWorkspacesRegistry;
  }

  /**
   * Ingest commits collected from `git log` (`collectCommitsAcrossRepos`) —
   * the only way a commit made outside a hook-observed `git commit` (a
   * terminal, a heredoc script, a session the watcher never saw) ever
   * reaches the weekly report. `commit.root` resolves to a workspace
   * identity exactly like a live tool call's `cwd` does; a root that isn't a
   * known git worktree (resolves to null) is skipped. The store's own
   * recordId dedup (keyed on `gitlog:<hash>`) makes calling this repeatedly
   * with overlapping commit sets a no-op for anything already ingested.
   */
  hydrateGitLog(commits: readonly CollectedCommit[]): void {
    for (const commit of commits) {
      const identity = this.identityResolver.resolve(commit.root);
      if (identity === null) continue;
      this.knownWorkspacesRegistry.set(identity.worktreeKey, identity);
      this.store.ingest({
        kind: 'git',
        sessionId: GIT_LOG_SESSION_ID,
        timestamp: commit.timestamp,
        recordId: `gitlog:${commit.hash}`,
        workspaceKey: identity.worktreeKey,
        gitEvent: {
          timestamp: commit.timestamp,
          type: 'commit',
          command: `git commit (${commit.hash})`,
          success: true,
          durationMs: null,
          repo: commit.repo,
          subject: commit.subject,
          url: commit.url,
          hash: commit.hash,
        },
      });
    }
  }

  /**
   * Samples live branch state for a workspace (branch, default branch,
   * ahead/behind), cached with a short TTL per worktreeKey so repeated calls
   * in a short window don't re-shell out. Never runs `git fetch` — this only
   * ever reads state git already has locally.
   */
  sampleLiveState(identity: WorktreeIdentity): WorktreeLiveState {
    const now = Date.now();
    const cached = this.liveStateCache.get(identity.worktreeKey);
    if (cached && now - cached.measuredAtMs < this.liveStateTtlMs) {
      return cached;
    }

    const state = this.computeLiveState(identity, now);
    this.liveStateCache.set(identity.worktreeKey, state);
    return state;
  }

  /**
   * The one method a future API/MCP layer calls. `since`/`until` are epoch
   * ms, already resolved by the caller. Queries the in-memory store for
   * records in [since, until), merges in `historical` records if given,
   * samples live state for every workspace with activity in the resulting
   * record set, and calls `buildGitWorkspaceReport`.
   *
   * The `identities` map `buildGitWorkspaceReport` needs comes from this
   * reporter's own `knownWorkspaces()` registry, merged with the caller's
   * `historicalIdentities` (identities the caller's own replay resolved for
   * `historical`'s records — this reporter never resolved them itself, so it
   * has no other way to know them). The live registry wins on key collision.
   * A workspaceKey with no identity in either map is skipped gracefully;
   * `buildGitWorkspaceReport` already logs a warning and drops any record
   * whose workspaceKey it can't resolve, so there is nothing extra to do here
   * for that case.
   */
  report(input: {
    readonly scope: ScopeRef;
    readonly since: number;
    readonly until: number;
    readonly historical?: readonly GitActivityRecord[];
    readonly historicalIdentities?: ReadonlyMap<string, WorktreeIdentity>;
  }): GitWorkspaceReportWithWindow {
    const { scope, since, until, historical, historicalIdentities } = input;

    const liveRecords = this.store.query({ since, until });
    // Dedup `historical` against what's already live, on the same
    // (workspaceKey, recordId) identity ActivityStore's own dedup uses
    // internally (a nested Map/Set there, a joined string here — same
    // identity, different representation): a session started today can
    // legitimately be replayed twice for the same window — once into this
    // reporter's own live store at startup (via ingestRecords), and again
    // here on every request that reads it back from SessionStore for a
    // historical window — and naive concatenation double-counted every
    // number for any such overlap.
    const keyOf = (r: GitActivityRecord): string => r.workspaceKey + '|' + r.recordId;
    const liveKeys = new Set(liveRecords.map(keyOf));
    // `historical` is the caller's own replay of whole session timelines, not
    // a store query — nothing upstream of this bounds it to `[since, until)`.
    // A session that started inside the window but ran past `until` would
    // otherwise contribute its post-window activity too, which is exactly the
    // "explicit time window" correctness this reporter exists to guarantee.
    const inWindow = (r: GitActivityRecord): boolean => r.timestamp >= since && r.timestamp < until;
    const dedupedHistorical = (historical ?? []).filter(
      (r) => inWindow(r) && !liveKeys.has(keyOf(r)),
    );
    const identities = new Map([...(historicalIdentities ?? []), ...this.knownWorkspacesRegistry]);
    adoptResolvedRepoKeys(identities);

    // Merge a hook-observed commit with its `git log`-hydrated counterpart
    // (same underlying commit, two sources) before anything downstream
    // counts commits — otherwise a hydrated commit that also has a matching
    // hook record would be counted twice.
    const records = reconcileHydratedCommits([...liveRecords, ...dedupedHistorical], identities);

    const liveStates = new Map<string, WorktreeLiveState>();
    const workspaceKeys = new Set(records.map((r) => r.workspaceKey));
    for (const key of workspaceKeys) {
      const identity = identities.get(key);
      if (identity) {
        liveStates.set(key, this.sampleLiveState(identity));
      }
    }

    // `nowMs: until` caps computeVelocityCore's open-ended "since last
    // commit" gap at the window's own boundary instead of real wall-clock
    // time — resolveWindowParam guarantees `until <= Date.now()` for every
    // window it produces, so this is always at least as tight as the old
    // always-Date.now() behavior, and strictly correct for a bounded past
    // window (e.g. "yesterday") where real "now" would reach outside the
    // range being reported.
    return {
      ...buildGitWorkspaceReport({ scope, records, identities, liveStates, nowMs: until }),
      since,
      until,
    };
  }

  /**
   * Compare-ref resolution ladder, first one that resolves wins:
   *   1. The branch's own configured upstream (`<branch>@{upstream}`) — NOT
   *      always `origin/<defaultBranch>`; a repo's real branch can track a
   *      differently-named remote (e.g. `internal/main`) while `origin/main`
   *      exists and diverges by hundreds of commits, so a hardcoded
   *      `origin/<default>` guess would be actively wrong.
   *   2. The repo's default branch on origin (`refs/remotes/origin/HEAD`).
   *   3. Give up — ahead/behind/defaultBranch all stay null.
   */
  private computeLiveState(identity: WorktreeIdentity, now: number): WorktreeLiveState {
    const root = identity.worktreeRoot;
    if (root === null) {
      return {
        branch: identity.branch,
        defaultBranch: null,
        ahead: null,
        behind: null,
        measuredAtMs: now,
      };
    }

    let compareRef: string | null = null;

    if (identity.branch !== null) {
      compareRef = gitOut(root, ['rev-parse', '--abbrev-ref', `${identity.branch}@{upstream}`]);
    }

    if (compareRef === null) {
      compareRef = gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    }

    if (compareRef === null) {
      return {
        branch: identity.branch,
        defaultBranch: null,
        ahead: null,
        behind: null,
        measuredAtMs: now,
      };
    }

    const defaultBranch = stripRemotePrefix(compareRef);
    // `git rev-list --left-right --count <left>...<right>` prints
    // "<count-of-left-only>\t<count-of-right-only>" — verified against a real
    // repo with a real ahead/behind divergence rather than assumed: with
    // `<upstream>...HEAD`, left is the upstream (what we're behind on) and
    // right is HEAD (what we're ahead by), so the output is "<behind>\t<ahead>".
    const countsOut = gitOut(root, ['rev-list', '--count', '--left-right', `${compareRef}...HEAD`]);
    if (countsOut === null) {
      return {
        branch: identity.branch,
        defaultBranch,
        ahead: null,
        behind: null,
        measuredAtMs: now,
      };
    }

    const [behindStr, aheadStr] = countsOut.split('\t');
    const behind = behindStr !== undefined ? parseInt(behindStr, 10) : NaN;
    const ahead = aheadStr !== undefined ? parseInt(aheadStr, 10) : NaN;

    return {
      branch: identity.branch,
      defaultBranch,
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
      measuredAtMs: now,
    };
  }
}

export interface ReplayedActivity {
  readonly records: readonly GitActivityRecord[];
  readonly identities: ReadonlyMap<string, WorktreeIdentity>;
}

// Prefix for a synthetic identity representing "this repo, but we don't know
// which worktree" — the fallback used when a session predates the `cwd`
// field on ReplayTimelineEntry but still carries a resolved `repoName`.
/**
 * Rewrites, in place, every "this repo, worktree unknown" placeholder's
 * `repoKey` to that of a resolved worktree sharing its `repoName`, so the
 * report groups and scopes it with that repo instead of as a look-alike
 * second repo. Its `worktreeKey` stays the placeholder key — the activity
 * still can't be pinned to one worktree. With two resolved clones of the
 * same remote the lexically smallest `repoKey` wins, purely so the choice is
 * stable across requests. A placeholder with no resolved sibling is left
 * alone.
 */
function adoptResolvedRepoKeys(identities: Map<string, WorktreeIdentity>): void {
  const resolvedRepoKeyByName = new Map<string, string>();
  for (const identity of identities.values()) {
    if (identity.repoName === null || isPlaceholderIdentity(identity)) continue;
    const existing = resolvedRepoKeyByName.get(identity.repoName);
    if (existing === undefined || identity.repoKey < existing) {
      resolvedRepoKeyByName.set(identity.repoName, identity.repoKey);
    }
  }
  for (const [key, identity] of identities) {
    if (
      identity.repoName === null ||
      !identity.worktreeKey.startsWith(UNRESOLVED_REPO_KEY_PREFIX)
    ) {
      continue;
    }
    const repoKey = resolvedRepoKeyByName.get(identity.repoName);
    if (repoKey !== undefined) identities.set(key, { ...identity, repoKey });
  }
}

/**
 * Re-classifies a persisted session's timeline into `GitActivityRecord`s,
 * using the SAME `GitActivityRecorder` dispatch the live path uses (so a
 * regex improvement in the classifier retro-applies to history) and each
 * entry's own `cwd` to resolve workspace identity, returning both the
 * records and the identities resolved for them so a caller never needs to
 * re-walk `session.timeline` itself to recover the same information.
 *
 * An entry with no `cwd` (a session persisted before that field existed)
 * resolves to the `'unattributed'` workspaceKey via the same path
 * `GitActivityRecorder` uses live — UNLESS `session.repoName` is known, in
 * which case it's remapped to a synthetic "this repo, worktree unknown"
 * identity instead. `repoName` is coarser than a real worktree identity (one
 * remote can't distinguish which of its worktrees a session ran in), so this
 * can't merge into a real worktree's own rollup — it surfaces as its own
 * row, and `GitWorkspaceReporter.report()` later files it under the real
 * repo (see `adoptResolvedRepoKeys`). Still strictly more honest than
 * folding every pre-`cwd` session into one anonymous bucket regardless of
 * which repo it touched.
 *
 * Implementation: build one synthetic `ToolCallRecord` per timeline entry
 * (mirroring `GitEfficiencyTracker.replayTimeline()`'s own pattern) with a
 * synthetic `toolUseId` of `replay:<sessionId>:<index>`. `GitActivityRecorder`'s
 * `makeRecordId` prefers `toolUseId` when present, so every resulting record
 * gets a `recordId` starting with `replay:<sessionId>:<index>` (plus the same
 * kind-specific discriminator suffix the live path appends, e.g. `:git` or
 * `:edit` — needed because one entry can legitimately produce more than one
 * activity) with zero special-casing. That id is deterministic across replays
 * of the same session, which is what lets a destination store's own recordId
 * dedup make a repeated replay safe.
 *
 * A private, throwaway `ActivityStore` + `GitActivityRecorder` pair captures
 * whatever the dispatch produces; this function just drains it back out.
 */
export function replaySessionToActivityRecords(
  session: {
    readonly sessionId: string;
    readonly timeline?: readonly ReplayTimelineEntry[];
    readonly repoName?: string | null;
  },
  identityResolver: WorktreeIdentityResolver,
): ReplayedActivity {
  const replayStore = new ActivityStore<GitActivityRecord>();
  const replayRecorder = new GitActivityRecorder(replayStore, identityResolver);
  const timeline = session.timeline ?? [];
  const identities = new Map<string, WorktreeIdentity>();

  for (let index = 0; index < timeline.length; index++) {
    const entry = timeline[index];
    const toolUseId = 'replay:' + session.sessionId + ':' + String(index);
    const syntheticRecord: ToolCallRecord = {
      id: toolUseId,
      sessionId: session.sessionId,
      toolName: entry.toolName,
      toolUseId,
      timestamp: entry.timestamp,
      durationMs: entry.durationMs,
      success: entry.success,
      cwd: entry.cwd,
      filePath: entry.filePath,
      command: entry.command,
      isTestCommand: entry.isTestCommand,
      isBuildCommand: entry.isBuildCommand,
      errorType: entry.errorType,
    };
    replayRecorder.recordToolCall(syntheticRecord);

    const identity = identityResolver.resolve(entry.cwd);
    if (identity) {
      identities.set(identity.worktreeKey, identity);
    }
  }

  // The replay store is private to this call and holds nothing else, so
  // querying the full open range just drains everything that was ingested.
  const drained = [...replayStore.query({ since: -Infinity, until: Infinity })];

  if (!session.repoName) {
    return { records: drained, identities };
  }

  const fallbackKey = UNRESOLVED_REPO_KEY_PREFIX + session.repoName;
  let usedFallback = false;
  const records = drained.map((record) => {
    if (record.workspaceKey !== UNATTRIBUTED_WORKSPACE_KEY) return record;
    usedFallback = true;
    return { ...record, workspaceKey: fallbackKey };
  });
  if (usedFallback) {
    identities.set(fallbackKey, {
      repoKey: fallbackKey,
      worktreeKey: fallbackKey,
      repoName: session.repoName,
      worktreeRoot: null,
      worktreeLabel: 'worktree unknown',
      branch: null,
    });
  }

  return { records, identities };
}

/**
 * Memoizes `replaySessionToActivityRecords` per `sessionId`, for `'completed'`
 * sessions only. A completed session's file is write-once (only the terminal
 * shutdown save marks a session `'completed'` — a periodic mid-session
 * checkpoint always persists `'in progress'`, per `SessionStore.saveSession`),
 * so its replay result never changes and is safe to cache forever. This is
 * what makes the cache worth having: a cache hit skips
 * `identityResolver.resolve()` entirely, and that call spawns up to three
 * `git` subprocesses per unique historical working directory with no caching
 * of its own — paying that cost again for the same closed session on every
 * dashboard poll is pure waste.
 */
export class ReplaySessionCache {
  private readonly cache = new Map<string, ReplayedActivity>();

  replay(
    session: {
      readonly sessionId: string;
      readonly outcome?: string;
      readonly timeline?: readonly ReplayTimelineEntry[];
      readonly repoName?: string | null;
    },
    identityResolver: WorktreeIdentityResolver,
  ): ReplayedActivity {
    const cacheable = session.outcome === 'completed';
    if (cacheable) {
      const cached = this.cache.get(session.sessionId);
      if (cached) return cached;
    }

    const replayed = replaySessionToActivityRecords(session, identityResolver);

    if (cacheable) {
      this.cache.set(session.sessionId, replayed);
    }

    return replayed;
  }
}
