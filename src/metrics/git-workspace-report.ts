import { createLogger } from '../shared/index.js';
import { GIT_LOG_SESSION_ID, type GitActivityRecord } from './git-activity-recorder.js';
import type { GitEvent } from './git-event-classifier.js';
import type {
  BestPractice,
  ConflictResolutionStrategy,
  GitEfficiencyMetrics,
  GitSuggestion,
  MergeConflictRecord,
  PrEvent,
  PullRequestMetrics,
  RiskIndicators,
  VelocityMetrics,
} from './git-efficiency-tracker.js';
import {
  UNATTRIBUTED_WORKSPACE_KEY,
  isPlaceholderIdentity,
  type WorktreeIdentity,
} from './git-workspace-identity.js';

const logger = createLogger('git-workspace-report');

// ---------------------------------------------------------------------------
// Regexes needed to reproduce GitEfficiencyTracker's processEvent() switch.
// Copied from git-efficiency-tracker.ts rather than exported from there,
// since that file is a frozen transplant source, not a shared dependency.
// ---------------------------------------------------------------------------

const GIT_CHECKOUT_OURS_RE = /\bgit\s+checkout\s+--ours\b/;
const GIT_CHECKOUT_THEIRS_RE = /\bgit\s+checkout\s+--theirs\b/;
const GIT_CHERRY_PICK_RE = /\bgit\s+cherry-pick\b/;
const CHERRY_PICK_ABORT_RE = /\bgit\s+cherry-pick\s+--abort\b/;
const GIT_WORKTREE_ADD_REMOVE_RE = /\bgit\s+worktree\s+(?:add|remove)\b/;
const GIT_PULL_RE = /\bgit\s+pull\b/;

// Render order for suggestions/best-practices — most severe first — rather
// than fixed source-code push order, which could put a critical item below
// a milder one. Duplicated from git-efficiency-tracker.ts (see note above).
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A live sample of one workspace's own branch/divergence state, sampled
 * separately from `GitActivityRecord` history (that sampling logic is a
 * later phase — this is accepted as an external input here). `null` means
 * no live sample has been taken yet for this workspace.
 */
export interface WorktreeLiveState {
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly measuredAtMs: number;
}

/**
 * `GitEfficiencyMetrics` minus `repoContext` (the caller already knows
 * `identity`) and minus the `use_worktrees` best-practice entry (see
 * `evaluateBestPractices` below — it doesn't belong at single-workspace
 * scope), plus fields needed either to carry live branch-divergence state
 * for this one workspace (`liveState`) or to let `rollupWorkspaceMetrics`
 * recombine several already-computed `WorkspaceMetrics` without ever
 * re-running the sequential state machine over merged raw records.
 */
export interface WorkspaceMetrics extends Omit<GitEfficiencyMetrics, 'repoContext'> {
  readonly liveState: WorktreeLiveState | null;
  /** This workspace's own commit timestamps — merges safely across
   *  workspaces at rollup (a commit is a commit), unlike the sequential
   *  counters above. */
  readonly commitTimestamps: readonly number[];
  /** This workspace's own most recent push timestamp, or null if it never
   *  pushed. Lets a rollup pick "whichever workspace pushed most recently"
   *  for its own buildBeforePush/testBeforePush without re-deriving it from
   *  merged events. */
  readonly lastPushTimestamp: number | null;
  /** Files edited in this workspace. Distinct from `riskIndicators.hotFiles`
   *  (conflicted AND re-edited within this one workspace) — this is the raw
   *  edited-file set, needed to detect the SAME file edited across two
   *  DIFFERENT workspaces (see `parallel_isolation` in
   *  `buildGitWorkspaceReport`), which `hotFiles` can't answer. */
  readonly editedFiles: readonly string[];
  /** Whether this workspace ever used a bare (non-lease) `--force` push.
   *  Kept distinct from `forcePushes` (which sums bare AND lease-protected
   *  pushes) and from `riskIndicators.usesForceWithLease`, so a rollup can
   *  tell "was ANY force-push here unsafe" without conflating it with "was
   *  --force-with-lease ever also used." */
  readonly hasUsedBareForcePush: boolean;
  readonly bareForcePushCount: number;
  /** Whether a bare force-push ever landed while this workspace's own
   *  branch matched its own default branch (per the current `liveState`
   *  sample at the time of each push). */
  readonly hasForcePushedToDefaultBranch: boolean;
  /** Raw `merge`/`rebase` event counts (distinct from `mergeConflicts`/
   *  `rebaseConflicts`, which count only *conflicting* attempts) — needed to
   *  recompute the `prefer_rebase` best-practice check at rollup scope,
   *  since `gitCommandTimeline` is capped at 50 and can't be summed for
   *  this. */
  readonly mergeEventCount: number;
  readonly rebaseEventCount: number;
  /** Latest `timestamp` across every record this workspace saw in the
   *  requested window — git, edit, verify, and PR records alike, unlike
   *  `lastPushTimestamp` which only tracks pushes. Null when the workspace
   *  had no records at all. Drives "most recently active" sort ordering; a
   *  max, so it merges safely at rollup the same way `commitTimestamps` does. */
  readonly lastActivityMs: number | null;
  /** Distinct Claude Code session ids that produced any record in this
   *  workspace within the requested window — 'unknown' for a record whose
   *  source ToolCallRecord had no sessionId. Lets the UI deep-link "view
   *  the exact sessions behind this repo/worktree" precisely, rather than
   *  approximating by repo name. Merges safely at rollup via a Set union
   *  (a session is a session), unlike the sequential counters above. */
  readonly sessionIds: readonly string[];
}

export interface ScopeRef {
  readonly kind: 'all' | 'repo' | 'worktree';
  /** WorktreeIdentity.repoKey (kind 'repo') or .worktreeKey (kind 'worktree'). Absent for 'all'. */
  readonly id?: string;
}

export interface WorkspaceRow {
  readonly identity: WorktreeIdentity;
  readonly metrics: WorkspaceMetrics;
}

