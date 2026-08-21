import { redactSensitive } from '../config.js';
import type { ReplayTimelineEntry, ToolCallRecord } from '../storage/types.js';
import {
  gitCommandTargetDir,
  RepoNameResolver,
  stripHeredocBodies,
} from './local-session-aggregator.js';

/**
 * Parse `git symbolic-ref --short refs/remotes/<remoteName>/HEAD`'s stdout
 * (e.g. "origin/main") into just the branch name. Falls back to 'main' if
 * the ref is missing (empty output — e.g. an unusual shallow checkout that
 * never fetched a remote HEAD) or malformed (doesn't start with the
 * expected remote prefix).
 */
export function parseDefaultBranchFromSymbolicRef(output: string, remoteName: string): string {
  const trimmed = output.trim();
  const prefix = `${remoteName}/`;
  if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
    return trimmed.slice(prefix.length);
  }
  return 'main';
}

// ---------------------------------------------------------------------------
// Git command classification patterns
// ---------------------------------------------------------------------------

const GIT_COMMAND_RE = /\bgit\s+/;

const MERGE_CONFLICT_INDICATORS = [
  /CONFLICT\s*\(/i,
  /Automatic merge failed/i,
  /fix conflicts and then commit/i,
  /Merge conflict in/i,
  /both modified:/i,
];

const REBASE_CONFLICT_RE = /\brebase\b.*(?:conflict|could not apply|patch does not apply)/i;

const MERGE_ABORT_RE = /\bgit\s+merge\s+--abort\b/;
const REBASE_ABORT_RE = /\bgit\s+rebase\s+--abort\b/;
const CHERRY_PICK_ABORT_RE = /\bgit\s+cherry-pick\s+--abort\b/;

const GIT_PULL_RE = /\bgit\s+pull\b/;
const GIT_FETCH_RE = /\bgit\s+fetch\b/;
const GIT_PUSH_RE = /\bgit\s+push\b/;
// `(?!-)` excludes `--force-with-lease` — without it, a lease-protected force
// push would also match this plain "unsafe force push" pattern, since
// "--force-with-lease" starts with the literal text "--force".
const GIT_PUSH_FORCE_RE = /\bgit\s+push\s+.*--force(?!-)|\bgit\s+push\s+-f\b/;
const GIT_PUSH_FORCE_LEASE_RE = /--force-with-lease\b/;
const GIT_MERGE_RE = /\bgit\s+merge\b/;
const GIT_REBASE_RE = /\bgit\s+rebase\b/;
const GIT_STASH_RE = /\bgit\s+stash\b/;
const GIT_RESET_HARD_RE = /\bgit\s+reset\s+--hard\b/;
const GIT_CHECKOUT_DASH_RE = /\bgit\s+checkout\s+--\s/;
const GIT_RESTORE_RE = /\bgit\s+restore\b/;
const GIT_BRANCH_RE = /\bgit\s+(?:branch|checkout\s+-b|switch\s+-c)\b/;
const GIT_STATUS_RE = /\bgit\s+status\b/;
const GIT_DIFF_RE = /\bgit\s+diff\b/;
const GIT_LOG_RE = /\bgit\s+log\b/;
const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const GIT_WORKTREE_RE = /\bgit\s+worktree\b/;
// Only `add`/`remove` create or tear down real isolation — `list`/`prune`/
// `lock`/etc. are read-only inspection and shouldn't inflate the "worktree
// ops" count with commands that don't reflect any parallel-isolation work.
const GIT_WORKTREE_ADD_REMOVE_RE = /\bgit\s+worktree\s+(?:add|remove)\b/;
const GIT_CHECKOUT_OURS_RE = /\bgit\s+checkout\s+--ours\b/;
const GIT_CHECKOUT_THEIRS_RE = /\bgit\s+checkout\s+--theirs\b/;
const GIT_CHERRY_PICK_RE = /\bgit\s+cherry-pick\b/;

// GitHub CLI patterns
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const GH_PR_MERGE_RE = /\bgh\s+pr\s+merge\b/;
const GH_PR_VIEW_RE = /\bgh\s+pr\s+view\b/;
const GH_PR_EDIT_RE = /\bgh\s+pr\s+edit\b/;
const GH_PR_READY_RE = /\bgh\s+pr\s+ready\b/;
const GH_PR_CHECKS_RE = /\bgh\s+pr\s+checks\b/;
const GH_COMMAND_RE = /\bgh\s+/;

// Extract PR number from gh commands
const GH_PR_NUMBER_RE = /\bgh\s+pr\s+\w+\s+(\d+)/;

/**
 * GitHub MCP server tool names confirmed via live-account NRQL evidence
 * to reach Preflight as first-class AiToolCall events with these exact
 * `tool` values,
 * but never counted by the PR metric because recordToolCall() only inspects
 * `record.command` — which MCP tool calls never carry. Deliberately limited
 * to the two names the issue's own evidence covers; other GitHub-MCP PR
 * tools (merge_pull_request, etc.) are unconfirmed and out of scope pending
 * their own evidence.
 */
const MCP_PR_TOOL_ACTION: Record<string, PrEvent['action']> = {
  create_pull_request: 'create',
  update_pull_request: 'edit',
};

// hydrateGitLog()'s dedup window, used only against a hook-observed commit
// event (one with no hash in its command text): `git log`'s %ct has 1-second
// resolution and a hook-observed commit event's timestamp is recorded when
// the tool call completes, so the two timestamps for the same commit are
// close but never exactly equal — and the hook event's command text is the
// raw pre-execution shell string, which never contains the resulting hash,
// so dedup against it can't key on a hash match. Treat any existing
// hook-observed commit event within this window as the same commit.
//
// A hydrated commit ALWAYS carries a real hash from `git log`, so comparing
// it against another hydrated event uses exact hash equality (via
// HYDRATED_COMMIT_HASH_RE below) instead of this proximity window — two
// genuinely distinct commits landing within the window (e.g. rapid
// sequential commits in the same `git log` batch) must not collapse into
// one just because their timestamps are close.
const COMMIT_DEDUP_WINDOW_MS = 5_000;

// Matches the synthetic command text hydrateGitLog() gives its own events
// (see below), letting isDuplicate() tell a hydrated event apart from a
// hook-observed one and recover its hash.
const HYDRATED_COMMIT_HASH_RE = /^git commit \((.+)\)$/;

const REJECT_INDICATORS = [
  /\[rejected\]/i,
  /non-fast-forward/i,
  /failed to push/i,
  /Updates were rejected/i,
];

// Conflict file path extraction: "CONFLICT (content): Merge conflict in <path>"
const CONFLICT_FILE_RE = /Merge conflict in (.+)/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitEvent {
  readonly timestamp: number;
  readonly type: GitEventType;
  readonly command?: string;
  readonly success: boolean;
  readonly durationMs: number | null;
  /** `owner/name` of the repo this event belongs to, when known. */
  readonly repo?: string | null;
  /** Commit subject line, for events hydrated from `git log`. */
  readonly subject?: string | null;
  /** Browsable URL for the commit, when the remote could be mapped. */
  readonly url?: string | null;
}

export type GitEventType =
  | 'merge_conflict'
  | 'rebase_conflict'
  | 'merge_abort'
  | 'rebase_abort'
  | 'cherry_pick_abort'
  | 'force_push'
  | 'force_push_lease'
  | 'reset_hard'
  | 'discard_changes'
  | 'pull'
  | 'fetch'
  | 'push'
  | 'push_rejected'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'branch'
  | 'commit'
  | 'status'
  | 'diff'
  | 'log'
  | 'worktree'
  | 'other_git';

export interface MergeConflictRecord {
  readonly timestamp: number;
  readonly resolution: 'resolved' | 'aborted' | 'pending';
  readonly resolutionTimeMs: number | null;
  readonly command: string;
  readonly files: readonly string[];
}

// A conflict that's been detected but not yet aborted or resolved via commit.
// Kept as a queue (not a single scalar) so a second conflict arriving while
// one is already open is queued rather than silently overwriting the first.
// The used*/ flags accumulate as ours/theirs/cherry-pick commands run while
// this conflict is the oldest pending one, and are only credited to the
// strategy counters once this conflict actually resolves.
interface PendingConflict {
  timestamp: number;
  command: string;
  files: string[];
  usedOurs: boolean;
  usedTheirs: boolean;
  usedCherryPick: boolean;
}

export interface GitEfficiencyMetrics {
  readonly totalGitCommands: number;
  readonly mergeConflicts: number;
  readonly rebaseConflicts: number;
  readonly abortedOperations: number;
  readonly forcePushes: number;
  readonly resetHards: number;
  readonly discardedChanges: number;
  readonly pullCount: number;
  readonly pushCount: number;
  readonly commitCount: number;
  readonly branchOperations: number;
  readonly conflictResolutionRate: number | null;
  readonly avgConflictResolutionMs: number | null;
  readonly staleBranchPulls: number;
  readonly gitCommandTimeline: readonly GitEvent[];
  readonly conflictHistory: readonly MergeConflictRecord[];
  readonly suggestions: readonly GitSuggestion[];
  readonly bestPractices: readonly BestPractice[];
  readonly preventionScore: number | null;
  readonly efficiencyScore: number | null;
  readonly riskIndicators: RiskIndicators;
  readonly velocityMetrics: VelocityMetrics;
  readonly conflictResolutionStrategy: ConflictResolutionStrategy;
  readonly prMetrics: PullRequestMetrics;
  readonly repoContext: RepoContext;
}

export interface RepoContext {
  readonly repoName: string | null;
  readonly branch: string | null;
  readonly remoteName: string | null;
  readonly defaultBranch: string | null;
}

export interface PullRequestMetrics {
  readonly created: number;
  readonly merged: number;
  readonly checksViewed: number;
  readonly prsUpdated: number;
  readonly prActivity: readonly PrEvent[];
  readonly avgTimeToCreateMs: number | null;
}

export interface PrEvent {
  readonly timestamp: number;
  readonly action: 'create' | 'merge' | 'view' | 'edit' | 'ready' | 'checks';
  readonly prNumber: string | null;
}

export interface VelocityMetrics {
  readonly avgTimeBetweenCommitsMs: number | null;
  readonly commitBurstCount: number;
  readonly longestGapMs: number | null;
  readonly worktreeCount: number;
  readonly buildBeforePush: boolean | null;
  readonly testBeforePush: boolean | null;
}

export interface ConflictResolutionStrategy {
  readonly oursCount: number;
  readonly theirsCount: number;
  readonly manualMergeCount: number;
  readonly cherryPickCount: number;
  readonly totalResolutions: number;
}

export interface GitSuggestion {
  readonly severity: 'info' | 'warning' | 'critical';
  readonly category: string;
  readonly message: string;
  readonly evidence: string;
}

export interface BestPractice {
  readonly id: string;
  readonly label: string;
  /**
   * `'n/a'` is distinct from `'unknown'`: `'unknown'` means there isn't
   * enough signal yet to evaluate the check (genuinely insufficient data);
   * `'n/a'` means the check is fully evaluated and the practice simply
   * doesn't apply this session (e.g. no parallel work happened, so worktree
   * usage was never needed) — a known, non-violating outcome that shouldn't
   * be conflated with "we don't know" or count against the pass ratio.
   */
  readonly status: 'pass' | 'fail' | 'warn' | 'unknown' | 'n/a';
  readonly detail: string;
}

// Render order for suggestions/best-practices — most severe first — rather
// than fixed source-code push order, which could put a critical item below
// a milder one.
const SUGGESTION_SEVERITY_RANK: Record<GitSuggestion['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const BEST_PRACTICE_STATUS_RANK: Record<BestPractice['status'], number> = {
  fail: 0,
  warn: 1,
  pass: 2,
  unknown: 3,
  'n/a': 4,
};

export interface RiskIndicators {
  readonly syncedBeforeEditing: boolean | null;
  readonly timeSinceLastSyncMs: number | null;
  readonly commitsSinceLastSync: number;
  readonly pushRejections: number;
  readonly forceAfterReject: number;
  readonly hotFiles: readonly string[];
  readonly usesWorktrees: boolean;
  readonly usesForceWithLease: boolean;
  readonly avgCommitsBetweenSyncs: number | null;
  readonly commitsAheadOfMain: number | null;
  readonly commitsBehindMain: number | null;
  readonly sessionDurationMs: number | null;
  readonly quickConflictResolutions: number;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class GitEfficiencyTracker {
  private events: GitEvent[] = [];
  private conflictRecords: MergeConflictRecord[] = [];
  private pendingConflicts: PendingConflict[] = [];
  private lastSyncTimestamp: number | null = null;
  private pullsSinceLastConflict = 0;
  private consecutiveFailedPushes = 0;
  private statusChecksSinceLastAction = 0;
  private firstEditTimestamp: number | null = null;
  private firstSyncTimestamp: number | null = null;
  private commitsSinceLastSync = 0;
  private syncIntervalCommitCounts: number[] = [];
  private pushRejections = 0;
  private forceAfterReject = 0;
  private lastPushRejectedTimestamp: number | null = null;
  private conflictedFiles = new Set<string>();
  private editedFiles = new Set<string>();
  private hasUsedWorktree = false;
  private hasUsedForceWithLease = false;
  // Tracks whether ANY bare (non-lease) force-push occurred this session,
  // independent of whether --force-with-lease was ever also used. This is
  // the single shared signal both the force_with_lease best-practice check
  // and the force_push suggestion's severity gate on, so the two checks
  // agree on what counts as "was this session's force-push usage safe."
  private hasUsedBareForcePush = false;
  // Count of bare (non-lease) force-pushes specifically — kept separate from
  // stats.forcePushes (which sums bare AND lease-protected pushes) so
  // severity scales with how much *unsafe* force-pushing happened, not with
  // total force-push volume. A safe --force-with-lease push must never be
  // able to escalate severity that a bare push alone already set.
  private bareForcePushCount = 0;
  // Snapshot of whether any bare force-push landed while repoContext.branch
  // matched repoContext.defaultBranch — a bare push to the shared default
  // branch can clobber other collaborators' work, unlike an identical push
  // to a personal feature branch only one person is using, so the two must
  // not scale to the same severity.
  private hasForcePushedToDefaultBranch = false;
  private totalToolCalls = 0;
  private sessionStartTimestamp: number | null = null;
  private commitTimestamps: number[] = [];
  // Latest commit timestamp covered by a `hydrateGitLog()` call. A live
  // `git commit` event with a timestamp at or before this is one `git log`
  // already saw at hydration time — recordToolCall() must skip it rather
  // than double-count a commit that's about to arrive (or already has)
  // through the normal hook-observed path too. See recordToolCall().
  private hydratedThroughMs = 0;
  private worktreeCommands = 0;
  private oursCount = 0;
  private theirsCount = 0;
  private cherryPickCount = 0;
  private lastBuildOrTestTimestamp: number | null = null;
  private lastPushTimestamp: number | null = null;
  private buildBeforePush: boolean | null = null;
  private commitsAheadOfMain: number | null = null;
  private commitsBehindMain: number | null = null;
  private quickConflictResolutions = 0;
  private prEvents: PrEvent[] = [];
  private firstCommitTimestamp: number | null = null;
  private readonly repoResolver = new RepoNameResolver();
  private repoContext: RepoContext = {
    repoName: null,
    branch: null,
    remoteName: null,
    defaultBranch: null,
  };

  recordToolCall(record: ToolCallRecord): void {
    this.totalToolCalls++;
    if (this.sessionStartTimestamp === null) {
      this.sessionStartTimestamp = record.timestamp;
    }

    // Track file edits (non-git tool calls that modify files)
    if (record.toolName === 'Edit' || record.toolName === 'Write') {
      const filePath = record.filePath as string | undefined;
      if (filePath) {
        this.editedFiles.add(filePath);
        if (this.firstEditTimestamp === null) {
          this.firstEditTimestamp = record.timestamp;
        }
      }
    }

    // Track build/test commands for "verify before push" metric
    if (record.isTestCommand || record.isBuildCommand) {
      this.lastBuildOrTestTimestamp = record.timestamp;
    }

    // MCP tool calls (e.g. the GitHub MCP server's create_pull_request /
    // update_pull_request) carry no `command` field, so they'd otherwise be
    // silently dropped by the guard below. See MCP_PR_TOOL_ACTION's doc
    // comment. No confirmed PR-number field exists for these — prNumber is
    // null, unlike the gh-CLI path below which extracts it from command text.
    const mcpPrAction = MCP_PR_TOOL_ACTION[record.toolName];
    if (mcpPrAction) {
      this.prEvents.push({ timestamp: record.timestamp, action: mcpPrAction, prNumber: null });
    }

    const rawCommand = record.command as string | undefined;
    if (!rawCommand) return;
    // Classify on the command *minus* any inline script bodies: a heredoc that
    // merely mentions git words is not a git operation.
    const command = stripHeredocBodies(rawCommand);

    // Track GitHub CLI PR commands. Split on shell separators first so a
    // `gh` invocation chained after a `git` command (e.g. `git push && gh pr
    // create --fill`) is still detected — checking the git-prefix guard
    // against the whole compound string would skip it even though only the
    // first segment is a `git` command. Each segment still skips the case
    // where "gh" is just text inside a git argument, e.g. `git commit -m "gh
    // pr create note"`.
    for (const segment of command.split(/&&|;|\|/)) {
      const trimmedSegment = segment.trim();
      if (GH_COMMAND_RE.test(trimmedSegment) && !trimmedSegment.startsWith('git ')) {
        this.processGhCommand(trimmedSegment, record.timestamp);
      }
    }

    if (!GIT_COMMAND_RE.test(command)) return;

    const event = this.classifyGitCommand(command, record);
    // A hook-observed commit whose timestamp `hydrateGitLog()` already saw
    // (via `git log`) is the same commit, not a new one — hydrateGitLog()
    // can't dedupe this itself since a live event's `command` is the raw
    // shell string, not `git commit (<hash>)`, so it never matches its own
    // hash-based check. Without this, a day-boundary hydration followed by
    // this same commit's hook event arriving from the same drain batch
    // would count it twice.
    if (event.type === 'commit' && event.timestamp <= this.hydratedThroughMs) return;
    this.events.push(event);
    this.processEvent(event, command, record);
  }

  hydrateBranchDivergence(ahead: number, behind: number): void {
    this.commitsAheadOfMain = ahead;
    this.commitsBehindMain = behind;
  }

  hydrateRepoContext(ctx: RepoContext): void {
    this.repoContext = ctx;
  }

  private processGhCommand(command: string, timestamp: number): void {
    const numberMatch = GH_PR_NUMBER_RE.exec(command);
    const prNumber = numberMatch ? numberMatch[1] : null;

    if (GH_PR_CREATE_RE.test(command)) {
      this.prEvents.push({ timestamp, action: 'create', prNumber });
    } else if (GH_PR_MERGE_RE.test(command)) {
      this.prEvents.push({ timestamp, action: 'merge', prNumber });
    } else if (GH_PR_CHECKS_RE.test(command)) {
      this.prEvents.push({ timestamp, action: 'checks', prNumber });
    } else if (GH_PR_READY_RE.test(command)) {
      this.prEvents.push({ timestamp, action: 'ready', prNumber });
    } else if (GH_PR_EDIT_RE.test(command)) {
      this.prEvents.push({ timestamp, action: 'edit', prNumber });
    } else if (GH_PR_VIEW_RE.test(command)) {
      this.prEvents.push({ timestamp, action: 'view', prNumber });
    }
  }

  private computePrMetrics(): PullRequestMetrics {
    const created = this.prEvents.filter((e) => e.action === 'create').length;
    const merged = this.prEvents.filter((e) => e.action === 'merge').length;
    const checksViewed = this.prEvents.filter((e) => e.action === 'checks').length;
    const prsUpdated = this.prEvents.filter(
      (e) => e.action === 'edit' || e.action === 'ready',
    ).length;

    // Time from each PR's most recent preceding commit to its `gh pr
    // create`, averaged across every PR opened this session — not a single
    // delta anchored to whichever commit happened to be the very first one
    // this tracker ever saw, which would go stale after the first PR and
    // ignore every PR opened later in the same session.
    const sortedCommitTimestamps = [...this.commitTimestamps].sort((a, b) => a - b);
    const timesToCreate: number[] = [];
    for (const prEvent of this.prEvents) {
      if (prEvent.action !== 'create') continue;
      let precedingCommitTimestamp: number | null = null;
      for (const commitTimestamp of sortedCommitTimestamps) {
        if (commitTimestamp > prEvent.timestamp) break;
        precedingCommitTimestamp = commitTimestamp;
      }
      if (precedingCommitTimestamp !== null) {
        timesToCreate.push(Math.max(0, prEvent.timestamp - precedingCommitTimestamp));
      }
    }
    const avgTimeToCreateMs =
      timesToCreate.length > 0
        ? timesToCreate.reduce((a, b) => a + b, 0) / timesToCreate.length
        : null;

    return {
      created,
      merged,
      checksViewed,
      prsUpdated,
      prActivity: this.prEvents.slice(-20),
      avgTimeToCreateMs,
    };
  }

  hydrateGitLog(
    commits: readonly {
      timestamp: number;
      hash: string;
      repo?: string | null;
      subject?: string | null;
      url?: string | null;
    }[],
  ): void {
    for (const commit of commits) {
      if (!commit.hash) continue;
      const event: GitEvent = {
        timestamp: commit.timestamp,
        type: 'commit',
        command: `git commit (${commit.hash})`,
        success: true,
        durationMs: null,
        repo: commit.repo ?? null,
        subject: commit.subject ?? null,
        url: commit.url ?? null,
      };
      // Only add if we don't already have this commit tracked. Against an
      // existing hydrated event (one carrying its own real hash), match by
      // exact hash equality — precise, and avoids collapsing two genuinely
      // distinct commits that just happen to land within the proximity
      // window. Against an existing hook-observed event, fall back to
      // timestamp proximity: a prior session's hook-observed `commit` event,
      // replayed via replayTimeline() before this method ever runs, has no
      // hash in its command text at all, so a hash match would never catch
      // it and every restart would double-count that commit.
      const isDuplicate = this.events.some((e) => {
        if (e.type !== 'commit') return false;
        const existingHash = e.command ? HYDRATED_COMMIT_HASH_RE.exec(e.command)?.[1] : undefined;
        if (existingHash !== undefined) {
          return existingHash === commit.hash;
        }
        return Math.abs(e.timestamp - commit.timestamp) < COMMIT_DEDUP_WINDOW_MS;
      });
      if (!isDuplicate) {
        this.events.push(event);
        this.commitTimestamps.push(commit.timestamp);
        // Don't increment commitsSinceLastSync for historical commits — this counter
        // tracks real-time session activity, not replayed history.
      }
      // Advance the watermark even for a commit that was already tracked —
      // either way, `git log` has now vouched for everything up to here, so
      // recordToolCall() must not add it again when the hook-observed event
      // for it (still queued in the same drain batch) gets processed.
      if (commit.timestamp > this.hydratedThroughMs) {
        this.hydratedThroughMs = commit.timestamp;
      }
    }
  }

  /**
   * @param repoName The replayed session's own repo (from `SessionSummary.repoName`).
   *   When both this and the tracker's own `repoContext.repoName` (set via
   *   `hydrateRepoContext()`) are known and they don't match, the whole
   *   timeline is skipped — otherwise a session worked on in a
   *   different repo earlier today would have its commits/conflicts/force-
   *   pushes counted against whichever repo this process's header currently
   *   names. When either side is unknown (null/undefined — e.g. no git
   *   remote configured, or `repoContext` not hydrated yet), the timeline is
   *   replayed unfiltered rather than risk dropping legitimate same-repo
   *   history.
   */
  replayTimeline(entries: readonly ReplayTimelineEntry[], repoName?: string | null): void {
    if (
      repoName != null &&
      this.repoContext.repoName != null &&
      repoName !== this.repoContext.repoName
    ) {
      return;
    }
    for (const entry of entries) {
      const syntheticRecord: ToolCallRecord = {
        id: `replay-${entry.timestamp}`,
        sessionId: null,
        toolName: entry.toolName,
        toolUseId: `replay-${entry.timestamp}`,
        timestamp: entry.timestamp,
        durationMs: entry.durationMs,
        success: entry.success,
        command: entry.command,
        filePath: entry.filePath,
        errorType: entry.errorType,
        isTestCommand: entry.isTestCommand,
        isBuildCommand: entry.isBuildCommand,
      };
      this.recordToolCall(syntheticRecord);
    }
  }

  getMetrics(): GitEfficiencyMetrics {
    const totalGitCommands = this.events.length;
    const mergeConflicts = this.events.filter((e) => e.type === 'merge_conflict').length;
    const rebaseConflicts = this.events.filter((e) => e.type === 'rebase_conflict').length;
    const abortedOperations = this.events.filter(
      (e) =>
        e.type === 'merge_abort' || e.type === 'rebase_abort' || e.type === 'cherry_pick_abort',
    ).length;
    const forcePushes = this.events.filter(
      (e) => e.type === 'force_push' || e.type === 'force_push_lease',
    ).length;
    const resetHards = this.events.filter((e) => e.type === 'reset_hard').length;
    const discardedChanges = this.events.filter((e) => e.type === 'discard_changes').length;
    const pullCount = this.events.filter((e) => e.type === 'pull').length;
    const pushCount = this.events.filter(
      (e) => e.type === 'push' || e.type === 'force_push' || e.type === 'force_push_lease',
    ).length;
    const commitCount = this.events.filter((e) => e.type === 'commit').length;
    const branchOperations = this.events.filter((e) => e.type === 'branch').length;

    // A conflict that's currently open (mid-merge, not yet aborted or
    // resolved) is counted in the mergeConflicts/rebaseConflicts KPI above,
    // but this.conflictRecords only gains an entry once it's aborted or
    // resolved — so it would otherwise never enter the resolution-rate
    // denominator, letting a session with one resolved and one still-open
    // conflict show a "perfect" 100% rate. Synthesizing (not persisting) a
    // 'pending' record per still-queued conflict keeps the denominator
    // honest without ever double-counting once that conflict does resolve —
    // at that point it leaves the queue and gets a real entry instead.
    const allConflictRecords: MergeConflictRecord[] = [
      ...this.conflictRecords,
      ...this.pendingConflicts.map((p) => ({
        timestamp: p.timestamp,
        resolution: 'pending' as const,
        resolutionTimeMs: null,
        command: p.command,
        files: p.files,
      })),
    ];

    const resolved = allConflictRecords.filter((c) => c.resolution === 'resolved');
    const conflictResolutionRate =
      allConflictRecords.length > 0 ? resolved.length / allConflictRecords.length : null;

    const resolutionTimes = resolved
      .filter((c) => c.resolutionTimeMs !== null)
      .map((c) => c.resolutionTimeMs as number);
    const avgConflictResolutionMs =
      resolutionTimes.length > 0
        ? resolutionTimes.reduce((a, b) => a + b, 0) / resolutionTimes.length
        : null;

    const staleBranchPulls = this.countStaleBranchPulls();

    const riskIndicators = this.computeRiskIndicators();

    const suggestions = this.generateSuggestions({
      totalGitCommands,
      mergeConflicts,
      rebaseConflicts,
      abortedOperations,
      forcePushes,
      resetHards,
      discardedChanges,
      pullCount,
      commitCount,
      staleBranchPulls,
      riskIndicators,
    });

    const bestPractices = this.evaluateBestPractices(riskIndicators, {
      mergeConflicts,
      rebaseConflicts,
      commitCount,
      pullCount,
      forcePushes,
    });

    const efficiencyScore = this.computeScore({
      totalGitCommands,
      mergeConflicts,
      rebaseConflicts,
      abortedOperations,
      forcePushes,
      resetHards,
      discardedChanges,
      conflictResolutionRate,
    });

    const preventionScore = this.computePreventionScore(bestPractices);
    const velocityMetrics = this.computeVelocityMetrics();
    const conflictResolutionStrategy = this.computeConflictStrategy();
    const prMetrics = this.computePrMetrics();

    return {
      totalGitCommands,
      mergeConflicts,
      rebaseConflicts,
      abortedOperations,
      forcePushes,
      resetHards,
      discardedChanges,
      pullCount,
      pushCount,
      commitCount,
      branchOperations,
      conflictResolutionRate,
      avgConflictResolutionMs,
      staleBranchPulls,
      // this.events/this.conflictRecords are append-only in processing
      // order, not timestamp order — parallel tool calls within a session,
      // or multi-session buffer draining, can push an earlier-timestamped
      // event after a later one. Sort by timestamp ascending (oldest-first)
      // before exposing, so gitCommandTimeline's consumer
      // (GitEfficiency.tsx's `[...timeline].reverse().slice(0, 30)`) picks
      // the true newest 30, not whichever 30 happened to be pushed last.
      gitCommandTimeline: [...this.events].sort((a, b) => a.timestamp - b.timestamp).slice(-50),
      conflictHistory: [...allConflictRecords].sort((a, b) => a.timestamp - b.timestamp),
      // Both arrays render in whatever order the checks above happen to
      // .push() in — fixed source-code order, not severity order — so a
      // critical-severity item could render below a milder one. Sort by
      // severity (most severe first) before exposing.
      suggestions: [...suggestions].sort(
        (a, b) => SUGGESTION_SEVERITY_RANK[a.severity] - SUGGESTION_SEVERITY_RANK[b.severity],
      ),
      bestPractices: [...bestPractices].sort(
        (a, b) => BEST_PRACTICE_STATUS_RANK[a.status] - BEST_PRACTICE_STATUS_RANK[b.status],
      ),
      preventionScore,
      efficiencyScore,
      riskIndicators,
      velocityMetrics,
      conflictResolutionStrategy,
      prMetrics,
      repoContext: this.repoContext,
    };
  }

  reset(_sessionId: string): void {
    this.events = [];
    this.conflictRecords = [];
    this.pendingConflicts = [];
    this.lastSyncTimestamp = null;
    this.pullsSinceLastConflict = 0;
    this.consecutiveFailedPushes = 0;
    this.statusChecksSinceLastAction = 0;
    this.firstEditTimestamp = null;
    this.firstSyncTimestamp = null;
    this.commitsSinceLastSync = 0;
    this.syncIntervalCommitCounts = [];
    this.pushRejections = 0;
    this.forceAfterReject = 0;
    this.lastPushRejectedTimestamp = null;
    this.conflictedFiles.clear();
    this.editedFiles.clear();
    this.hasUsedWorktree = false;
    this.hasUsedForceWithLease = false;
    this.hasUsedBareForcePush = false;
    this.bareForcePushCount = 0;
    this.hasForcePushedToDefaultBranch = false;
    this.totalToolCalls = 0;
    this.sessionStartTimestamp = null;
    this.commitTimestamps = [];
    this.hydratedThroughMs = 0;
    this.worktreeCommands = 0;
    this.oursCount = 0;
    this.theirsCount = 0;
    this.cherryPickCount = 0;
    this.lastBuildOrTestTimestamp = null;
    this.lastPushTimestamp = null;
    this.buildBeforePush = null;
    this.commitsAheadOfMain = null;
    this.commitsBehindMain = null;
    this.quickConflictResolutions = 0;
    this.prEvents = [];
    this.repoContext = { repoName: null, branch: null, remoteName: null, defaultBranch: null };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  // Order matters: several patterns overlap (e.g. a force-push-with-lease
  // command also matches the plain push/force-push patterns), so more
  // specific checks must run before the more general ones they'd otherwise
  // be shadowed by.
  private classifyGitCommand(command: string, record: ToolCallRecord): GitEvent {
    const base = {
      timestamp: record.timestamp,
      // The command is now surfaced in the dashboard's Detail column, so
      // redact it: a git remote URL can carry an embedded access token.
      command: redactSensitive(command),
      success: record.success,
      durationMs: record.durationMs,
      // Live git events previously carried no repo at all, so the dashboard
      // showed "—" for everything except commits hydrated from git log.
      repo: this.repoResolver.resolve(
        gitCommandTargetDir(command, record.cwd as string | undefined),
      ),
    };

    const output = (record.error as string) ?? '';
    const hasConflict = MERGE_CONFLICT_INDICATORS.some((re) => re.test(output));
    const hasRebaseConflict = REBASE_CONFLICT_RE.test(output);
    const hasRejection = REJECT_INDICATORS.some((re) => re.test(output));

    if (hasConflict && !hasRebaseConflict) return { ...base, type: 'merge_conflict' };
    if (hasRebaseConflict) return { ...base, type: 'rebase_conflict' };
    if (MERGE_ABORT_RE.test(command)) return { ...base, type: 'merge_abort' };
    if (REBASE_ABORT_RE.test(command)) return { ...base, type: 'rebase_abort' };
    if (CHERRY_PICK_ABORT_RE.test(command)) return { ...base, type: 'cherry_pick_abort' };
    if (GIT_PUSH_FORCE_LEASE_RE.test(command)) return { ...base, type: 'force_push_lease' };
    if (GIT_PUSH_FORCE_RE.test(command)) return { ...base, type: 'force_push' };
    if (GIT_RESET_HARD_RE.test(command)) return { ...base, type: 'reset_hard' };
    if (GIT_CHECKOUT_DASH_RE.test(command) || GIT_RESTORE_RE.test(command))
      return { ...base, type: 'discard_changes' };
    if (GIT_WORKTREE_RE.test(command)) return { ...base, type: 'worktree' };
    if (GIT_PULL_RE.test(command)) return { ...base, type: 'pull' };
    if (GIT_FETCH_RE.test(command)) return { ...base, type: 'fetch' };
    if (GIT_PUSH_RE.test(command) && hasRejection) return { ...base, type: 'push_rejected' };
    if (GIT_PUSH_RE.test(command)) return { ...base, type: 'push' };
    if (GIT_REBASE_RE.test(command)) return { ...base, type: 'rebase' };
    if (GIT_MERGE_RE.test(command)) return { ...base, type: 'merge' };
    if (GIT_STASH_RE.test(command)) return { ...base, type: 'stash' };
    if (GIT_BRANCH_RE.test(command)) return { ...base, type: 'branch' };
    if (GIT_COMMIT_RE.test(command)) return { ...base, type: 'commit' };
    if (GIT_STATUS_RE.test(command)) return { ...base, type: 'status' };
    if (GIT_DIFF_RE.test(command)) return { ...base, type: 'diff' };
    if (GIT_LOG_RE.test(command)) return { ...base, type: 'log' };

    return { ...base, type: 'other_git' };
  }

  private processEvent(event: GitEvent, command: string, record: ToolCallRecord): void {
    // Attribute ours/theirs/cherry-pick resolution strategy to the oldest
    // still-open conflict, not to every matching command — a multi-file
    // conflict resolved with one `--ours` per file must count once toward
    // that conflict, not once per file, and a strategy command run with no
    // conflict pending isn't resolving anything. `--abort` also matches the
    // bare cherry-pick pattern, so it's excluded explicitly — aborting isn't
    // a resolution strategy.
    const oldestPending = this.pendingConflicts[0];
    if (oldestPending) {
      if (GIT_CHECKOUT_OURS_RE.test(command)) oldestPending.usedOurs = true;
      if (GIT_CHECKOUT_THEIRS_RE.test(command)) oldestPending.usedTheirs = true;
      if (GIT_CHERRY_PICK_RE.test(command) && !CHERRY_PICK_ABORT_RE.test(command)) {
        oldestPending.usedCherryPick = true;
      }
    }

    switch (event.type) {
      case 'merge_conflict':
      case 'rebase_conflict': {
        const output = (record.error as string) ?? '';
        const files: string[] = [];
        let match: RegExpExecArray | null;
        CONFLICT_FILE_RE.lastIndex = 0;
        while ((match = CONFLICT_FILE_RE.exec(output)) !== null) {
          files.push(match[1].trim());
          this.conflictedFiles.add(match[1].trim());
        }
        this.pendingConflicts.push({
          timestamp: event.timestamp,
          command,
          files,
          usedOurs: false,
          usedTheirs: false,
          usedCherryPick: false,
        });
        this.pullsSinceLastConflict = 0;
        break;
      }

      case 'merge_abort':
      case 'rebase_abort':
      case 'cherry_pick_abort': {
        const pending = this.pendingConflicts.shift();
        if (pending) {
          this.conflictRecords.push({
            timestamp: pending.timestamp,
            resolution: 'aborted',
            resolutionTimeMs: event.timestamp - pending.timestamp,
            command: pending.command,
            files: pending.files,
          });
        }
        break;
      }

      case 'commit': {
        // git commit --amend fixes a prior commit, not a merge conflict.
        // Drop the oldest pending conflict on amend (without recording a
        // resolution) so a later, unrelated commit doesn't retroactively
        // "resolve" it.
        if (command.includes('--amend')) {
          this.pendingConflicts.shift();
        } else {
          const pending = this.pendingConflicts.shift();
          if (pending) {
            const resolutionMs = event.timestamp - pending.timestamp;
            this.conflictRecords.push({
              timestamp: pending.timestamp,
              resolution: 'resolved',
              resolutionTimeMs: resolutionMs,
              command: pending.command,
              files: pending.files,
            });
            if (pending.usedOurs) this.oursCount++;
            if (pending.usedTheirs) this.theirsCount++;
            if (pending.usedCherryPick) this.cherryPickCount++;
            // Under 30s resolution with multiple conflicted files is suspiciously fast
            if (resolutionMs < 30_000 && pending.files.length > 1) {
              this.quickConflictResolutions++;
            }
          }
        }
        this.commitTimestamps.push(event.timestamp);
        this.commitsSinceLastSync++;
        this.statusChecksSinceLastAction = 0;
        break;
      }

      case 'pull':
      case 'fetch':
      case 'rebase':
        if (this.firstSyncTimestamp === null) {
          this.firstSyncTimestamp = event.timestamp;
        }
        this.lastSyncTimestamp = event.timestamp;
        if (this.commitsSinceLastSync > 0) {
          this.syncIntervalCommitCounts.push(this.commitsSinceLastSync);
        }
        this.commitsSinceLastSync = 0;
        this.pullsSinceLastConflict++;
        this.statusChecksSinceLastAction = 0;
        break;

      case 'push': {
        // buildBeforePush is only meaningful if the build/test happened AFTER the
        // most recent commit — a stale test from session start with many commits
        // in between doesn't protect the pushed code.
        const lastCommitTs =
          this.commitTimestamps.length > 0
            ? this.commitTimestamps[this.commitTimestamps.length - 1]!
            : null;
        this.lastPushTimestamp = event.timestamp;
        this.buildBeforePush =
          this.lastBuildOrTestTimestamp !== null &&
          (lastCommitTs === null || this.lastBuildOrTestTimestamp > lastCommitTs);
        this.consecutiveFailedPushes = 0;
        this.statusChecksSinceLastAction = 0;
        break;
      }

      case 'push_rejected':
        this.pushRejections++;
        this.consecutiveFailedPushes++;
        this.lastPushRejectedTimestamp = event.timestamp;
        this.statusChecksSinceLastAction = 0;
        break;

      case 'force_push':
        this.hasUsedBareForcePush = true;
        this.bareForcePushCount++;
        if (
          this.repoContext.branch !== null &&
          this.repoContext.defaultBranch !== null &&
          this.repoContext.branch === this.repoContext.defaultBranch
        ) {
          this.hasForcePushedToDefaultBranch = true;
        }
        if (
          this.lastPushRejectedTimestamp !== null &&
          event.timestamp - this.lastPushRejectedTimestamp < 300_000
        ) {
          this.forceAfterReject++;
        }
        this.lastPushTimestamp = event.timestamp;
        {
          const lastCt =
            this.commitTimestamps.length > 0
              ? this.commitTimestamps[this.commitTimestamps.length - 1]!
              : null;
          this.buildBeforePush =
            this.lastBuildOrTestTimestamp !== null &&
            (lastCt === null || this.lastBuildOrTestTimestamp > lastCt);
        }
        this.consecutiveFailedPushes = 0;
        this.statusChecksSinceLastAction = 0;
        break;

      case 'force_push_lease':
        this.hasUsedForceWithLease = true;
        this.lastPushTimestamp = event.timestamp;
        {
          const lastCt =
            this.commitTimestamps.length > 0
              ? this.commitTimestamps[this.commitTimestamps.length - 1]!
              : null;
          this.buildBeforePush =
            this.lastBuildOrTestTimestamp !== null &&
            (lastCt === null || this.lastBuildOrTestTimestamp > lastCt);
        }
        this.consecutiveFailedPushes = 0;
        this.statusChecksSinceLastAction = 0;
        break;

      case 'worktree':
        // Both the "worktree ops" count and the usesWorktrees/use_worktrees
        // signal are meant to reflect real worktree usage, not read-only
        // inspection — `list`/`prune`/`lock`/etc. shouldn't count as evidence
        // that worktrees were used to isolate parallel work.
        if (GIT_WORKTREE_ADD_REMOVE_RE.test(command)) {
          this.worktreeCommands++;
          this.hasUsedWorktree = true;
        }
        break;

      case 'status':
        this.statusChecksSinceLastAction++;
        break;

      default:
        this.statusChecksSinceLastAction = 0;
        break;
    }
  }

  // A pull that diverged enough to conflict is the strongest signal of a
  // stale branch — checked directly off the conflicting event's own command
  // (a `git pull` whose own output contains a conflict indicator classifies
  // as merge_conflict/rebase_conflict, never as 'pull', so this can't rely
  // on the event's `type`). A pull immediately followed by a *separate*
  // command that then conflicts is a weaker but still real signal, kept as a
  // fallback for events that don't match the direct case.
  private countStaleBranchPulls(): number {
    let staleCount = 0;
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      if (event.type !== 'merge_conflict' && event.type !== 'rebase_conflict') continue;
      if (GIT_PULL_RE.test(event.command ?? '')) {
        staleCount++;
      } else if (i > 0 && this.events[i - 1].type === 'pull') {
        staleCount++;
      }
    }
    return staleCount;
  }

  private computeRiskIndicators(): RiskIndicators {
    // Did we sync before our first edit?
    let syncedBeforeEditing: boolean | null = null;
    if (this.firstEditTimestamp !== null) {
      syncedBeforeEditing =
        this.firstSyncTimestamp !== null && this.firstSyncTimestamp < this.firstEditTimestamp;
    }

    const now = Date.now();
    const timeSinceLastSyncMs =
      this.lastSyncTimestamp !== null ? now - this.lastSyncTimestamp : null;

    // Hot files: files that conflicted AND were subsequently edited
    const hotFiles = [...this.conflictedFiles].filter((f) => this.editedFiles.has(f));

    const avgCommitsBetweenSyncs =
      this.syncIntervalCommitCounts.length > 0
        ? this.syncIntervalCommitCounts.reduce((a, b) => a + b, 0) /
          this.syncIntervalCommitCounts.length
        : null;

    const sessionDurationMs =
      this.sessionStartTimestamp !== null ? now - this.sessionStartTimestamp : null;

    return {
      syncedBeforeEditing,
      timeSinceLastSyncMs,
      commitsSinceLastSync: this.commitsSinceLastSync,
      pushRejections: this.pushRejections,
      forceAfterReject: this.forceAfterReject,
      hotFiles,
      usesWorktrees: this.hasUsedWorktree,
      usesForceWithLease: this.hasUsedForceWithLease,
      avgCommitsBetweenSyncs,
      commitsAheadOfMain: this.commitsAheadOfMain,
      commitsBehindMain: this.commitsBehindMain,
      sessionDurationMs,
      quickConflictResolutions: this.quickConflictResolutions,
    };
  }

  private evaluateBestPractices(
    risk: RiskIndicators,
    stats: {
      mergeConflicts: number;
      rebaseConflicts: number;
      commitCount: number;
      pullCount: number;
      forcePushes: number;
    },
  ): BestPractice[] {
    const practices: BestPractice[] = [];

    // 1. Sync before editing
    if (risk.syncedBeforeEditing === null) {
      practices.push({
        id: 'sync_before_edit',
        label: 'Sync before editing',
        status: 'unknown',
        detail: 'No edits detected yet.',
      });
    } else if (risk.syncedBeforeEditing) {
      practices.push({
        id: 'sync_before_edit',
        label: 'Sync before editing',
        status: 'pass',
        detail: 'Pulled/fetched before first file edit — branch was up to date.',
      });
    } else {
      practices.push({
        id: 'sync_before_edit',
        label: 'Sync before editing',
        status: 'fail',
        detail:
          'Started editing files without pulling first. Always run `git pull --rebase` or `git fetch` before beginning work to avoid conflicts.',
      });
    }

    // 2. Frequent syncing (pull/fetch every ~5 commits)
    if (stats.commitCount < 3) {
      practices.push({
        id: 'frequent_sync',
        label: 'Sync frequently',
        status: 'unknown',
        detail: 'Not enough commits yet to evaluate sync frequency.',
      });
    } else if (risk.commitsSinceLastSync > 8) {
      practices.push({
        id: 'frequent_sync',
        label: 'Sync frequently',
        status: 'fail',
        detail: `${risk.commitsSinceLastSync} commits since last sync. Pull/rebase at least every 5 commits to catch divergence early. The longer you drift, the worse the conflicts.`,
      });
    } else if (risk.commitsSinceLastSync > 5) {
      practices.push({
        id: 'frequent_sync',
        label: 'Sync frequently',
        status: 'warn',
        detail: `${risk.commitsSinceLastSync} commits since last sync. Consider pulling soon to minimize conflict risk.`,
      });
    } else {
      practices.push({
        id: 'frequent_sync',
        label: 'Sync frequently',
        status: stats.pullCount > 0 ? 'pass' : 'unknown',
        detail:
          stats.pullCount > 0
            ? 'Good sync cadence — pulling regularly between commits.'
            : 'No syncs detected yet.',
      });
    }

    // 3. Use rebase over merge (avoids merge commits that complicate history)
    const mergeEvents = this.events.filter((e) => e.type === 'merge');
    const rebaseEvents = this.events.filter((e) => e.type === 'rebase');
    if (mergeEvents.length === 0 && rebaseEvents.length === 0) {
      practices.push({
        id: 'prefer_rebase',
        label: 'Prefer rebase over merge',
        status: 'unknown',
        detail: 'No merge or rebase operations yet.',
      });
    } else if (mergeEvents.length > rebaseEvents.length) {
      practices.push({
        id: 'prefer_rebase',
        label: 'Prefer rebase over merge',
        status: 'warn',
        detail:
          'Using merge more than rebase. Rebasing keeps history linear and makes conflicts smaller and more localized. Use `git pull --rebase` instead of `git pull`.',
      });
    } else {
      practices.push({
        id: 'prefer_rebase',
        label: 'Prefer rebase over merge',
        status: 'pass',
        detail: 'Good — using rebase to stay in sync, keeping history linear.',
      });
    }

    // 4. Use worktrees for parallel work
    if (this.hasUsedWorktree) {
      practices.push({
        id: 'use_worktrees',
        label: 'Use worktrees for parallel work',
        status: 'pass',
        detail:
          'Using git worktrees — parallel tasks are isolated and cannot conflict with each other.',
      });
    } else if (stats.mergeConflicts + stats.rebaseConflicts > 0) {
      practices.push({
        id: 'use_worktrees',
        label: 'Use worktrees for parallel work',
        status: 'fail',
        detail:
          'Conflicts detected without worktree usage. When running multiple AI sessions in parallel (or switching between tasks), use `git worktree add` to give each task its own working directory. This completely eliminates cross-session conflicts.',
      });
    } else if (stats.commitCount < 3) {
      // Mirrors frequent_sync's "not enough commits yet" gate above — too
      // little activity to tell whether this session even involves the kind
      // of parallel/multi-task work worktrees would protect against.
      practices.push({
        id: 'use_worktrees',
        label: 'Use worktrees for parallel work',
        status: 'unknown',
        detail: 'Not enough activity yet to tell whether this session needs worktrees.',
      });
    } else {
      // Fully known, not a violation: no conflicts occurred and no worktree
      // was used. Distinct from the 'unknown' branch above — this session
      // had enough activity to judge, and simply didn't need worktree
      // isolation, which is a fine outcome, not "we don't know."
      practices.push({
        id: 'use_worktrees',
        label: 'Use worktrees for parallel work',
        status: 'n/a',
        detail:
          "No conflicts and no worktree usage detected this session — parallel-session isolation wasn't needed here.",
      });
    }

    // 5. Use --force-with-lease instead of --force. Gated on
    // hasUsedBareForcePush rather than forcePushes/usesForceWithLease alone —
    // those two count safe and unsafe force-pushes together, so checking
    // usesForceWithLease alone would let one safe `--force-with-lease` mask a
    // dangerous bare `--force` in the same session with a fully-passing
    // status.
    if (stats.forcePushes === 0) {
      practices.push({
        id: 'force_with_lease',
        label: 'Use --force-with-lease',
        status: 'unknown',
        detail: 'No force pushes yet.',
      });
    } else if (this.hasUsedBareForcePush && risk.usesForceWithLease) {
      practices.push({
        id: 'force_with_lease',
        label: 'Use --force-with-lease',
        status: 'warn',
        detail:
          'Mixed usage this session — some force pushes used --force-with-lease, but at least one bare --force (unsafe) push also occurred. Always use --force-with-lease; it refuses to push if someone else has pushed to the branch since your last fetch.',
      });
    } else if (this.hasUsedBareForcePush) {
      practices.push({
        id: 'force_with_lease',
        label: 'Use --force-with-lease',
        status: 'fail',
        detail:
          'Using bare --force instead of --force-with-lease. The --force-with-lease flag is a safety net: it refuses to push if someone else has pushed to the branch since your last fetch. Always prefer it.',
      });
    } else {
      practices.push({
        id: 'force_with_lease',
        label: 'Use --force-with-lease',
        status: 'pass',
        detail:
          "Good — using --force-with-lease which refuses to overwrite remote commits you haven't seen.",
      });
    }

    // 6. Keep PRs small (proxy: many commits without pushing)
    if (risk.commitsSinceLastSync > 15) {
      practices.push({
        id: 'small_increments',
        label: 'Push in small increments',
        status: 'fail',
        detail: `${risk.commitsSinceLastSync} local commits without pushing. Large batches create massive diffs that are more likely to conflict and harder to review. Push and open PRs early and often.`,
      });
    } else if (stats.commitCount >= 3) {
      practices.push({
        id: 'small_increments',
        label: 'Push in small increments',
        status: 'pass',
        detail: 'Good — committing and syncing in small batches.',
      });
    }

    // 7. Avoid editing hot files
    if (risk.hotFiles.length > 0) {
      practices.push({
        id: 'avoid_hot_files',
        label: 'Avoid re-editing conflicted files',
        status: 'warn',
        detail: `Editing files that previously conflicted: ${risk.hotFiles.slice(0, 3).join(', ')}${risk.hotFiles.length > 3 ? ` (+${risk.hotFiles.length - 3} more)` : ''}. These are "hot" files with active upstream changes — edits here are likely to conflict again. Consider coordinating or waiting for upstream to stabilize.`,
      });
    }

    // 8. Build/test before pushing
    if (this.buildBeforePush === null && this.lastPushTimestamp === null) {
      practices.push({
        id: 'verify_before_push',
        label: 'Build/test before pushing',
        status: 'unknown',
        detail: 'No pushes yet.',
      });
    } else if (this.buildBeforePush === true) {
      practices.push({
        id: 'verify_before_push',
        label: 'Build/test before pushing',
        status: 'pass',
        detail:
          'Good — ran build or tests before pushing. This catches errors before they reach CI and avoids wasted review cycles.',
      });
    } else if (this.buildBeforePush === false) {
      practices.push({
        id: 'verify_before_push',
        label: 'Build/test before pushing',
        status: 'fail',
        detail:
          "Pushed without running build or tests first. Always run `npm run build && npm test` before pushing to catch issues locally — it's faster than waiting for CI.",
      });
    }

    return practices;
  }

  private computePreventionScore(practices: BestPractice[]): number | null {
    // 'n/a' (fully known, not applicable) is excluded the same way 'unknown'
    // (genuinely insufficient data) is — neither should count for or against
    // the score. See BestPractice['status']'s docstring for the distinction.
    const scorable = practices.filter((p) => p.status !== 'unknown' && p.status !== 'n/a');
    if (scorable.length < 2) return null;

    let points = 0;
    let total = 0;
    for (const p of scorable) {
      total += 1;
      if (p.status === 'pass') points += 1;
      else if (p.status === 'warn') points += 0.5;
    }
    return Math.round((points / total) * 100);
  }

  private generateSuggestions(stats: {
    totalGitCommands: number;
    mergeConflicts: number;
    rebaseConflicts: number;
    abortedOperations: number;
    forcePushes: number;
    resetHards: number;
    discardedChanges: number;
    pullCount: number;
    commitCount: number;
    staleBranchPulls: number;
    riskIndicators: RiskIndicators;
  }): GitSuggestion[] {
    const suggestions: GitSuggestion[] = [];

    // --- Proactive prevention suggestions (fire BEFORE conflicts happen) ---
    //
    // syncedBeforeEditing, commitsSinceLastSync (drift), and hotFiles are
    // ongoing-state conditions already surfaced as their own Best Practice
    // checks (sync_before_edit, frequent_sync, avoid_hot_files) — duplicating
    // them here as one-off suggestions rendered the same fact twice, with a
    // conflicting severity in the hot-files case. Best Practices is their
    // canonical home; only force-after-reject (a one-time, reactive event
    // with actionable remediation) is kept as a suggestion.

    if (stats.riskIndicators.forceAfterReject > 0) {
      suggestions.push({
        severity: 'critical',
        category: 'force_after_reject',
        message:
          'Push was rejected and then force-pushed — this overwrites upstream changes. The correct response to a rejected push is: `git fetch`, then `git rebase origin/<branch>`, resolve any conflicts, then push normally. Force push is a last resort, not a first response.',
        evidence: `${stats.riskIndicators.forceAfterReject} force push(es) within 5 min of a rejection`,
      });
    }

    // --- Reactive suggestions (fire after problems occur) ---

    if (stats.mergeConflicts + stats.rebaseConflicts >= 3) {
      suggestions.push({
        severity: 'critical',
        category: 'merge_conflicts',
        message:
          "Frequent merge conflicts this session. Root causes for AI assistants: (1) not pulling at session start, (2) working on stale branches too long, (3) editing files with active upstream changes. Fix: sync every 3–5 commits, use worktrees for parallel tasks, and check `git log origin/main..HEAD` to see how far you've drifted.",
        evidence: `${stats.mergeConflicts + stats.rebaseConflicts} conflicts this session`,
      });
    } else if (stats.mergeConflicts + stats.rebaseConflicts >= 1) {
      suggestions.push({
        severity: 'warning',
        category: 'merge_conflicts',
        message:
          'Merge conflict encountered. For future prevention: `git fetch && git rebase origin/main` before starting work and after every ~5 commits. If this is a busy repo, consider shorter-lived branches and smaller PRs.',
        evidence: `${stats.mergeConflicts + stats.rebaseConflicts} conflict(s) this session`,
      });
    }

    if (stats.abortedOperations >= 2) {
      suggestions.push({
        severity: 'warning',
        category: 'aborted_operations',
        message:
          'Multiple aborted merge/rebase operations suggest the branch has diverged too far. Strategy: (1) break the rebase into smaller steps with `git rebase --onto`, (2) cherry-pick only your commits onto a fresh branch, or (3) do an interactive rebase squashing first to reduce conflict surface area.',
        evidence: `${stats.abortedOperations} aborted operations`,
      });
    }

    // Severity is gated on hasUsedBareForcePush/bareForcePushCount — the same
    // shared signal the force_with_lease best-practice check uses — rather
    // than the raw forcePushes count, which sums bare AND lease-protected
    // pushes together. Gating (and scaling) on the bare-only count keeps this
    // suggestion's ranking consistent with the best-practice check: adding a
    // safe --force-with-lease push on top of an existing bare push must never
    // raise severity, since only the bare push is actually risky.
    //
    // A bare push to the shared default branch is escalated to 'critical'
    // outright, regardless of count — it can clobber other collaborators'
    // work, unlike an identical push to a personal feature branch (which
    // still scales by count, as above).
    if (this.hasUsedBareForcePush) {
      suggestions.push({
        severity: this.hasForcePushedToDefaultBranch
          ? 'critical'
          : this.bareForcePushCount >= 2
            ? 'critical'
            : 'warning',
        category: 'force_push',
        message: this.hasForcePushedToDefaultBranch
          ? `Bare --force push used on the shared default branch (${this.repoContext.defaultBranch ?? 'default branch'}) — this can overwrite history other collaborators are building on. Always use --force-with-lease, and avoid force-pushing the default branch entirely if possible.`
          : 'Bare --force push used. Always use --force-with-lease instead — it refuses to push if someone else has pushed to the branch since your last fetch. If you need to rewrite history, coordinate with collaborators first and ensure your local refs are up to date with `git fetch` before force pushing.',
        evidence: this.hasForcePushedToDefaultBranch
          ? `${this.bareForcePushCount} bare --force push(es) this session, including at least one on the default branch`
          : `${this.bareForcePushCount} bare --force push(es) this session`,
      });
    } else if (stats.riskIndicators.usesForceWithLease && stats.forcePushes >= 2) {
      suggestions.push({
        severity: 'info',
        category: 'force_push',
        message:
          'Multiple force pushes this session, all using --force-with-lease — the safe pattern. Repeated history rewrites can still be worth a second look if they indicate a workflow issue upstream.',
        evidence: `${stats.forcePushes} lease-protected force pushes this session`,
      });
    }

    if (stats.resetHards >= 2) {
      suggestions.push({
        severity: 'warning',
        category: 'reset_hard',
        message:
          'Multiple hard resets. Consider `git stash` to save work before resetting, or `git reset --mixed` to unstage without losing working tree changes.',
        evidence: `${stats.resetHards} hard resets`,
      });
    }

    if (stats.staleBranchPulls >= 2) {
      suggestions.push({
        severity: 'warning',
        category: 'stale_branch',
        message:
          "Pulls repeatedly cause conflicts — the branch has significantly diverged. Prevention: (1) rebase onto target branch at the START of each session, (2) use `git fetch` + `git log ..origin/main` to check divergence before pulling, (3) for long-lived branches, rebase daily even if you're not done.",
        evidence: `${stats.staleBranchPulls} pulls that led directly to conflicts`,
      });
    }

    if (stats.discardedChanges >= 3) {
      suggestions.push({
        severity: 'info',
        category: 'discarded_changes',
        message:
          "Frequently discarding changes. Use a scratch branch (`git checkout -b scratch/experiment`) instead — you can always delete it later, but you can't recover discarded changes.",
        evidence: `${stats.discardedChanges} discard operations`,
      });
    }

    if (stats.totalGitCommands > 10 && stats.pullCount === 0) {
      suggestions.push({
        severity: 'info',
        category: 'sync_frequency',
        message:
          'No pulls detected this session despite significant git activity. On shared branches, pull at least every 15 minutes or every 5 commits — whichever comes first.',
        evidence: `${stats.totalGitCommands} git commands, 0 pulls`,
      });
    }

    if (
      stats.commitCount > 10 &&
      stats.pullCount === 0 &&
      stats.mergeConflicts + stats.rebaseConflicts === 0
    ) {
      suggestions.push({
        severity: 'warning',
        category: 'divergence_risk',
        message:
          "You've made many commits without syncing. Even though there are no conflicts YET, you're accumulating divergence that makes future conflicts larger and harder to resolve. Sync now while it's easy: `git fetch && git rebase origin/main`.",
        evidence: `${stats.commitCount} commits, 0 syncs`,
      });
    }

    // --- Field guide: branch divergence from main ---

    if (
      stats.riskIndicators.commitsBehindMain !== null &&
      stats.riskIndicators.commitsBehindMain > 20
    ) {
      suggestions.push({
        severity: 'warning',
        category: 'behind_main',
        message: `Branch is ${stats.riskIndicators.commitsBehindMain} commits behind main. The longer you wait to rebase, the more painful it gets. Run \`git fetch origin && git rebase origin/main\` before it gets worse. On an active repo, main can move 20+ commits per day.`,
        evidence: `${stats.riskIndicators.commitsBehindMain} commits behind origin/main`,
      });
    } else if (
      stats.riskIndicators.commitsBehindMain !== null &&
      stats.riskIndicators.commitsBehindMain > 5
    ) {
      suggestions.push({
        severity: 'info',
        category: 'behind_main',
        message: `Branch is ${stats.riskIndicators.commitsBehindMain} commits behind main. Consider rebasing soon to stay current.`,
        evidence: `${stats.riskIndicators.commitsBehindMain} commits behind origin/main`,
      });
    }

    // --- Field guide: session duration as PR size risk ---

    if (
      stats.riskIndicators.sessionDurationMs !== null &&
      stats.riskIndicators.sessionDurationMs > 2 * 3600_000 &&
      stats.commitCount > 15
    ) {
      suggestions.push({
        severity: 'info',
        category: 'session_length',
        message:
          'Long session with many commits. The single biggest predictor of merge pain is how long a branch lives. Consider breaking this into smaller PRs that merge incrementally — a 200-line PR that ships in 30 minutes almost never conflicts.',
        evidence: `Session running ${Math.round(stats.riskIndicators.sessionDurationMs / 3600_000)}h with ${stats.commitCount} commits`,
      });
    }

    // --- Field guide: blind conflict resolution warning ---

    if (stats.riskIndicators.quickConflictResolutions > 0) {
      suggestions.push({
        severity: 'warning',
        category: 'quick_resolution',
        message:
          'Conflicts were resolved very quickly (under 30 seconds). AI-generated conflict resolutions should be reviewed line by line — they handle syntactic conflicts well but can miss semantic conflicts where two PRs modified the same logic with different intent. Run the test suite after every resolution.',
        evidence: `${stats.riskIndicators.quickConflictResolutions} conflict(s) resolved in under 30s`,
      });
    }

    // --- Field guide: suggest SessionStart hook ---

    if (stats.riskIndicators.syncedBeforeEditing === false && stats.totalGitCommands > 3) {
      suggestions.push({
        severity: 'info',
        category: 'session_hook',
        message:
          'Tip: Add a SessionStart hook to ~/.claude/settings.json that auto-runs `git fetch --all --prune` at the start of every session. Claude Code does not auto-fetch — it operates on whatever git state is on disk. The hook ensures you always start fresh without having to remember.',
        evidence: 'No sync before first edit this session',
      });
    }

    return suggestions;
  }

  private computeScore(stats: {
    totalGitCommands: number;
    mergeConflicts: number;
    rebaseConflicts: number;
    abortedOperations: number;
    forcePushes: number;
    resetHards: number;
    discardedChanges: number;
    conflictResolutionRate: number | null;
  }): number | null {
    if (stats.totalGitCommands < 3) return null;

    let score = 100;

    // All per-event penalties and caps below are hand-tuned weights reflecting
    // relative severity (e.g. a conflict is worse than a discard), not derived
    // from data. Tune here if the resulting score reads as too harsh/lenient.
    const conflictPenalty = Math.min((stats.mergeConflicts + stats.rebaseConflicts) * 10, 40);
    score -= conflictPenalty;

    score -= Math.min(stats.abortedOperations * 15, 30);
    score -= Math.min(stats.forcePushes * 10, 20);
    score -= Math.min(stats.resetHards * 5, 15);
    score -= Math.min(stats.discardedChanges * 3, 15);

    if (stats.conflictResolutionRate !== null && stats.conflictResolutionRate >= 0.8) {
      score += 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  private computeVelocityMetrics(): VelocityMetrics {
    const sorted = [...this.commitTimestamps].sort((a, b) => a - b);

    let avgTimeBetweenCommitsMs: number | null = null;
    let longestGapMs: number | null = null;
    let commitBurstCount = 0;

    if (sorted.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push(sorted[i] - sorted[i - 1]);
      }
      avgTimeBetweenCommitsMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      longestGapMs = gaps.reduce((max, g) => (g > max ? g : max), 0);
      // A "burst" is 3+ commits within 2 minutes of each other; count once per burst
      let consecutive = 1;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - sorted[i - 1] < 120_000) {
          consecutive++;
          if (consecutive === 3) commitBurstCount++;
        } else {
          consecutive = 1;
        }
      }
    }

    return {
      avgTimeBetweenCommitsMs,
      commitBurstCount,
      longestGapMs,
      worktreeCount: this.worktreeCommands,
      buildBeforePush: this.buildBeforePush,
      // Use the push-time snapshot rather than comparing current timestamps, which go
      // stale when new builds run after the push.
      // Intentionally the same value as buildBeforePush, not a separate signal:
      // recordToolCall() tracks build and test commands as one combined
      // "verification happened" timestamp (isTestCommand || isBuildCommand),
      // so there's no way to distinguish "tested" from "built" after the fact.
      testBeforePush: this.buildBeforePush,
    };
  }

  private computeConflictStrategy(): ConflictResolutionStrategy {
    const manualMergeCount = Math.max(
      0,
      this.conflictRecords.filter((c) => c.resolution === 'resolved').length -
        this.oursCount -
        this.theirsCount -
        this.cherryPickCount,
    );

    return {
      oursCount: this.oursCount,
      theirsCount: this.theirsCount,
      manualMergeCount,
      cherryPickCount: this.cherryPickCount,
      totalResolutions: this.oursCount + this.theirsCount + this.cherryPickCount + manualMergeCount,
    };
  }
}
