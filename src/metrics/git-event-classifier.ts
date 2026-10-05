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

// What a failed `git commit` prints: its own refusals, or a hook failure
// (husky prints "husky - pre-commit script failed (code 1)").
const COMMIT_FAILURE_INDICATORS = [
  /nothing to commit/i,
  /nothing added to commit/i,
  /no changes added to commit/i,
  /Committing is not possible/i,
  /Aborting commit/i,
  /\b(?:pre-commit|commit-msg)\b.*\b(?:failed|exited)\b/i,
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
  /** For one segment of a chained command, false only when the command's
   *  failure is attributed to that segment (see `classifyGitSegments`). */
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

const AMEND_RE = /\s--amend\b/;
// A commit message is quoted, so `-m "fix --amend handling"` is no amend.
const QUOTED_TEXT_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

/** Whether a commit segment is `git commit --amend`. */
export function isAmendCommit(command: string): boolean {
  return AMEND_RE.test(command.replace(QUOTED_TEXT_RE, ''));
}

/** A commit that added history: it succeeded and was not an amend, which
 *  rewrites a commit instead of adding one. Hydrated commits always qualify.
 *  The weekly/30-day report and the per-session `GitEfficiencyTracker` both
 *  count commits with this, so the two views agree. */
export function isCountedCommit(event: GitEvent): boolean {
  return event.type === 'commit' && event.success && !isAmendCommit(event.command ?? '');
}

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

interface ShellChain {
  readonly segments: readonly string[];
  /** `operators[i]` joins `segments[i]` to `segments[i + 1]`. */
  readonly operators: readonly string[];
}

const SHELL_OPERATOR_RE = /(\|\||&&|;|\||\n)/;
// A segment of only whitespace and `#` comments runs nothing.
const NO_COMMAND_RE = /^(?:\s|#[^\n]*)*$/;
const COMMENT_START_AFTER_RE = /[\s;&|(]/;
const CONTINUED_BY_NEWLINE = new Set(['&&', '||', '|']);

/**
 * A shell command's segments and the operators between them, read the way
 * the shell reads them: an operator inside quotes or a `#` comment does not
 * split, nor does a newline after a backslash or after `&&`, `||` or `|`.
 * So a commit whose quoted message spans lines, including what heredoc
 * stripping leaves of `-m "$(cat <<'EOF'` ... `)"`, is one segment. A command
 * whose quotes don't balance is split on every operator instead.
 */
function splitShellChain(command: string): ShellChain {
  const source = command.replace(/\\\r?\n/g, '');
  const segments: string[] = [];
  const operators: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') {
      i++;
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || COMMENT_START_AFTER_RE.test(source.charAt(i - 1)))) {
      const eol = source.indexOf('\n', i);
      i = (eol === -1 ? source.length : eol) - 1;
    } else {
      const pair = source.slice(i, i + 2);
      const op = pair === '&&' || pair === '||' ? pair : ';|\n'.includes(c) ? c : null;
      if (op === null) continue;
      const continued =
        op === '\n' &&
        CONTINUED_BY_NEWLINE.has(operators.at(-1) ?? '') &&
        NO_COMMAND_RE.test(source.slice(start, i));
      if (continued) continue;
      segments.push(source.slice(start, i));
      operators.push(op);
      start = i + op.length;
      i = start - 1;
    }
  }
  if (quote !== null) {
    const parts = source.split(SHELL_OPERATOR_RE);
    return {
      segments: parts.filter((_, i) => i % 2 === 0),
      operators: parts.filter((_, i) => i % 2 === 1),
    };
  }
  segments.push(source.slice(start));
  return { segments, operators };
}

// Git verbs whose own output can report a merge/rebase conflict.
const GIT_CONFLICT_CAPABLE_RE =
  /\bgit\s+(?:merge|rebase|pull|cherry-pick|revert|am|apply|stash|checkout|switch)\b/;