export interface GitWorkspaceReport {
  readonly scope: ScopeRef;
  /** Rollup metrics for the requested scope (all workspaces if scope.kind==='all',
   *  all worktrees of one repo if 'repo', or just that one workspace's own
   *  metrics — unrolled-up — if 'worktree'). */
  readonly metrics: WorkspaceMetrics;
  /** Every individual workspace with activity in this window, for the table —
   *  NOT filtered by scope; the UI filters/groups this client-side when
   *  drilling in, since it's cheap and avoids a second request per click. */
  readonly rows: readonly WorkspaceRow[];
  /** Named "worst behind" callout — the single workspace (among ALL rows,
   *  not just the requested scope) with the highest non-null `behind` in its
   *  own liveState, or null if no row has live branch-divergence data yet. */
  readonly worstBehind: {
    readonly identity: WorktreeIdentity;
    readonly behind: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Coaching (shared between a single workspace's own metrics and a rollup's
// re-run over pre-aggregated totals — never over merged raw records).
// ---------------------------------------------------------------------------

interface CoachingInputs {
  readonly totalGitCommands: number;
  readonly mergeConflicts: number;
  readonly rebaseConflicts: number;
  readonly abortedOperations: number;
  readonly forcePushes: number;
  readonly resetHards: number;
  readonly discardedChanges: number;
  readonly pullCount: number;
  readonly commitCount: number;
  readonly staleBranchPulls: number;
  readonly mergeEventCount: number;
  readonly rebaseEventCount: number;
  readonly hasUsedBareForcePush: boolean;
  readonly bareForcePushCount: number;
  readonly hasForcePushedToDefaultBranch: boolean;
  /** Default branch name for the force_push suggestion's message, when
   *  known. Null at rollup — there's no single default branch across
   *  several workspaces. */
  readonly defaultBranchName: string | null;
  readonly buildBeforePush: boolean | null;
  readonly lastPushTimestamp: number | null;
  readonly conflictResolutionRate: number | null;
  readonly riskIndicators: RiskIndicators;
}

/**
 * Adapted from `GitEfficiencyTracker.evaluateBestPractices`. Coaching
 * threshold/copy text is preserved verbatim. The `use_worktrees` check is
 * removed entirely — it's a repo-scope concept (see `parallel_isolation` in
 * `buildGitWorkspaceReport`), not a single-workspace one.
 */
function evaluateBestPractices(inputs: CoachingInputs): BestPractice[] {
  const { riskIndicators: risk } = inputs;
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
  if (inputs.commitCount < 3) {
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
      status: inputs.pullCount > 0 ? 'pass' : 'unknown',
      detail:
        inputs.pullCount > 0
          ? 'Good sync cadence — pulling regularly between commits.'
          : 'No syncs detected yet.',
    });
  }

  // 3. Use rebase over merge (avoids merge commits that complicate history)
  if (inputs.mergeEventCount === 0 && inputs.rebaseEventCount === 0) {
    practices.push({
      id: 'prefer_rebase',
      label: 'Prefer rebase over merge',
      status: 'unknown',
      detail: 'No merge or rebase operations yet.',
    });
  } else if (inputs.mergeEventCount > inputs.rebaseEventCount) {
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

  // 4. Use --force-with-lease instead of --force. Gated on
  // hasUsedBareForcePush rather than forcePushes/usesForceWithLease alone —
  // those two count safe and unsafe force-pushes together, so checking
  // usesForceWithLease alone would let one safe `--force-with-lease` mask a
  // dangerous bare `--force` in the same session with a fully-passing
  // status.
  if (inputs.forcePushes === 0) {
    practices.push({
      id: 'force_with_lease',
      label: 'Use --force-with-lease',
      status: 'unknown',
      detail: 'No force pushes yet.',
    });
  } else if (inputs.hasUsedBareForcePush && risk.usesForceWithLease) {
    practices.push({
      id: 'force_with_lease',
      label: 'Use --force-with-lease',
      status: 'warn',
      detail:
        'Mixed usage in this window — some force pushes used --force-with-lease, but at least one bare --force (unsafe) push also occurred. Always use --force-with-lease; it refuses to push if someone else has pushed to the branch since your last fetch.',
    });
  } else if (inputs.hasUsedBareForcePush) {
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

  // 5. Keep PRs small (proxy: many commits without pushing)
  if (risk.commitsSinceLastSync > 15) {
    practices.push({
      id: 'small_increments',
      label: 'Push in small increments',
      status: 'fail',
      detail: `${risk.commitsSinceLastSync} local commits without pushing. Large batches create massive diffs that are more likely to conflict and harder to review. Push and open PRs early and often.`,
    });
  } else if (inputs.commitCount >= 3) {
    practices.push({
      id: 'small_increments',
      label: 'Push in small increments',
      status: 'pass',
      detail: 'Good — committing and syncing in small batches.',
    });
  }

  // 6. Avoid editing hot files
  if (risk.hotFiles.length > 0) {
    practices.push({
      id: 'avoid_hot_files',
      label: 'Avoid re-editing conflicted files',
      status: 'warn',
      detail: `Editing files that previously conflicted: ${risk.hotFiles.slice(0, 3).join(', ')}${risk.hotFiles.length > 3 ? ` (+${risk.hotFiles.length - 3} more)` : ''}. These are "hot" files with active upstream changes — edits here are likely to conflict again. Consider coordinating or waiting for upstream to stabilize.`,
    });
  }

  // 7. Build/test before pushing
  if (inputs.buildBeforePush === null && inputs.lastPushTimestamp === null) {
    practices.push({
      id: 'verify_before_push',
      label: 'Build/test before pushing',
      status: 'unknown',
      detail: 'No pushes yet.',
    });
  } else if (inputs.buildBeforePush === true) {
    practices.push({
      id: 'verify_before_push',
      label: 'Build/test before pushing',
      status: 'pass',
      detail:
        'Good — ran build or tests before pushing. This catches errors before they reach CI and avoids wasted review cycles.',
    });
  } else if (inputs.buildBeforePush === false) {
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

/** Adapted from `GitEfficiencyTracker.computePreventionScore`, unchanged. */
function computePreventionScore(practices: readonly BestPractice[]): number | null {
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

/** Adapted from `GitEfficiencyTracker.generateSuggestions`. Coaching copy is
 *  preserved verbatim. */
function generateSuggestions(inputs: CoachingInputs): GitSuggestion[] {
  const suggestions: GitSuggestion[] = [];
  const risk = inputs.riskIndicators;

  // --- Proactive prevention suggestions (fire BEFORE conflicts happen) ---

  if (risk.forceAfterReject > 0) {
    suggestions.push({
      severity: 'critical',
      category: 'force_after_reject',
      message:
        'Push was rejected and then force-pushed — this overwrites upstream changes. The correct response to a rejected push is: `git fetch`, then `git rebase origin/<branch>`, resolve any conflicts, then push normally. Force push is a last resort, not a first response.',
      evidence: `${risk.forceAfterReject} force push(es) within 5 min of a rejection`,
    });
  }

  // --- Reactive suggestions (fire after problems occur) ---

  if (inputs.mergeConflicts + inputs.rebaseConflicts >= 3) {
    suggestions.push({
      severity: 'critical',
      category: 'merge_conflicts',
      message:
        "Frequent merge conflicts in this window. Root causes for AI assistants: (1) not pulling at session start, (2) working on stale branches too long, (3) editing files with active upstream changes. Fix: sync every 3–5 commits, use worktrees for parallel tasks, and check `git log origin/main..HEAD` to see how far you've drifted.",
      evidence: `${inputs.mergeConflicts + inputs.rebaseConflicts} conflicts in this window`,
    });
  } else if (inputs.mergeConflicts + inputs.rebaseConflicts >= 1) {
    suggestions.push({
      severity: 'warning',
      category: 'merge_conflicts',
      message:
        'Merge conflict encountered. For future prevention: `git fetch && git rebase origin/main` before starting work and after every ~5 commits. If this is a busy repo, consider shorter-lived branches and smaller PRs.',
      evidence: `${inputs.mergeConflicts + inputs.rebaseConflicts} conflict(s) in this window`,
    });
  }

  if (inputs.abortedOperations >= 2) {
    suggestions.push({
      severity: 'warning',
      category: 'aborted_operations',
      message:
        'Multiple aborted merge/rebase operations suggest the branch has diverged too far. Strategy: (1) break the rebase into smaller steps with `git rebase --onto`, (2) cherry-pick only your commits onto a fresh branch, or (3) do an interactive rebase squashing first to reduce conflict surface area.',
      evidence: `${inputs.abortedOperations} aborted operations`,
    });
  }

  // Severity is gated on hasUsedBareForcePush/bareForcePushCount — the same
  // shared signal the force_with_lease best-practice check uses — rather
  // than the raw forcePushes count, which sums bare AND lease-protected
  // pushes together. A bare push to the shared default branch is escalated
  // to 'critical' outright, regardless of count.
  if (inputs.hasUsedBareForcePush) {
    suggestions.push({
      severity: inputs.hasForcePushedToDefaultBranch
        ? 'critical'
        : inputs.bareForcePushCount >= 2
          ? 'critical'
          : 'warning',
      category: 'force_push',
      message: inputs.hasForcePushedToDefaultBranch
        ? `Bare --force push used on the shared default branch (${inputs.defaultBranchName ?? 'default branch'}) — this can overwrite history other collaborators are building on. Always use --force-with-lease, and avoid force-pushing the default branch entirely if possible.`
        : 'Bare --force push used. Always use --force-with-lease instead — it refuses to push if someone else has pushed to the branch since your last fetch. If you need to rewrite history, coordinate with collaborators first and ensure your local refs are up to date with `git fetch` before force pushing.',
      evidence: inputs.hasForcePushedToDefaultBranch
        ? `${inputs.bareForcePushCount} bare --force push(es) in this window, including at least one on the default branch`
        : `${inputs.bareForcePushCount} bare --force push(es) in this window`,
    });
  } else if (risk.usesForceWithLease && inputs.forcePushes >= 2) {
    suggestions.push({
      severity: 'info',
      category: 'force_push',
      message:
        'Multiple force pushes in this window, all using --force-with-lease — the safe pattern. Repeated history rewrites can still be worth a second look if they indicate a workflow issue upstream.',
      evidence: `${inputs.forcePushes} lease-protected force pushes in this window`,
    });
  }

  if (inputs.resetHards >= 2) {
    suggestions.push({
      severity: 'warning',
      category: 'reset_hard',
      message:
        'Multiple hard resets. Consider `git stash` to save work before resetting, or `git reset --mixed` to unstage without losing working tree changes.',
      evidence: `${inputs.resetHards} hard resets`,
    });
  }

  if (inputs.staleBranchPulls >= 2) {
    suggestions.push({
      severity: 'warning',
      category: 'stale_branch',
      message:
        "Pulls repeatedly cause conflicts — the branch has significantly diverged. Prevention: (1) rebase onto target branch at the START of each session, (2) use `git fetch` + `git log ..origin/main` to check divergence before pulling, (3) for long-lived branches, rebase daily even if you're not done.",
      evidence: `${inputs.staleBranchPulls} pulls that led directly to conflicts`,
    });
  }

  if (inputs.discardedChanges >= 3) {
    suggestions.push({
      severity: 'info',
      category: 'discarded_changes',
      message:
        "Frequently discarding changes. Use a scratch branch (`git checkout -b scratch/experiment`) instead — you can always delete it later, but you can't recover discarded changes.",
      evidence: `${inputs.discardedChanges} discard operations`,
    });
  }

  if (inputs.totalGitCommands > 10 && inputs.pullCount === 0) {
    suggestions.push({
      severity: 'info',
      category: 'sync_frequency',
      message:
        'No pulls detected in this window despite significant git activity. On shared branches, pull at least every 15 minutes or every 5 commits — whichever comes first.',
      evidence: `${inputs.totalGitCommands} git commands, 0 pulls`,
    });
  }

  if (
    inputs.commitCount > 10 &&
    inputs.pullCount === 0 &&
    inputs.mergeConflicts + inputs.rebaseConflicts === 0
  ) {
    suggestions.push({
      severity: 'warning',
      category: 'divergence_risk',
      message:
        "You've made many commits without syncing. Even though there are no conflicts YET, you're accumulating divergence that makes future conflicts larger and harder to resolve. Sync now while it's easy: `git fetch && git rebase origin/main`.",
      evidence: `${inputs.commitCount} commits, 0 syncs`,
    });
  }

  // --- Field guide: branch divergence from main ---

  if (risk.commitsBehindMain !== null && risk.commitsBehindMain > 20) {
    suggestions.push({
      severity: 'warning',
      category: 'behind_main',
      message: `Branch is ${risk.commitsBehindMain} commits behind main. The longer you wait to rebase, the more painful it gets. Run \`git fetch origin && git rebase origin/main\` before it gets worse. On an active repo, main can move 20+ commits per day.`,
      evidence: `${risk.commitsBehindMain} commits behind origin/main`,
    });
  } else if (risk.commitsBehindMain !== null && risk.commitsBehindMain > 5) {
    suggestions.push({
      severity: 'info',
      category: 'behind_main',
      message: `Branch is ${risk.commitsBehindMain} commits behind main. Consider rebasing soon to stay current.`,
      evidence: `${risk.commitsBehindMain} commits behind origin/main`,
    });
  }

  // --- Field guide: session duration as PR size risk ---

  if (
    risk.sessionDurationMs !== null &&
    risk.sessionDurationMs > 2 * 3600_000 &&
    inputs.commitCount > 15
  ) {
    suggestions.push({
      severity: 'info',
      category: 'session_length',
      message:
        'Long-running activity with many commits. The single biggest predictor of merge pain is how long a branch lives. Consider breaking this into smaller PRs that merge incrementally — a 200-line PR that ships in 30 minutes almost never conflicts.',
      evidence: `Active ${Math.round(risk.sessionDurationMs / 3600_000)}h with ${inputs.commitCount} commits`,
    });
  }

  // --- Field guide: blind conflict resolution warning ---

  if (risk.quickConflictResolutions > 0) {
    suggestions.push({
      severity: 'warning',
      category: 'quick_resolution',
      message:
        'Conflicts were resolved very quickly (under 30 seconds). AI-generated conflict resolutions should be reviewed line by line — they handle syntactic conflicts well but can miss semantic conflicts where two PRs modified the same logic with different intent. Run the test suite after every resolution.',
      evidence: `${risk.quickConflictResolutions} conflict(s) resolved in under 30s`,
    });
  }

  // --- Field guide: suggest SessionStart hook ---

  if (risk.syncedBeforeEditing === false && inputs.totalGitCommands > 3) {
    suggestions.push({
      severity: 'info',
      category: 'session_hook',
      message:
        'Tip: Add a SessionStart hook to ~/.claude/settings.json that auto-runs `git fetch --all --prune` at the start of every session. Claude Code does not auto-fetch — it operates on whatever git state is on disk. The hook ensures you always start fresh without having to remember.',
      evidence: 'No sync before first edit in this window',
    });
  }

  return suggestions;
}

/** Adapted from `GitEfficiencyTracker.computeScore`, unchanged. */
function computeScore(inputs: CoachingInputs): number | null {
  if (inputs.totalGitCommands < 3) return null;

  let score = 100;

  const conflictPenalty = Math.min((inputs.mergeConflicts + inputs.rebaseConflicts) * 10, 40);
  score -= conflictPenalty;

  score -= Math.min(inputs.abortedOperations * 15, 30);
  score -= Math.min(inputs.forcePushes * 10, 20);
  score -= Math.min(inputs.resetHards * 5, 15);
  score -= Math.min(inputs.discardedChanges * 3, 15);

  if (inputs.conflictResolutionRate !== null && inputs.conflictResolutionRate >= 0.8) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/** Runs the full coaching pipeline (best practices, suggestions, scores)
 *  against one pre-aggregated stats object — used identically by a single
 *  workspace's own metrics and by a rollup's summed totals. */
function runCoaching(inputs: CoachingInputs): {
  readonly suggestions: readonly GitSuggestion[];
  readonly bestPractices: readonly BestPractice[];
  readonly efficiencyScore: number | null;
  readonly preventionScore: number | null;
} {
  const bestPractices = evaluateBestPractices(inputs);
  const suggestions = generateSuggestions(inputs);
  return {
    suggestions: [...suggestions].sort(
      (a, b) => SUGGESTION_SEVERITY_RANK[a.severity] - SUGGESTION_SEVERITY_RANK[b.severity],
    ),
    bestPractices: [...bestPractices].sort(
      (a, b) => BEST_PRACTICE_STATUS_RANK[a.status] - BEST_PRACTICE_STATUS_RANK[b.status],
    ),
    efficiencyScore: computeScore(inputs),
    preventionScore: computePreventionScore(bestPractices),
  };
}

// ---------------------------------------------------------------------------
// Velocity / conflict-strategy / PR-metric / stale-pull helpers
// ---------------------------------------------------------------------------

/** Adapted from `GitEfficiencyTracker.computeVelocityMetrics`, minus
 *  `worktreeCount` — callers set that themselves (it means something
 *  different at rollup scope than "worktree add/remove commands issued"). */
function computeVelocityCore(
  commitTimestamps: readonly number[],
  buildBeforePush: boolean | null,
  // The open-ended "since last commit" gap below is capped at this instead
  // of always reaching for real wall-clock time — for a bounded PAST window
  // (e.g. "yesterday"), the caller passes that window's own `until` so the
  // gap doesn't extend into activity outside the range being reported.
  // Defaults to `Date.now()` so a caller reporting a live/current window
  // (where `until` already IS roughly now) gets the exact prior behavior.
  nowMs: number = Date.now(),
): Omit<VelocityMetrics, 'worktreeCount'> {
  const sorted = [...commitTimestamps].sort((a, b) => a - b);

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

  // The gaps above only ever measure BETWEEN two existing commits — a quiet
  // stretch that started with your most recent commit and is still ongoing
  // right now (e.g. a weekend with no commits at all) has no "next" commit
  // to pair it with, so it silently never became a candidate. Folding in
  // "now minus the last commit" as one more candidate is what makes a
  // multi-day break since your last commit actually show up here.
  if (sorted.length >= 1) {
    const sinceLastCommitMs = nowMs - sorted[sorted.length - 1];
    longestGapMs =
      longestGapMs === null ? sinceLastCommitMs : Math.max(longestGapMs, sinceLastCommitMs);
  }

  return {
    avgTimeBetweenCommitsMs,
    commitBurstCount,
    longestGapMs,
    buildBeforePush,
    // Same value as buildBeforePush, not a separate signal — see the
    // matching comment in GitEfficiencyTracker.computeVelocityMetrics.
    testBeforePush: buildBeforePush,
  };
}

/** Adapted from `GitEfficiencyTracker.computeConflictStrategy`, unchanged. */
function computeConflictStrategy(
  conflictRecords: readonly MergeConflictRecord[],
  oursCount: number,
  theirsCount: number,
  cherryPickCount: number,
): ConflictResolutionStrategy {
  const manualMergeCount = Math.max(
    0,
    conflictRecords.filter((c) => c.resolution === 'resolved').length -
      oursCount -
      theirsCount -
      cherryPickCount,
  );

  return {
    oursCount,
    theirsCount,
    manualMergeCount,
    cherryPickCount,
    totalResolutions: oursCount + theirsCount + cherryPickCount + manualMergeCount,
  };
}

/** Adapted from `GitEfficiencyTracker.computePrMetrics`, unchanged. */
function computePrMetrics(
  prEvents: readonly PrEvent[],
  commitTimestamps: readonly number[],
): PullRequestMetrics {
  const created = prEvents.filter((e) => e.action === 'create').length;
  const merged = prEvents.filter((e) => e.action === 'merge').length;
  const checksViewed = prEvents.filter((e) => e.action === 'checks').length;
  const prsUpdated = prEvents.filter((e) => e.action === 'edit' || e.action === 'ready').length;

  const sortedCommitTimestamps = [...commitTimestamps].sort((a, b) => a - b);
  const timesToCreate: number[] = [];
  for (const prEvent of prEvents) {
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
    prActivity: prEvents.slice(-20),
    avgTimeToCreateMs,
  };
}

/** Adapted from `GitEfficiencyTracker.countStaleBranchPulls`, unchanged. */
function countStaleBranchPulls(events: readonly GitEvent[]): number {
  let staleCount = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== 'merge_conflict' && event.type !== 'rebase_conflict') continue;
    if (GIT_PULL_RE.test(event.command ?? '')) {
      staleCount++;
    } else if (i > 0 && events[i - 1].type === 'pull') {
      staleCount++;
    }
  }
  return staleCount;
}

// ---------------------------------------------------------------------------
// Step 0: reconcileHydratedCommits — merges each hook-observed commit with
// its `git log`-hydrated counterpart (same commit, two sources) into one
// record, before anything downstream counts commits.
// ---------------------------------------------------------------------------

// A hook record carries the PreToolUse time, so the commit's own `%ct` lands
// after it by however long the tool call ran, and anything chained before
// the commit (`npm test && git commit`) widens that gap to tens of seconds.
// The window is symmetric because replayed timeline entries and hydrated
// commits have independent clocks. One-to-one nearest matching keeps two
// distinct rapid commits from collapsing into one despite the wide window.
export const COMMIT_RECONCILE_WINDOW_MS = 60_000;

type GitCommitRecord = Extract<GitActivityRecord, { kind: 'git' }>;

const AMEND_RE = /\s--amend\b/;

/** A commit that added history: it succeeded and was not an amend, which
 *  rewrites a commit instead of adding one. Hydrated commits always qualify. */
export function isCountedCommit(event: GitEvent): boolean {
  return event.type === 'commit' && event.success && !AMEND_RE.test(event.command ?? '');
}

function isHookCommit(r: GitCommitRecord): boolean {
  return isCountedCommit(r.gitEvent) && !r.gitEvent.hash;
}

function isHydratedCommit(r: GitCommitRecord): boolean {
  return r.gitEvent.type === 'commit' && !!r.gitEvent.hash;
}

function nearestUnmatched(
  hook: GitCommitRecord,
  candidates: readonly GitCommitRecord[],
  matched: ReadonlySet<GitCommitRecord>,
): GitCommitRecord | null {
  let best: GitCommitRecord | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (matched.has(candidate)) continue;
    const distance = Math.abs(hook.timestamp - candidate.timestamp);
    if (distance > COMMIT_RECONCILE_WINDOW_MS || distance >= bestDistance) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

/**
 * Reconciles hook-observed commits against commits hydrated from `git log`
 * for the same underlying repo, so a commit both sources saw is counted
 * once, not twice. Called from `GitWorkspaceReporter.report()` on the
 * combined records array, before `buildGitWorkspaceReport`.
 *
 * Matching is per repo (`identities.get(workspaceKey)?.repoKey`, so a commit
 * made in one worktree pairs with its `git log` copy seen from another) and
 * one-to-one: each hook commit, ascending by timestamp, consumes the nearest
 * unmatched hydrated commit within `COMMIT_RECONCILE_WINDOW_MS`. The hook
 * record is kept, since it knows the real worktree and session, enriched
 * with the hydrated `hash`/`subject`/`url`; the hydrated record is dropped.
 * An unpaired hook commit survives only in a repo with no hydrated commits.
 * A hook commit with no resolvable workspace pairs by time against any
 * repo's leftover hydrated commit, and the hydrated copy is kept. Failed
 * and amend commits, and every non-commit record, pass through.
 */
export function reconcileHydratedCommits(
  records: readonly GitActivityRecord[],
  identities: ReadonlyMap<string, WorktreeIdentity>,
): GitActivityRecord[] {
  const repoKeyOf = (r: GitActivityRecord): string =>
    identities.get(r.workspaceKey)?.repoKey ?? r.workspaceKey;

  const hooksByRepo = new Map<string, GitCommitRecord[]>();
  const hydratedByRepo = new Map<string, GitCommitRecord[]>();
  const passthrough: GitActivityRecord[] = [];

  const addTo = (map: Map<string, GitCommitRecord[]>, r: GitCommitRecord): void => {
    const key = repoKeyOf(r);
    const bucket = map.get(key);
    if (bucket) bucket.push(r);
    else map.set(key, [r]);
  };

  const unattributedHooks: GitCommitRecord[] = [];
  for (const record of records) {
    if (record.kind === 'git' && isHookCommit(record)) {
      if (identities.has(record.workspaceKey)) addTo(hooksByRepo, record);
      else unattributedHooks.push(record);
    } else if (record.kind === 'git' && isHydratedCommit(record)) addTo(hydratedByRepo, record);
    else passthrough.push(record);
  }

  const result: GitActivityRecord[] = [...passthrough];
  const leftoverHydrated: GitCommitRecord[] = [];
  const repoKeys = new Set([...hooksByRepo.keys(), ...hydratedByRepo.keys()]);

  for (const repoKey of repoKeys) {
    const hooks = [...(hooksByRepo.get(repoKey) ?? [])].sort((a, b) => a.timestamp - b.timestamp);
    const hydrated = hydratedByRepo.get(repoKey) ?? [];
    const matched = new Set<GitCommitRecord>();

    for (const hook of hooks) {
      const best = nearestUnmatched(hook, hydrated, matched);
      if (best) {
        matched.add(best);
        result.push({
          ...hook,
          gitEvent: {
            ...hook.gitEvent,
            hash: best.gitEvent.hash,
            subject: best.gitEvent.subject,
            url: best.gitEvent.url,
          },
        });
      } else if (hydrated.length === 0) {
        // git log is authoritative wherever it reaches: an unpaired hook
        // commit there was rewritten away (rebase, squash) or was never a
        // commit (text that mentioned one), and its successor is already
        // in `hydrated`. Hook commits stand alone only where git log can't see.
        result.push(hook);
      }
    }

    for (const h of hydrated) {
      if (!matched.has(h)) leftoverHydrated.push(h);
    }
  }

  // A hook commit whose worktree has since been deleted resolves to no repo,
  // while git log still finds the commit on its branch. Pair it by time
  // against any repo's leftover and keep the hydrated copy, which knows the
  // repo. A commit made in a clone git can no longer see stays as it is.
  const taken = new Set<GitCommitRecord>();
  for (const hook of unattributedHooks.sort((a, b) => a.timestamp - b.timestamp)) {
    const best = nearestUnmatched(hook, leftoverHydrated, taken);
    if (best) taken.add(best);
    else result.push(hook);
  }
  result.push(...leftoverHydrated);

  return result;
}

// ---------------------------------------------------------------------------
// Step 1: computeWorkspaceMetrics — the per-workspace sequential reducer,
// adapted from GitEfficiencyTracker.recordToolCall/processEvent/getMetrics
// to run once, forward, over one workspace's own sorted records.
// ---------------------------------------------------------------------------

interface PendingConflict {
  timestamp: number;
  command: string;
  files: string[];
  usedOurs: boolean;
  usedTheirs: boolean;
  usedCherryPick: boolean;
}

function computeBuildBeforePush(
  lastBuildOrTestTimestamp: number | null,
  commitTimestamps: readonly number[],
): boolean | null {
  const lastCommitTs =
    commitTimestamps.length > 0 ? commitTimestamps[commitTimestamps.length - 1] : null;
  return (
    lastBuildOrTestTimestamp !== null &&
    (lastCommitTs === null || lastBuildOrTestTimestamp > lastCommitTs)
  );
}

export function computeWorkspaceMetrics(
  records: readonly GitActivityRecord[],
  // Accepted (and required) so every call site is explicit about which
  // workspace this is for, and so the signature matches `rollupWorkspaceMetrics`'s
  // `{ identity, metrics }` pairing — but the computation itself has nothing
  // of its own to derive from it. The default-branch comparison below reads
  // `liveState.branch`/`liveState.defaultBranch` (both sampled together),
  // not `identity.branch`, since `identity.branch` has its own independent
  // (TTL-cached) refresh cadence that isn't guaranteed to line up with a
  // specific push's live divergence sample.
  _identity: WorktreeIdentity,
  liveState: WorktreeLiveState | null,
  // Forwarded to computeVelocityCore's longestGapMs cap — see its own doc
  // comment. Not used for anything else here (riskIndicators' own
  // Date.now()-based fields, e.g. timeSinceLastSyncMs, stay tied to real
  // wall-clock time regardless of window — those describe present-moment
  // staleness, not a fact about the reported window's contents).
  nowMs: number = Date.now(),
): WorkspaceMetrics {
  const events: GitEvent[] = [];
  const conflictRecords: MergeConflictRecord[] = [];
  const pendingConflicts: PendingConflict[] = [];
  let lastSyncTimestamp: number | null = null;
  let firstEditTimestamp: number | null = null;
  let firstSyncTimestamp: number | null = null;
  let commitsSinceLastSync = 0;
  const syncIntervalCommitCounts: number[] = [];
  let pushRejections = 0;
  let forceAfterReject = 0;
  let lastPushRejectedTimestamp: number | null = null;
  const conflictedFiles = new Set<string>();
  const editedFiles = new Set<string>();
  let hasUsedWorktree = false;
  let hasUsedForceWithLease = false;
  let hasUsedBareForcePush = false;
  let bareForcePushCount = 0;
  let hasForcePushedToDefaultBranch = false;
  let sessionStartTimestamp: number | null = null;
  const commitTimestamps: number[] = [];
  let worktreeCommands = 0;
  let oursCount = 0;
  let theirsCount = 0;
  let cherryPickCount = 0;
  let lastBuildOrTestTimestamp: number | null = null;
  let lastPushTimestamp: number | null = null;
  let buildBeforePush: boolean | null = null;
  let quickConflictResolutions = 0;
  const prEvents: PrEvent[] = [];
  let lastActivityMs: number | null = null;
  const sessionIds = new Set<string>();

  for (const record of records) {
    if (sessionStartTimestamp === null) sessionStartTimestamp = record.timestamp;
    if (lastActivityMs === null || record.timestamp > lastActivityMs) {
      lastActivityMs = record.timestamp;
    }
    // A git-log-hydrated commit didn't come from any Claude Code session —
    // counting its synthetic sessionId here would make a workspace with zero
    // real sessions this window still report one.
    if (record.sessionId !== GIT_LOG_SESSION_ID) sessionIds.add(record.sessionId);

    if (record.kind === 'edit') {
      editedFiles.add(record.filePath);
      if (firstEditTimestamp === null) firstEditTimestamp = record.timestamp;
      continue;
    }

    if (record.kind === 'verify') {
      lastBuildOrTestTimestamp = record.timestamp;
      continue;
    }

    if (record.kind === 'pr') {
      prEvents.push(record.prEvent);
      continue;
    }

    // record.kind === 'git'
    const event = record.gitEvent;
    events.push(event);

    const command = event.command ?? '';

    // Attribute ours/theirs/cherry-pick resolution strategy to the oldest
    // still-open conflict, not to every matching command.
    const oldestPending = pendingConflicts[0];
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
        const files = event.files ? [...event.files] : [];
        for (const f of files) conflictedFiles.add(f);
        pendingConflicts.push({
          timestamp: event.timestamp,
          command,
          files,
          usedOurs: false,
          usedTheirs: false,
          usedCherryPick: false,
        });
        break;
      }

      case 'merge_abort':
      case 'rebase_abort':
      case 'cherry_pick_abort': {
        const pending = pendingConflicts.shift();
        if (pending) {
          conflictRecords.push({
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
        // git commit --amend fixes a prior commit, not a merge conflict —
        // drop the oldest pending conflict without recording a resolution.
        if (command.includes('--amend')) {
          pendingConflicts.shift();
        } else {
          const pending = pendingConflicts.shift();
          if (pending) {
            const resolutionMs = event.timestamp - pending.timestamp;
            conflictRecords.push({
              timestamp: pending.timestamp,
              resolution: 'resolved',
              resolutionTimeMs: resolutionMs,
              command: pending.command,
              files: pending.files,
            });
            if (pending.usedOurs) oursCount++;
            if (pending.usedTheirs) theirsCount++;
            if (pending.usedCherryPick) cherryPickCount++;
            if (resolutionMs < 30_000 && pending.files.length > 1) {
              quickConflictResolutions++;
            }
          }
        }
        if (isCountedCommit(event)) {
          commitTimestamps.push(event.timestamp);
          commitsSinceLastSync++;
        }
        break;
      }

      case 'pull':
      case 'fetch':
      case 'rebase':
        if (firstSyncTimestamp === null) firstSyncTimestamp = event.timestamp;
        lastSyncTimestamp = event.timestamp;
        if (commitsSinceLastSync > 0) syncIntervalCommitCounts.push(commitsSinceLastSync);
        commitsSinceLastSync = 0;
        break;

      case 'push':
        lastPushTimestamp = event.timestamp;
        buildBeforePush = computeBuildBeforePush(lastBuildOrTestTimestamp, commitTimestamps);
        break;

      case 'push_rejected':
        pushRejections++;
        lastPushRejectedTimestamp = event.timestamp;
        break;

      case 'force_push':
        hasUsedBareForcePush = true;
        bareForcePushCount++;
        // BUG FIX: compare against THIS workspace's own live branch/default
        // branch, not a process-global singleton (the old tracker compared
        // against a single repoContext shared across every workspace it
        // ever saw, so one workspace's push could wrongly be judged against
        // another's branch). Undetermined (no live sample yet) is false,
        // never a guess.
        if (
          liveState?.branch != null &&
          liveState?.defaultBranch != null &&
          liveState.branch === liveState.defaultBranch
        ) {
          hasForcePushedToDefaultBranch = true;
        }
        if (
          lastPushRejectedTimestamp !== null &&
          event.timestamp - lastPushRejectedTimestamp < 300_000
        ) {
          forceAfterReject++;
        }
        lastPushTimestamp = event.timestamp;
        buildBeforePush = computeBuildBeforePush(lastBuildOrTestTimestamp, commitTimestamps);
        break;

      case 'force_push_lease':
        hasUsedForceWithLease = true;
        lastPushTimestamp = event.timestamp;
        buildBeforePush = computeBuildBeforePush(lastBuildOrTestTimestamp, commitTimestamps);
        break;

      case 'worktree':
        if (GIT_WORKTREE_ADD_REMOVE_RE.test(command)) {
          worktreeCommands++;
          hasUsedWorktree = true;
        }
        break;

      default:
        break;
    }
  }

  const totalGitCommands = events.length;
  const mergeConflicts = events.filter((e) => e.type === 'merge_conflict').length;
  const rebaseConflicts = events.filter((e) => e.type === 'rebase_conflict').length;
  const abortedOperations = events.filter(
    (e) => e.type === 'merge_abort' || e.type === 'rebase_abort' || e.type === 'cherry_pick_abort',
  ).length;
  const forcePushes = events.filter(
    (e) => e.type === 'force_push' || e.type === 'force_push_lease',
  ).length;
  const resetHards = events.filter((e) => e.type === 'reset_hard').length;
  const discardedChanges = events.filter((e) => e.type === 'discard_changes').length;
  const pullCount = events.filter((e) => e.type === 'pull').length;
  const pushCount = events.filter(
    (e) => e.type === 'push' || e.type === 'force_push' || e.type === 'force_push_lease',
  ).length;
  const commitCount = events.filter(isCountedCommit).length;
  const branchOperations = events.filter((e) => e.type === 'branch').length;
  const mergeEventCount = events.filter((e) => e.type === 'merge').length;
  const rebaseEventCount = events.filter((e) => e.type === 'rebase').length;

  const allConflictRecords: MergeConflictRecord[] = [
    ...conflictRecords,
    ...pendingConflicts.map((p) => ({
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

  const staleBranchPulls = countStaleBranchPulls(events);

  const now = Date.now();
  const syncedBeforeEditing =
    firstEditTimestamp !== null
      ? firstSyncTimestamp !== null && firstSyncTimestamp < firstEditTimestamp
      : null;
  const hotFiles = [...conflictedFiles].filter((f) => editedFiles.has(f));
  const avgCommitsBetweenSyncs =
    syncIntervalCommitCounts.length > 0
      ? syncIntervalCommitCounts.reduce((a, b) => a + b, 0) / syncIntervalCommitCounts.length
      : null;
  const riskIndicators: RiskIndicators = {
    syncedBeforeEditing,
    timeSinceLastSyncMs: lastSyncTimestamp !== null ? now - lastSyncTimestamp : null,
    commitsSinceLastSync,
    pushRejections,
    forceAfterReject,
    hotFiles,
    usesWorktrees: hasUsedWorktree,
    usesForceWithLease: hasUsedForceWithLease,
    avgCommitsBetweenSyncs,
    commitsAheadOfMain: liveState?.ahead ?? null,
    commitsBehindMain: liveState?.behind ?? null,
    sessionDurationMs: sessionStartTimestamp !== null ? now - sessionStartTimestamp : null,
    quickConflictResolutions,
  };

  const coachingInputs: CoachingInputs = {
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
    mergeEventCount,
    rebaseEventCount,
    hasUsedBareForcePush,
    bareForcePushCount,
    hasForcePushedToDefaultBranch,
    defaultBranchName: liveState?.defaultBranch ?? null,
    buildBeforePush,
    lastPushTimestamp,
    conflictResolutionRate,
    riskIndicators,
  };
  const { suggestions, bestPractices, efficiencyScore, preventionScore } =
    runCoaching(coachingInputs);

  const velocityMetrics: VelocityMetrics = {
    ...computeVelocityCore(commitTimestamps, buildBeforePush, nowMs),
    worktreeCount: worktreeCommands,
  };
  const conflictResolutionStrategy = computeConflictStrategy(
    conflictRecords,
    oursCount,
    theirsCount,
    cherryPickCount,
  );
  const prMetrics = computePrMetrics(prEvents, commitTimestamps);

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
    gitCommandTimeline: [...events].sort((a, b) => a.timestamp - b.timestamp).slice(-50),
    conflictHistory: [...allConflictRecords].sort((a, b) => a.timestamp - b.timestamp),
    suggestions,
    bestPractices,
    preventionScore,
    efficiencyScore,
    riskIndicators,
    velocityMetrics,
    conflictResolutionStrategy,
    prMetrics,
    liveState,
    commitTimestamps: [...commitTimestamps],
    lastPushTimestamp,
    editedFiles: [...editedFiles],
    hasUsedBareForcePush,
    bareForcePushCount,
    hasForcePushedToDefaultBranch,
    mergeEventCount,
    rebaseEventCount,
    lastActivityMs,
    sessionIds: [...sessionIds],
  };
}

// ---------------------------------------------------------------------------
// Step 2: rollupWorkspaceMetrics — combines ALREADY-COMPUTED per-workspace
// metrics. Never touches raw records, never re-runs the sequential reducer.
// ---------------------------------------------------------------------------

export function rollupWorkspaceMetrics(
  nodes: readonly { readonly identity: WorktreeIdentity; readonly metrics: WorkspaceMetrics }[],
  // See computeWorkspaceMetrics's matching parameter.
  nowMs: number = Date.now(),
): WorkspaceMetrics {
  const sum = (get: (m: WorkspaceMetrics) => number): number =>
    nodes.reduce((acc, n) => acc + get(n.metrics), 0);
  const any = (get: (m: WorkspaceMetrics) => boolean): boolean => nodes.some((n) => get(n.metrics));

  const totalGitCommands = sum((m) => m.totalGitCommands);
  const mergeConflicts = sum((m) => m.mergeConflicts);
  const rebaseConflicts = sum((m) => m.rebaseConflicts);
  const abortedOperations = sum((m) => m.abortedOperations);
  const forcePushes = sum((m) => m.forcePushes);
  const resetHards = sum((m) => m.resetHards);
  const discardedChanges = sum((m) => m.discardedChanges);
  const pullCount = sum((m) => m.pullCount);
  const pushCount = sum((m) => m.pushCount);
  const commitCount = sum((m) => m.commitCount);
  const branchOperations = sum((m) => m.branchOperations);
  const staleBranchPulls = sum((m) => m.staleBranchPulls);
  const mergeEventCount = sum((m) => m.mergeEventCount);
  const rebaseEventCount = sum((m) => m.rebaseEventCount);
  const bareForcePushCount = sum((m) => m.bareForcePushCount);
  const hasUsedBareForcePush = any((m) => m.hasUsedBareForcePush);
  const hasForcePushedToDefaultBranch = any((m) => m.hasForcePushedToDefaultBranch);

  const oursCount = sum((m) => m.conflictResolutionStrategy.oursCount);
  const theirsCount = sum((m) => m.conflictResolutionStrategy.theirsCount);
  const manualMergeCount = sum((m) => m.conflictResolutionStrategy.manualMergeCount);
  const cherryPickCount = sum((m) => m.conflictResolutionStrategy.cherryPickCount);
  const conflictResolutionStrategy: ConflictResolutionStrategy = {
    oursCount,
    theirsCount,
    manualMergeCount,
    cherryPickCount,
    totalResolutions: oursCount + theirsCount + manualMergeCount + cherryPickCount,
  };

  const prActivity = nodes
    .flatMap((n) => n.metrics.prMetrics.prActivity)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-20);
  const prMetrics: PullRequestMetrics = {
    created: sum((m) => m.prMetrics.created),
    merged: sum((m) => m.prMetrics.merged),
    checksViewed: sum((m) => m.prMetrics.checksViewed),
    prsUpdated: sum((m) => m.prMetrics.prsUpdated),
    prActivity,
    // Each workspace's own avgTimeToCreateMs is anchored to that workspace's
    // own commit/PR pairing — averaging the averages (or re-deriving it
    // without each workspace's raw commit timestamps) wouldn't be honest, so
    // this is left null at rollup, like the other per-workspace timing
    // concepts nulled below.
    avgTimeToCreateMs: null,
  };

  const allConflictRecords = nodes.flatMap((n) => n.metrics.conflictHistory);
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

  const gitCommandTimeline = nodes
    .flatMap((n) => n.metrics.gitCommandTimeline)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-50);
  const conflictHistory = [...allConflictRecords].sort((a, b) => a.timestamp - b.timestamp);

  const riskIndicators: RiskIndicators = {
    // Inherently single-workspace concepts — null/empty rather than summed
    // or averaged, since blending them across workspaces would misrepresent
    // a real per-workspace state as a rollup fact.
    syncedBeforeEditing: null,
    timeSinceLastSyncMs: null,
    commitsSinceLastSync: 0,
    hotFiles: [],
    avgCommitsBetweenSyncs: null,
    commitsAheadOfMain: null,
    commitsBehindMain: null,
    sessionDurationMs: null,
    // Genuinely summable/OR-able across workspaces.
    pushRejections: sum((m) => m.riskIndicators.pushRejections),
    forceAfterReject: sum((m) => m.riskIndicators.forceAfterReject),
    usesWorktrees: any((m) => m.riskIndicators.usesWorktrees),
    usesForceWithLease: any((m) => m.riskIndicators.usesForceWithLease),
    quickConflictResolutions: sum((m) => m.riskIndicators.quickConflictResolutions),
  };

  const allCommitTimestamps = nodes
    .flatMap((n) => n.metrics.commitTimestamps)
    .sort((a, b) => a - b);

  let mostRecentPush: { readonly ts: number; readonly buildBeforePush: boolean | null } | null =
    null;
  for (const n of nodes) {
    const ts = n.metrics.lastPushTimestamp;
    if (ts !== null && (mostRecentPush === null || ts > mostRecentPush.ts)) {
      mostRecentPush = { ts, buildBeforePush: n.metrics.velocityMetrics.buildBeforePush };
    }
  }
  const velocityMetrics: VelocityMetrics = {
    ...computeVelocityCore(allCommitTimestamps, mostRecentPush?.buildBeforePush ?? null, nowMs),
    worktreeCount: nodes.length,
  };

  const coachingInputs: CoachingInputs = {
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
    mergeEventCount,
    rebaseEventCount,
    hasUsedBareForcePush,
    bareForcePushCount,
    hasForcePushedToDefaultBranch,
    defaultBranchName: null,
    buildBeforePush: velocityMetrics.buildBeforePush,
    lastPushTimestamp: mostRecentPush?.ts ?? null,
    conflictResolutionRate,
    riskIndicators,
  };
  const { suggestions, bestPractices, efficiencyScore, preventionScore } =
    runCoaching(coachingInputs);

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
    gitCommandTimeline,
    conflictHistory,
    suggestions,
    bestPractices,
    preventionScore,
    efficiencyScore,
    riskIndicators,
    velocityMetrics,
    conflictResolutionStrategy,
    prMetrics,
    // Only meaningful for one specific workspace. See buildGitWorkspaceReport's
    // `worstBehind` for the rollup-scope equivalent, named to a workspace.
    liveState: null,
    commitTimestamps: allCommitTimestamps,
    lastPushTimestamp: mostRecentPush?.ts ?? null,
    editedFiles: [...new Set(nodes.flatMap((n) => n.metrics.editedFiles))],
    hasUsedBareForcePush,
    bareForcePushCount,
    hasForcePushedToDefaultBranch,
    mergeEventCount,
    rebaseEventCount,
    lastActivityMs: nodes.reduce<number | null>((max, n) => {
      const ts = n.metrics.lastActivityMs;
      if (ts === null) return max;
      return max === null || ts > max ? ts : max;
    }, null),
    sessionIds: [...new Set(nodes.flatMap((n) => n.metrics.sessionIds))],
  };
}

// ---------------------------------------------------------------------------
// Step 3: buildGitWorkspaceReport — public entry point
// ---------------------------------------------------------------------------

function resolveIdentityForGroup(
  key: string,
  identities: ReadonlyMap<string, WorktreeIdentity>,
): WorktreeIdentity | null {
  const known = identities.get(key);
  if (known) return known;
  if (key === UNATTRIBUTED_WORKSPACE_KEY) {
    return {
      repoKey: key,
      worktreeKey: key,
      repoName: null,
      worktreeRoot: null,
      worktreeLabel: key,
      branch: null,
    };
  }
  return null;
}

function computeWorstBehind(rows: readonly WorkspaceRow[]): GitWorkspaceReport['worstBehind'] {
  let best: { readonly identity: WorktreeIdentity; readonly behind: number } | null = null;
  for (const row of rows) {
    const behind = row.metrics.liveState?.behind;
    if (behind == null) continue;
    if (best === null || behind > best.behind) {
      best = { identity: row.identity, behind };
    }
  }
  return best;
}

/**
 * New at rollup: isolation is a property of a repo with multiple active
 * worktrees, not of one worktree alone, so this only runs at repo scope
 * (see buildGitWorkspaceReport). Never claims conflicts "cannot happen" —
 * worktrees isolate working directories, not branches, so two worktrees on
 * a shared branch can still collide at merge time even with zero file
 * overlap here. Placeholder rows (activity with no resolvable working
 * directory) are not worktrees that could have isolated anything, so they
 * neither count toward the active total nor contribute file overlaps.
 */
function buildParallelIsolationCheck(repoRows: readonly WorkspaceRow[]): BestPractice {
  const label = 'Isolate parallel work across worktrees';

  const activeWorktrees = repoRows.filter((r) => !isPlaceholderIdentity(r.identity));

  if (activeWorktrees.length < 2) {
    return {
      id: 'parallel_isolation',
      label,
      status: 'n/a',
      detail: 'Only one worktree active this window — nothing to isolate from.',
    };
  }

  const worktreesByFile = new Map<string, Set<string>>();
  for (const row of activeWorktrees) {
    for (const file of row.metrics.editedFiles) {
      let keys = worktreesByFile.get(file);
      if (!keys) {
        keys = new Set();
        worktreesByFile.set(file, keys);
      }
      keys.add(row.identity.worktreeKey);
    }
  }
  const overlapping = [...worktreesByFile.entries()]
    .filter(([, keys]) => keys.size > 1)
    .map(([file]) => file);

  if (overlapping.length === 0) {
    return {
      id: 'parallel_isolation',
      label,
      status: 'pass',
      detail: `${activeWorktrees.length} worktrees active in parallel this window, no files touched in more than one.`,
    };
  }

  const named = overlapping.slice(0, 3).join(', ');
  const extra = overlapping.length > 3 ? ` (+${overlapping.length - 3} more)` : '';
  return {
    id: 'parallel_isolation',
    label,
    status: 'warn',
    detail: `Files edited in more than one active worktree this window: ${named}${extra}. Worktrees isolate working directories, not branches — a shared-branch conflict at merge time is still possible when the same file is touched in parallel.`,
  };
}

function resolveScopeMetrics(
  scope: ScopeRef,
  rows: readonly WorkspaceRow[],
  identities: ReadonlyMap<string, WorktreeIdentity>,
  liveStates: ReadonlyMap<string, WorktreeLiveState>,
  // See computeWorkspaceMetrics's matching parameter.
  nowMs: number = Date.now(),
): WorkspaceMetrics {
  if (scope.kind === 'worktree') {
    if (scope.id === undefined) return rollupWorkspaceMetrics([], nowMs);
    const existing = rows.find((r) => r.identity.worktreeKey === scope.id);
    if (existing) return existing.metrics;
    const identity = identities.get(scope.id) ?? null;
    if (!identity) return rollupWorkspaceMetrics([], nowMs);
    return computeWorkspaceMetrics([], identity, liveStates.get(scope.id) ?? null, nowMs);
  }

  if (scope.kind === 'repo') {
    const activeWorktrees =
      scope.id === undefined ? [] : rows.filter((r) => r.identity.repoKey === scope.id);
    const rolled = rollupWorkspaceMetrics(activeWorktrees, nowMs);
    // Repo-scope-only coaching check — see buildParallelIsolationCheck's
    // doc comment for why this doesn't run at 'all' scope (no single repo
    // to ask "did these worktrees isolate you" about).
    const isolationCheck = buildParallelIsolationCheck(activeWorktrees);
    return { ...rolled, bestPractices: [isolationCheck, ...rolled.bestPractices] };
  }

  // scope.kind === 'all'. Whether a cross-REPO rollup should get its own
  // isolation-style check is an open question, not a settled rule — a
  // rollup spanning different repos doesn't have one coherent "isolation"
  // story the way one repo's own worktrees do, so this deliberately doesn't
  // attempt one rather than guess at what it would mean.
  return rollupWorkspaceMetrics(rows, nowMs);
}

export function buildGitWorkspaceReport(input: {
  readonly scope: ScopeRef;
  readonly records: readonly GitActivityRecord[];
  readonly identities: ReadonlyMap<string, WorktreeIdentity>;
  readonly liveStates: ReadonlyMap<string, WorktreeLiveState>;
  // Optional cap for computeVelocityCore's open-ended "since last commit"
  // gap (see its doc comment) — the caller passes its report window's own
  // `until` for a bounded window. This is the one place `buildGitWorkspaceReport`
  // is allowed to know about "now" vs. "the window": it doesn't filter
  // `records` by any window itself (that stays the caller's job, as before),
  // it only bounds this one derived, otherwise-unbounded quantity. Defaults
  // to `Date.now()`, matching the exact prior behavior for any caller that
  // doesn't pass one.
  readonly nowMs?: number;
}): GitWorkspaceReport {
  const { scope, records, identities, liveStates, nowMs = Date.now() } = input;

  const byWorkspace = new Map<string, GitActivityRecord[]>();
  for (const record of records) {
    let bucket = byWorkspace.get(record.workspaceKey);
    if (!bucket) {
      bucket = [];
      byWorkspace.set(record.workspaceKey, bucket);
    }
    bucket.push(record);
  }

  const rows: WorkspaceRow[] = [];
  for (const [key, groupRecords] of byWorkspace) {
    const identity = resolveIdentityForGroup(key, identities);
    if (!identity) {
      logger.warn('skipping activity for a workspace key with no known identity', {
        workspaceKey: key,
      });
      continue;
    }
    // Per-workspace records only, sorted ascending — the correctness rule
    // this whole design exists for: never interleave two workspaces'
    // records into one sequential reducer.
    const sorted = [...groupRecords].sort((a, b) => a.timestamp - b.timestamp);
    const metrics = computeWorkspaceMetrics(sorted, identity, liveStates.get(key) ?? null, nowMs);
    rows.push({ identity, metrics });
  }

  return {
    scope,
    metrics: resolveScopeMetrics(scope, rows, identities, liveStates, nowMs),
    rows,
    worstBehind: computeWorstBehind(rows),
  };
}
