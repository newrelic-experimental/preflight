import type { ToolCallRecord, ReplayTimelineEntry } from '../storage/types.js';

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
  readonly status: 'pass' | 'fail' | 'warn' | 'unknown';
  readonly detail: string;
}

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
  private pendingConflictTimestamp: number | null = null;
  private pendingConflictCommand: string = '';
  private pendingConflictFiles: string[] = [];
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
  private totalToolCalls = 0;
  private sessionStartTimestamp: number | null = null;
  private commitTimestamps: number[] = [];
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

    const command = record.command as string | undefined;
    if (!command) return;

    // Track GitHub CLI PR commands (skip if `git commit` is the *command*, not
    // text that happens to appear inside a gh argument like --title).
    if (GH_COMMAND_RE.test(command) && !command.trimStart().startsWith('git ')) {
      this.processGhCommand(command, record.timestamp);
    }

    if (!GIT_COMMAND_RE.test(command)) return;

    const event = this.classifyGitCommand(command, record);
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

    // Time from first commit to first PR creation
    let avgTimeToCreateMs: number | null = null;
    if (created > 0 && this.firstCommitTimestamp !== null) {
      const firstCreate = this.prEvents.find((e) => e.action === 'create');
      if (firstCreate) {
        avgTimeToCreateMs = Math.max(0, firstCreate.timestamp - this.firstCommitTimestamp);
      }
    }

    return {
      created,
      merged,
      checksViewed,
      prsUpdated,
      prActivity: this.prEvents.slice(-20),
      avgTimeToCreateMs,
    };
  }

  hydrateGitLog(commits: readonly { timestamp: number; hash: string }[]): void {
    for (const commit of commits) {
      if (!commit.hash) continue;
      const event: GitEvent = {
        timestamp: commit.timestamp,
        type: 'commit',
        command: `git commit (${commit.hash})`,
        success: true,
        durationMs: null,
      };
      // Only add if we don't already have this commit tracked
      const isDuplicate = this.events.some(
        (e) => e.type === 'commit' && e.command?.includes(commit.hash),
      );
      if (!isDuplicate) {
        this.events.push(event);
        this.commitTimestamps.push(commit.timestamp);
        // Don't increment commitsSinceLastSync for historical commits — this counter
        // tracks real-time session activity, not replayed history.
      }
    }
  }

  replayTimeline(entries: readonly ReplayTimelineEntry[]): void {
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

    const resolved = this.conflictRecords.filter((c) => c.resolution === 'resolved');
    const conflictResolutionRate =
      this.conflictRecords.length > 0 ? resolved.length / this.conflictRecords.length : null;

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
      gitCommandTimeline: this.events.slice(-50),
      conflictHistory: this.conflictRecords,
      suggestions,
      bestPractices,
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
    this.pendingConflictTimestamp = null;
    this.pendingConflictCommand = '';
    this.pendingConflictFiles = [];
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
    this.totalToolCalls = 0;
    this.sessionStartTimestamp = null;
    this.commitTimestamps = [];
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
    this.firstCommitTimestamp = null;
    this.repoContext = { repoName: null, branch: null, remoteName: null, defaultBranch: null };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private classifyGitCommand(command: string, record: ToolCallRecord): GitEvent {
    const base = {
      timestamp: record.timestamp,
      command,
      success: record.success,
      durationMs: record.durationMs,
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
    // Track conflict resolution strategies regardless of event type
    if (GIT_CHECKOUT_OURS_RE.test(command)) this.oursCount++;
    if (GIT_CHECKOUT_THEIRS_RE.test(command)) this.theirsCount++;
    if (GIT_CHERRY_PICK_RE.test(command)) this.cherryPickCount++;

    switch (event.type) {
      case 'merge_conflict':
      case 'rebase_conflict': {
        this.pendingConflictTimestamp = event.timestamp;
        this.pendingConflictCommand = command;
        const output = (record.error as string) ?? '';
        const files: string[] = [];
        let match: RegExpExecArray | null;
        CONFLICT_FILE_RE.lastIndex = 0;
        while ((match = CONFLICT_FILE_RE.exec(output)) !== null) {
          files.push(match[1].trim());
          this.conflictedFiles.add(match[1].trim());
        }
        this.pendingConflictFiles = files;
        this.pullsSinceLastConflict = 0;
        break;
      }

      case 'merge_abort':
      case 'rebase_abort':
      case 'cherry_pick_abort':
        if (this.pendingConflictTimestamp !== null) {
          this.conflictRecords.push({
            timestamp: this.pendingConflictTimestamp,
            resolution: 'aborted',
            resolutionTimeMs: event.timestamp - this.pendingConflictTimestamp,
            command: this.pendingConflictCommand,
            files: this.pendingConflictFiles,
          });
          this.pendingConflictTimestamp = null;
          this.pendingConflictCommand = '';
          this.pendingConflictFiles = [];
        }
        break;

      case 'commit': {
        // git commit --amend fixes a prior commit, not a merge conflict.
        // Clear the pending conflict on amend so the *next* normal commit
        // doesn't see a stale pendingConflictTimestamp (potentially hours old).
        if (command.includes('--amend')) {
          this.pendingConflictTimestamp = null;
          this.pendingConflictCommand = '';
          this.pendingConflictFiles = [];
        }
        if (this.pendingConflictTimestamp !== null && !command.includes('--amend')) {
          const resolutionMs = event.timestamp - this.pendingConflictTimestamp;
          this.conflictRecords.push({
            timestamp: this.pendingConflictTimestamp,
            resolution: 'resolved',
            resolutionTimeMs: resolutionMs,
            command: this.pendingConflictCommand,
            files: this.pendingConflictFiles,
          });
          // Under 30s resolution with multiple conflicted files is suspiciously fast
          if (resolutionMs < 30_000 && this.pendingConflictFiles.length > 1) {
            this.quickConflictResolutions++;
          }
          this.pendingConflictTimestamp = null;
          this.pendingConflictCommand = '';
          this.pendingConflictFiles = [];
        }
        this.commitTimestamps.push(event.timestamp);
        if (this.firstCommitTimestamp === null) {
          this.firstCommitTimestamp = event.timestamp;
        }
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
        this.hasUsedWorktree = true;
        this.worktreeCommands++;
        break;

      case 'status':
        this.statusChecksSinceLastAction++;
        break;

      default:
        this.statusChecksSinceLastAction = 0;
        break;
    }
  }

  private countStaleBranchPulls(): number {
    let staleCount = 0;
    for (let i = 0; i < this.events.length - 1; i++) {
      if (this.events[i].type === 'pull') {
        const next = this.events[i + 1];
        if (next.type === 'merge_conflict' || next.type === 'rebase_conflict') {
          staleCount++;
        }
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
    } else {
      practices.push({
        id: 'use_worktrees',
        label: 'Use worktrees for parallel work',
        status: 'unknown',
        detail: 'No worktree usage detected. Consider worktrees if you run parallel sessions.',
      });
    }

    // 5. Use --force-with-lease instead of --force
    if (stats.forcePushes === 0) {
      practices.push({
        id: 'force_with_lease',
        label: 'Use --force-with-lease',
        status: 'unknown',
        detail: 'No force pushes yet.',
      });
    } else if (risk.usesForceWithLease) {
      practices.push({
        id: 'force_with_lease',
        label: 'Use --force-with-lease',
        status: 'pass',
        detail:
          "Good — using --force-with-lease which refuses to overwrite remote commits you haven't seen.",
      });
    } else {
      practices.push({
        id: 'force_with_lease',
        label: 'Use --force-with-lease',
        status: 'fail',
        detail:
          'Using bare --force instead of --force-with-lease. The --force-with-lease flag is a safety net: it refuses to push if someone else has pushed to the branch since your last fetch. Always prefer it.',
      });
    }

    // 6. Don't force-push after a rejection without investigating
    if (risk.forceAfterReject > 0) {
      practices.push({
        id: 'no_force_after_reject',
        label: "Don't force-push after rejection",
        status: 'fail',
        detail: `Push was rejected ${risk.pushRejections} time(s) and then force-pushed ${risk.forceAfterReject} time(s). When a push is rejected, pull + rebase first to incorporate upstream changes. Force pushing after a rejection overwrites others' work.`,
      });
    } else if (risk.pushRejections > 0) {
      practices.push({
        id: 'no_force_after_reject',
        label: "Don't force-push after rejection",
        status: 'pass',
        detail: 'Push was rejected but correctly handled without force pushing.',
      });
    }

    // 7. Keep PRs small (proxy: many commits without pushing)
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

    // 8. Avoid editing hot files
    if (risk.hotFiles.length > 0) {
      practices.push({
        id: 'avoid_hot_files',
        label: 'Avoid re-editing conflicted files',
        status: 'warn',
        detail: `Editing files that previously conflicted: ${risk.hotFiles.slice(0, 3).join(', ')}${risk.hotFiles.length > 3 ? ` (+${risk.hotFiles.length - 3} more)` : ''}. These are "hot" files with active upstream changes — edits here are likely to conflict again. Consider coordinating or waiting for upstream to stabilize.`,
      });
    }

    // 9. Build/test before pushing
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
    const scorable = practices.filter((p) => p.status !== 'unknown');
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

    if (stats.riskIndicators.syncedBeforeEditing === false) {
      suggestions.push({
        severity: 'warning',
        category: 'no_initial_sync',
        message:
          'Started editing without syncing first. Run `git fetch && git rebase origin/main` (or your target branch) at the start of every session. This single habit prevents the majority of AI-assisted coding conflicts.',
        evidence: 'First file edit occurred before any git pull/fetch',
      });
    }

    if (stats.riskIndicators.commitsSinceLastSync > 8) {
      suggestions.push({
        severity: 'warning',
        category: 'drift_risk',
        message: `${stats.riskIndicators.commitsSinceLastSync} commits without syncing. You're accumulating drift that will compound into painful conflicts. Run \`git fetch && git rebase origin/main\` now — smaller, frequent rebases are far easier than one large one later.`,
        evidence: `${stats.riskIndicators.commitsSinceLastSync} commits since last pull/fetch/rebase`,
      });
    }

    if (stats.riskIndicators.forceAfterReject > 0) {
      suggestions.push({
        severity: 'critical',
        category: 'force_after_reject',
        message:
          'Push was rejected and then force-pushed — this overwrites upstream changes. The correct response to a rejected push is: `git fetch`, then `git rebase origin/<branch>`, resolve any conflicts, then push normally. Force push is a last resort, not a first response.',
        evidence: `${stats.riskIndicators.forceAfterReject} force push(es) within 5 min of a rejection`,
      });
    }

    if (stats.riskIndicators.hotFiles.length > 0) {
      suggestions.push({
        severity: 'info',
        category: 'hot_files',
        message: `You're editing files that previously conflicted (${stats.riskIndicators.hotFiles.slice(0, 3).join(', ')}). These likely have active upstream work. Consider: (1) rebasing immediately to get latest state, (2) coordinating with whoever else is touching these files, or (3) deferring changes until upstream settles.`,
        evidence: `${stats.riskIndicators.hotFiles.length} previously-conflicted file(s) re-edited`,
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

    if (stats.forcePushes >= 2) {
      suggestions.push({
        severity: 'critical',
        category: 'force_push',
        message:
          'Multiple force pushes this session. Always use --force-with-lease as a safety net. If you need to rewrite history, coordinate with collaborators first and ensure your local refs are up to date with `git fetch` before force pushing.',
        evidence: `${stats.forcePushes} force pushes this session`,
      });
    } else if (stats.forcePushes === 1) {
      suggestions.push({
        severity: 'info',
        category: 'force_push',
        message:
          "Force push used. Prefer --force-with-lease for safer force pushes — it refuses to overwrite commits you haven't seen locally.",
        evidence: '1 force push',
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
      testBeforePush: this.buildBeforePush,
    };
  }

  private computeConflictStrategy(): ConflictResolutionStrategy {
    const manualMergeCount =
      this.conflictRecords.filter((c) => c.resolution === 'resolved').length -
      this.oursCount -
      this.theirsCount;

    return {
      oursCount: this.oursCount,
      theirsCount: this.theirsCount,
      manualMergeCount: Math.max(0, manualMergeCount),
      cherryPickCount: this.cherryPickCount,
      totalResolutions: this.oursCount + this.theirsCount + Math.max(0, manualMergeCount),
    };
  }
}