/**
 * Index of the git segment whose output `error` is, or -1 when no segment's
 * is. The hook payload carries one error for the whole command, not one per
 * segment. Conflict, rejection, and commit-failure text names the kind of
 * git command that printed it, so it goes to the last segment that can print
 * it: `git pull && git push` hands a conflict to the pull.
 */
function errorSegmentIndex(gitSegments: readonly string[], error: string): number {
  const hasConflict =
    MERGE_CONFLICT_INDICATORS.some((re) => re.test(error)) || REBASE_CONFLICT_RE.test(error);
  const hasRejection = REJECT_INDICATORS.some((re) => re.test(error));
  const hasCommitFailure = COMMIT_FAILURE_INDICATORS.some((re) => re.test(error));
  for (let i = gitSegments.length - 1; i >= 0; i--) {
    const segment = gitSegments[i]!;
    if (hasConflict && GIT_CONFLICT_CAPABLE_RE.test(segment)) return i;
    if (hasRejection && GIT_PUSH_RE.test(segment)) return i;
    if (hasCommitFailure && GIT_COMMIT_RE.test(segment)) return i;
  }
  return -1;
}

/** Index of the last segment that `&&` kept from running after segment
 *  `failed` failed; `failed` itself when the next segment runs anyway. */
function lastSkippedSegment(operators: readonly string[], failed: number): number {
  let last = failed;
  while (operators[last] === '&&') last++;
  return last;
}

/** First and last segment of the run of `&&` steps that ends the command:
 *  the steps its exit status can come from. */
function finalAndRun(
  segments: readonly string[],
  operators: readonly string[],
): { first: number; last: number } {
  let last = segments.length - 1;
  while (last > 0 && NO_COMMAND_RE.test(segments[last]!)) last--;
  let first = last;
  while (first > 0 && operators[first - 1] === '&&') first--;
  return { first, last };
}

/**
 * Classifies every git segment of a heredoc-stripped shell command, so a
 * chained `git commit -m x && git push` yields a commit AND a push instead
 * of whichever verb `classifyGitCommand` ranks first.
 *
 * The hook reports one success/error pair for the whole command. A failure
 * goes to the git segment the error text names (see `errorSegmentIndex`), and
 * the segments `&&` then kept from running are dropped. When the text names
 * none, any step of the final `&&` run may have failed, so the steps after
 * its first are dropped as possibly never run, and the first, which ran,
 * carries the failure only when it is the run's only step. Every other
 * segment counts as succeeded, so a commit before a rejected push or a
 * failing `gh pr create` still counts. The target directory comes from the
 * whole command, so a `cd dir &&` in an earlier segment still attributes
 * every git segment.
 */
export function classifyGitSegments(
  command: string,
  record: ToolCallRecord,
  resolveRepo: (dir: string | null) => string | null,
): ClassifiedGitSegment[] {
  const { segments: all, operators } = splitShellChain(command);
  const gitIndexes = all.flatMap((s, i) => (GIT_SEGMENT_RE.test(s) ? [i] : []));
  const segments = gitIndexes.map((i) => all[i]!);
  let owner = errorSegmentIndex(segments, (record.error as string) ?? '');
  let failedAt = -1;
  if (!record.success && owner !== -1) {
    failedAt = gitIndexes[owner]!;
  } else if (!record.success) {
    const run = finalAndRun(all, operators);
    failedAt = run.first;
    if (run.first === run.last) owner = gitIndexes.indexOf(run.first);
  }
  const skippedThrough = failedAt === -1 ? -1 : lastSkippedSegment(operators, failedAt);
  const targetDir = gitCommandTargetDir(command, record.cwd as string | undefined);
  return segments.flatMap((segment, i) => {
    if (gitIndexes[i]! > failedAt && gitIndexes[i]! <= skippedThrough) return [];
    const forSegment = i === owner ? record : { ...record, success: true, error: undefined };
    return [{ segment, event: classifyGitCommand(segment, forSegment, resolveRepo, targetDir) }];
  });
}
