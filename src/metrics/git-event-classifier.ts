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
  /** For one segment of a chained command that failed, true only when the
   *  shell's `&&` grouping shows the segment succeeded, and otherwise the
   *  command's own `false` (see `classifyGitSegments`). */
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
/** Whether a segment is only whitespace and `#` comments, so it runs nothing.
 *  Checked per line rather than with one regex: `(?:\s|#[^\n]*)*` backtracks
 *  exponentially on a run of `#`. */
function runsNoCommand(segment: string): boolean {
  return segment.split('\n').every((line) => {
    const trimmed = line.trim();
    return trimmed === '' || trimmed.startsWith('#');
  });
}
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
        runsNoCommand(source.slice(start, i));
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

// Git verbs whose own output can report a merge/rebase conflict. A plain
// `git stash` or `git checkout <branch>` cannot.
const GIT_CONFLICT_CAPABLE_RE =
  /\bgit\s+(?:merge|rebase|pull|cherry-pick|revert|am|apply|stash\s+(?:pop|apply|branch)|(?:checkout|switch)\b.*\s(?:-m|--merge)\b)/;

// How bash reads a `ShellChain`. `;`, newline and `&` end an and-or list.
// Within one, `&&` and `||` join pipelines left to right with equal
// precedence, so `a || b && c` is `(a || b) && c`. `|` joins the commands of
// one pipeline, whose exit status is its last command's.

/** Whether `op` joins two commands of one pipeline. `|&` is a `|`. */
function isPipe(op: string | undefined): boolean {
  return op === '|' || op === '|&';
}

/** First segment of the `&&` run holding segment `i`: the pipelines `&&`
 *  joins to it, back to a `||` or the start of its and-or list. */
function andRunStart(operators: readonly string[], i: number): number {
  let start = i;
  while (start > 0 && (operators[start - 1] === '&&' || isPipe(operators[start - 1]))) start--;
  return start;
}

/** Last segment of the pipeline that starts at segment `start`. */
function pipelineEnd(operators: readonly string[], start: number): number {
  let end = start;
  while (isPipe(operators[end])) end++;
  return end;
}

/**
 * Start of the segments before `target` that ran and succeeded if `target`
 * ran: those that `&&` alone joins to it. A `|` or `||` between them ends
 * the proof, and so does the `||` before an `&&` run: in `a || b && t`,
 * which is `(a || b) && t`, `b` may not have run.
 */
function provenSuccessStart(operators: readonly string[], target: number): number {
  let from = target;
  while (from > 0 && operators[from - 1] === '&&') from--;
  const run = andRunStart(operators, from);
  const afterOr = run > 0 && operators[run - 1] === '||';
  return from < target && afterOr && pipelineEnd(operators, run) === from ? from + 1 : from;
}

/** Last segment that `&&` kept from running after segment `failed` failed;
 *  `failed` itself when the next segment runs anyway, as it does when
 *  `failed` is piped into another command. */
function lastSkippedSegment(operators: readonly string[], failed: number): number {
  if (isPipe(operators[failed])) return failed;
  let last = failed;
  while (operators[last] === '&&' || isPipe(operators[last])) last++;
  return last;
}

/** Last segment that runs a command: the one the command's exit status
 *  comes from, if it ran. */
function lastCommandSegment(segments: readonly string[]): number {
  let last = segments.length - 1;
  while (last > 0 && runsNoCommand(segments[last]!)) last--;
  return last;
}

/** Index of the last git segment matching `re`, or -1. */
function lastGitSegment(
  segments: readonly string[],
  isGit: readonly boolean[],
  re: RegExp,
): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (isGit[i] && re.test(segments[i]!)) return i;
  }
  return -1;
}

