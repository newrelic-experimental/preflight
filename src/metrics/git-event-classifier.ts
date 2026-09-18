import { redactSensitive } from '../config.js';
import type { ToolCallRecord } from '../storage/types.js';
import { gitCommandTargetDir } from './local-session-aggregator.js';
import type { PrEvent } from './git-efficiency-tracker.js';

// ---------------------------------------------------------------------------
// Git command classification patterns
// ---------------------------------------------------------------------------

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

const REJECT_INDICATORS = [
  /\[rejected\]/i,
  /non-fast-forward/i,
  /failed to push/i,
  /Updates were rejected/i,
];

// Conflict file path extraction: "CONFLICT (content): Merge conflict in <path>"
const CONFLICT_FILE_RE = /Merge conflict in (.+)/g;

/**
 * Extract conflicted file paths from a merge/rebase conflict's error output.
 * Callers that only ever see the classified `GitEvent` (not the raw
 * `ToolCallRecord.error` text it came from) — e.g. per-workspace report
 * building — still need this to populate hot-file tracking, so it's exposed
 * on the event itself instead of staying private to `GitEfficiencyTracker`.
 */
function extractConflictFiles(errorOutput: string): string[] {
  const files: string[] = [];
  let match: RegExpExecArray | null;
  CONFLICT_FILE_RE.lastIndex = 0;
  while ((match = CONFLICT_FILE_RE.exec(errorOutput)) !== null) {
    files.push(match[1].trim());
  }
  return files;
}

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
  /** Commit hash — set only for a commit hydrated from `git log`. A
   *  hook-observed commit never carries one; that distinction is exactly
   *  what `reconcileHydratedCommits` (git-workspace-report.ts) uses to tell
   *  the two sources apart before merging them into one commit count. */
  readonly hash?: string;
  /**
   * Conflicted file paths, populated only for `merge_conflict`/
   * `rebase_conflict` events. `GitEfficiencyTracker` re-derives this itself
   * from `record.error` and doesn't read this field; it exists for
   * downstream consumers (e.g. per-workspace report building) that only
   * ever see the classified event, not the raw error text.
   */
  readonly files?: readonly string[];
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

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a git command into its event type. The logic is the exact same as
 * the private classifyGitCommand method from GitEfficiencyTracker, extracted
 * into a standalone function with an injected resolveRepo callback instead of
 * accessing this.repoResolver directly.
 *
 * Order matters: several patterns overlap (e.g. a force-push-with-lease
 * command also matches the plain push/force-push patterns), so more
 * specific checks must run before the more general ones they'd otherwise
 * be shadowed by.
 */
export function classifyGitCommand(
  command: string,
  record: ToolCallRecord,
  resolveRepo: (dir: string | null) => string | null,
  targetDir: string | null = gitCommandTargetDir(command, record.cwd as string | undefined),
): GitEvent {
  const base = {
    timestamp: record.timestamp,
    // The command is now surfaced in the dashboard's Detail column, so
    // redact it: a git remote URL can carry an embedded access token.
    command: redactSensitive(command),
    success: record.success,
    durationMs: record.durationMs,
    // Live git events previously carried no repo at all, so the dashboard
    // showed "—" for everything except commits hydrated from git log.
    repo: resolveRepo(targetDir),
  };

  const output = (record.error as string) ?? '';
  const hasConflict = MERGE_CONFLICT_INDICATORS.some((re) => re.test(output));
  const hasRebaseConflict = REBASE_CONFLICT_RE.test(output);
  const hasRejection = REJECT_INDICATORS.some((re) => re.test(output));

  if (hasConflict && !hasRebaseConflict) {
    return { ...base, type: 'merge_conflict', files: extractConflictFiles(output) };
  }
  if (hasRebaseConflict)
    return { ...base, type: 'rebase_conflict', files: extractConflictFiles(output) };
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

// ---------------------------------------------------------------------------
// Shell segments and per-segment classification
// ---------------------------------------------------------------------------

const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*`;

// A segment is a git command only when it starts with one, past env
// assignments or a path prefix. `printf 'git commit'` is text, and an
// unanchored `\bgit\s+` counted it as a commit.
const GIT_SEGMENT_RE = new RegExp(String.raw`^\s*${ENV_PREFIX}(?:\S*\/)?git\s+`);

// Anchored the same way so a segment that only mentions "gh pr create"
// partway through (a piped JSON fixture, a `gh pr comment` body, a commit
// message) never matches.
const GH_PR_COMMAND_RE = new RegExp(String.raw`^\s*${ENV_PREFIX}gh\s+pr\s+(\w+)\b(?:\s+(\d+))?`);

/** `gh pr <verb>` actions this tracks; any other verb returns null. */
const GH_PR_VERB_ACTION: Record<string, PrEvent['action']> = {
  create: 'create',
  merge: 'merge',
  checks: 'checks',
  ready: 'ready',
  edit: 'edit',
  view: 'view',
};

/** Splits a shell command into its top-level segments on `||`, `&&`, `;`,
 *  `|`, and newline. Strip heredoc bodies first so a surviving newline really
 *  does start a new command. */
export function splitShellSegments(command: string): string[] {
  return command.split(/\|\||&&|;|\||\n/);
}

/** The PrEvent a `gh pr <verb>` segment denotes, or null when it is not one. */
export function processGhCommand(command: string, timestamp: number): PrEvent | null {
  const match = GH_PR_COMMAND_RE.exec(command);
  if (!match) return null;
  const action = GH_PR_VERB_ACTION[match[1]];
  if (!action) return null;
  return { timestamp, action, prNumber: match[2] ?? null };
}

export interface ClassifiedGitSegment {
  readonly segment: string;
  readonly event: GitEvent;
}

/**
 * Classifies every git segment of a heredoc-stripped shell command, so a
 * chained `git commit -m x && git push` yields a commit AND a push instead
 * of whichever verb `classifyGitCommand` ranks first.
 *
 * Conflict and rejection text in `record.error` belongs to the segment that
 * ran last, since `&&` stops at the first failure, so only the last git
 * segment sees it. The target directory comes from the whole command, so a
 * `cd dir &&` in an earlier segment still attributes every git segment.
 */
export function classifyGitSegments(
  command: string,
  record: ToolCallRecord,
  resolveRepo: (dir: string | null) => string | null,
): ClassifiedGitSegment[] {
  const segments = splitShellSegments(command).filter((s) => GIT_SEGMENT_RE.test(s));
  const targetDir = gitCommandTargetDir(command, record.cwd as string | undefined);
  return segments.map((segment, i) => {
    const forSegment = i === segments.length - 1 ? record : { ...record, error: undefined };
    return { segment, event: classifyGitCommand(segment, forSegment, resolveRepo, targetDir) };
  });
}