/**
 * Index of the git segment whose output `error` is, or -1 when no segment's
 * is. The hook payload carries one error for the whole command, not one per
 * segment, but conflict, rejection and commit-failure text names the kind of
 * git command that printed it. Conflict text goes to the earliest segment
 * that can print it in the last `&&` run holding one: a conflict stops the
 * run, and any of those segments may be the one it stopped at, so the
 * earliest counts no step as run that may not have. `git pull && git commit
 * && git checkout other` hands it to the pull. Otherwise rejection text goes
 * to the last `git push`, or commit-failure text to the last `git commit`,
 * whichever comes later.
 */
function errorSegmentIndex(
  { segments, operators }: ShellChain,
  isGit: readonly boolean[],
  error: string,
): number {
  if (MERGE_CONFLICT_INDICATORS.some((re) => re.test(error)) || REBASE_CONFLICT_RE.test(error)) {
    const last = lastGitSegment(segments, isGit, GIT_CONFLICT_CAPABLE_RE);
    if (last !== -1) {
      const run = andRunStart(operators, last);
      for (let i = run; i < last; i++) {
        if (isGit[i] && GIT_CONFLICT_CAPABLE_RE.test(segments[i]!)) return i;
      }
      return last;
    }
  }
  const push = REJECT_INDICATORS.some((re) => re.test(error))
    ? lastGitSegment(segments, isGit, GIT_PUSH_RE)
    : -1;
  const commit = COMMIT_FAILURE_INDICATORS.some((re) => re.test(error))
    ? lastGitSegment(segments, isGit, GIT_COMMIT_RE)
    : -1;
  return Math.max(push, commit);
}

/**
 * Classifies every git segment of a heredoc-stripped shell command, so a
 * chained `git commit -m x && git push` yields a commit AND a push instead
 * of whichever verb `classifyGitCommand` ranks first.
 *
 * The hook reports one success/error pair for the whole command, so for a
 * failed command each segment's outcome is read off bash's grouping. The
 * failure goes to the segment the error text names (see `errorSegmentIndex`),
 * and the segments `&&` then kept from running are dropped. When the text
 * names none, the failure is taken to be the last command's, but any step
 * of the final `&&` run may be the one that failed, so the steps after its
 * first are dropped as possibly never run. A segment is marked succeeded
 * only when `&&` alone joins it to the step the failure goes to (see
 * `provenSuccessStart`), so a commit before a rejected push or a failing
 * `gh pr create` still counts. Every other segment keeps the command's
 * `success`, which for a failed command cannot inflate a count. The target
 * directory comes from the whole command, so a `cd dir &&` in an earlier
 * segment still attributes every git segment.
 */
export function classifyGitSegments(
  command: string,
  record: ToolCallRecord,
  resolveRepo: (dir: string | null) => string | null,
): ClassifiedGitSegment[] {
  const chain = splitShellChain(command);
  const { segments, operators } = chain;
  const isGit = segments.map((s) => GIT_SEGMENT_RE.test(s));
  let owner = errorSegmentIndex(chain, isGit, (record.error as string) ?? '');
  // Segments [proven, failedAt) succeeded; (dropFrom, dropThrough] did not,
  // or may not, have run.
  let failedAt = -1;
  let dropFrom = -1;
  let dropThrough = -1;
  if (!record.success && owner !== -1) {
    failedAt = owner;
    dropFrom = owner;
    dropThrough = lastSkippedSegment(operators, owner);
  } else if (!record.success) {
    failedAt = lastCommandSegment(segments);
    dropFrom = pipelineEnd(operators, andRunStart(operators, failedAt));
    dropThrough = failedAt;
    if (dropFrom === failedAt && isGit[failedAt]) owner = failedAt;
  }
  const proven = failedAt === -1 ? -1 : provenSuccessStart(operators, failedAt);
  const targetDir = gitCommandTargetDir(command, record.cwd as string | undefined);
  return segments.flatMap((segment, i) => {
    if (!isGit[i] || (i > dropFrom && i <= dropThrough)) return [];
    const forSegment =
      i === owner
        ? record
        : { ...record, success: record.success || (i >= proven && i < failedAt), error: undefined };
    return [{ segment, event: classifyGitCommand(segment, forSegment, resolveRepo, targetDir) }];
  });
}
