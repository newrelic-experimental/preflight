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

// What only a failed `git commit` prints: its own refusals, or a hook failure
// (husky prints "husky - pre-commit script failed (code 1)").
const OWN_COMMIT_FAILURE_INDICATORS = [
  /nothing to commit/i,
  /Committing is not possible/i,
  /Aborting commit/i,
  /\b(?:pre-commit|commit-msg)\b.*\b(?:failed|exited)\b/i,
];

// What a failed `git commit` prints. The last two also end the status block
// a conflicting `git stash pop` or `git merge` prints.
const COMMIT_FAILURE_INDICATORS = [
  ...OWN_COMMIT_FAILURE_INDICATORS,
  /nothing added to commit/i,
  /no changes added to commit/i,
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
   *  command's own `false`. Always false for a segment `&` ran in the
   *  background (see `classifyGitSegments`). */
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

/** A plain or force push that succeeded. A failed push keeps its push type
 *  when its error shows no rejection, as when it fails on auth or exits a
 *  `;` list after another step's conflict. Both reducers count pushes with
 *  this, as they do commits with `isCountedCommit`. */
export function isCountedPush(event: GitEvent): boolean {
  return (
    event.success &&
    (event.type === 'push' || event.type === 'force_push' || event.type === 'force_push_lease')
  );
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
// The number must end its word, so `gh pr merge 123-fix-login` names a
// branch, not #123; a `)` closing a subshell also ends it.
const GH_PR_COMMAND_RE = new RegExp(
  String.raw`^\s*${ENV_PREFIX}gh\s+pr\s+(\w+)\b(?:\s+(\d+)(?=[\s)]|$))?`,
);

/** `gh pr <verb>` actions this tracks; any other verb returns null. */
const GH_PR_VERB_ACTION: Record<string, PrEvent['action']> = {
  create: 'create',
  merge: 'merge',
  checks: 'checks',
  ready: 'ready',
  edit: 'edit',
  view: 'view',
};

/** A shell command's segments and the operators between them:
 *  `operators[i]` joins `segments[i]` to `segments[i + 1]`. */
export interface ShellChain {
  readonly segments: readonly string[];
  readonly operators: readonly string[];
  /** False when a quote never closed, so where each segment ends is a guess
   *  (see `splitShellChain`). */
  readonly quotesBalanced: boolean;
}

// Line breaks, blank lines and comment lines right after `||`, `&&` or `|`,
// where bash reads on to the next line for the rest of the command.
const CONTINUED_LINES_RE = /(?:[ \t]*(?:#[^\n]*)?\n)+/y;

// Characters that end a word. `)` is left out because it also closes a
// `$( … )` inside a word.
const WORD_BREAK_RE = /[ \t(<>]/;

/**
 * Splits a shell command on its top-level `||`, `&&`, `;`, `|`, `&` and
 * newline operators, read the way bash reads them. An operator inside quotes
 * or a comment is text. A `#` at the start of the command, after an operator
 * or after a `WORD_BREAK_RE` character starts a comment, which runs to the end
 * of its line and is left out of the segment. A backslash-newline joins two
 * lines, and after `||`, `&&` or `|` the line breaks and comment lines before
 * the next command are skipped, so every segment begins at its command.
 * Segments are not trimmed. `|&` is reported as `|`, and the `&` of a
 * redirection (`2>&1`, `&>file`) is not an operator. Strip heredoc bodies
 * first so a surviving newline really does start a new command.
 *
 * bash stops with an error at a quote that never closes, so meeting one in a
 * command that succeeded means this scan misread it, as it does `$'it\'s'`.
 * Such a command is split on every operator, quoted or commented, which keeps
 * every command it holds, and `quotesBalanced` is false.
 */
export function splitShellChain(command: string): ShellChain {
  const chain = scanShellChain(command, true);
  return chain.quotesBalanced
    ? chain
    : { ...scanShellChain(command, false), quotesBalanced: false };
}

/** `splitShellChain`'s scan. With `readQuotes` false, quote characters and
 *  `#` are plain text. */
function scanShellChain(command: string, readQuotes: boolean): ShellChain {
  const segments: string[] = [];
  const operators: string[] = [];
  let current = '';
  let quote: string | null = null;
  let wordStart = true;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      if (command[i + 1] !== '\n') {
        current += command.slice(i, i + 2);
        wordStart = false;
      }
      i++;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (readQuotes && (ch === '"' || ch === "'")) {
      current += ch;
      quote = ch;
      wordStart = false;
      continue;
    }
    if (readQuotes && ch === '#' && wordStart) {
      const lineEnd = command.indexOf('\n', i);
      i = (lineEnd === -1 ? command.length : lineEnd) - 1;
      continue;
    }
    const pair = command.slice(i, i + 2);
    let operator: string;
    if (pair === '||' || pair === '&&' || pair === '|&') {
      operator = pair === '|&' ? '|' : pair;
      i++;
    } else if (ch === '|' || ch === ';' || ch === '\n') {
      operator = ch;
    } else if (
      ch === '&' &&
      command[i - 1] !== '>' &&
      command[i - 1] !== '<' &&
      command[i + 1] !== '>'
    ) {
      operator = ch;
    } else {
      current += ch;
      wordStart = WORD_BREAK_RE.test(ch);
      continue;
    }
    segments.push(current);
    operators.push(operator);
    current = '';
    wordStart = true;
    if (operator === '||' || operator === '&&' || operator === '|') {
      CONTINUED_LINES_RE.lastIndex = i + 1;
      if (CONTINUED_LINES_RE.test(command)) i = CONTINUED_LINES_RE.lastIndex - 1;
    }
  }
  segments.push(current);
  return { segments, operators, quotesBalanced: quote === null };
}

/** The segments of `splitShellChain`, without the operators. */
export function splitShellSegments(command: string): string[] {
  return [...splitShellChain(command).segments];
}

/** The PrEvent a `gh pr <verb>` segment denotes, or null when it is not one. */
export function processGhCommand(command: string, timestamp: number): PrEvent | null {
  const match = GH_PR_COMMAND_RE.exec(command);
  if (!match) return null;
  const action = GH_PR_VERB_ACTION[match[1]];
  if (!action) return null;
  return { timestamp, action, prNumber: match[2] ?? null };
}

// `-R`/`--repo` and a `GH_REPO=` prefix point gh at a repo other than the
// cwd's. Any short-flag cluster holding an `R` (`-dR`) counts too, which errs
// toward treating the segment as aimed elsewhere.
const GH_REPO_OVERRIDE_RE = /(?:^|\s)(?:-[A-Za-z]*R|--repo(?=[\s=]|$)|GH_REPO=)/;

// `--auto` queues a merge until its requirements pass and `--disable-auto`
// cancels one, so neither merged anything when it ran.
const GH_PR_AUTO_MERGE_RE = /(?:^|\s)--(?:auto|disable-auto)(?=[\s=]|$)/;

/** True when a `gh` segment names its repo explicitly, so a PR number in it
 *  may belong to a repo other than the cwd's. */
export function ghSegmentOverridesRepo(segment: string): boolean {
  return GH_REPO_OVERRIDE_RE.test(segment);
}

/** True when a `gh pr merge` segment only enables or disables auto-merge. */
export function ghPrMergeTogglesAuto(segment: string): boolean {
  return GH_PR_AUTO_MERGE_RE.test(segment);
}

// Blank, a comment, or only the `)`/`}` closing groups that end with the
// segment before it.
const NO_COMMAND_RE = /^[\s)}]*(?:#[^\n]*)?$/;
const QUOTED_SPAN_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

/** Net groups (`( … )`, `{ … }`, `$( … )`) a segment opens, ignoring quoted
 *  brackets. */
function groupsOpened(segment: string): number {
  const bare = segment.replace(QUOTED_SPAN_RE, '');
  return (bare.match(/[({]/g)?.length ?? 0) - (bare.match(/[)}]/g)?.length ?? 0);
}

/** True when a segment runs no command of its own. */
export function segmentRunsNoCommand(segment: string): boolean {
  return NO_COMMAND_RE.test(segment);
}

/**
 * True when the command succeeding means its segment `index` ran and
 * succeeded. A hook reports one exit status for the whole command, so that
 * holds only when the segment's own status decides it: the segment is not
 * piped into anything or put in the background, neither it nor a group
 * around it is the fallback of a `||`, and nothing follows it except `&&`
 * steps, which run only if it succeeded. A trailing `;` or newline runs
 * nothing more and is ignored. bash can't end a list on `||`, `&&` or `|`,
 * so a segment that runs nothing after one of those means text was stripped
 * or misread, and the merge doesn't count. A chain whose quotes did not
 * balance shows none of this.
 */
export function segmentSuccessFollowsCommand(chain: ShellChain, index: number): boolean {
  const { segments, operators } = chain;
  if (!chain.quotesBalanced) return false;
  let lastRun = operators.length;
  while (
    lastRun > index &&
    segmentRunsNoCommand(segments[lastRun]) &&
    (operators[lastRun - 1] === ';' || operators[lastRun - 1] === '\n')
  ) {
    lastRun--;
  }
  for (let j = index; j < lastRun; j++) {
    // `&& x | y` is one `&&` step.
    if (operators[j] !== '&&' && (operators[j] !== '|' || j === index)) return false;
    if (segmentRunsNoCommand(segments[j + 1])) return false;
  }
  // The segment, then the segment opening each group it sits in.
  const starts = [index];
  let opened = 0;
  for (let j = index - 1; j >= 0; j--) {
    opened += groupsOpened(segments[j]);
    if (opened > 0) {
      starts.push(j);
      opened = 0;
    }
  }
  return starts.every((start) => {
    let pipelineStart = start;
    while (pipelineStart > 0 && operators[pipelineStart - 1] === '|') pipelineStart--;
    return pipelineStart === 0 || operators[pipelineStart - 1] !== '||';
  });
}

// `cd [dir]` or `pushd [dir]` opening a segment, including as the first
// command of a subshell or brace group and behind `builtin` or `command`.
const CD_SEGMENT_RE =
  /^[\s({]*(?:(?:builtin|command)\s+)?(?:cd|pushd)(?:\s+(?:"([^"]*)"|'([^']*)'|([^\s;)}]+)))?(?=[\s;)}]|$)/;
const GH_REPO_ASSIGNMENT_RE = /(?:^|\s)GH_REPO=/;

/** The directory a segment's leading `cd` or `pushd` moves to: `''` for a
 *  bare one (`cd` goes home), null when the segment does not start with one. */
export function cdSegmentTarget(segment: string): string | null {
  const match = CD_SEGMENT_RE.exec(segment);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

/** True when a segment assigns `GH_REPO`, which can point the gh calls after
 *  it at another repo. */
export function segmentAssignsGhRepo(segment: string): boolean {
  return GH_REPO_ASSIGNMENT_RE.test(segment);
}

export interface ClassifiedGitSegment {
  readonly segment: string;
  readonly event: GitEvent;
}

// Git verbs whose own output can report a merge/rebase conflict. A plain
// `git stash` or `git checkout <branch>` cannot, nor can `git merge-base` or
// `git mergetool`, which `(?![\w-])` keeps from matching as `git merge`.
const GIT_CONFLICT_CAPABLE_RE =
  /\bgit\s+(?:merge|rebase|pull|cherry-pick|revert|am|apply|stash\s+(?:pop|apply|branch)|(?:checkout|switch)\b.*\s(?:-m|--merge))(?![\w-])/;

// How bash reads a `ShellChain`. `;`, newline and `&` end an and-or list.
// Within one, `&&` and `||` join pipelines left to right with equal
// precedence, so `a || b && c` is `(a || b) && c`. `|` joins the commands of
// one pipeline, whose exit status is its last command's.

/** Whether `op` joins two commands of one pipeline. `splitShellChain`
 *  reports `|&` as `|`. */
function isPipe(op: string | undefined): boolean {
  return op === '|';
}

/** Whether segment `i` sits in an and-or list that `&` runs in the
 *  background, whose exit status never reaches the command's. */
function inBackground(operators: readonly string[], i: number): boolean {
  let end = i;
  while (operators[end] === '&&' || operators[end] === '||' || isPipe(operators[end])) end++;
  return operators[end] === '&';
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
 * The commands `&&` runs segment `target` after, as a chain of their own,
 * or null when `target` follows another operator. `target` ran only if that
 * chain succeeded, so "did `target` running prove segment `i` succeeded" is
 * `segmentSuccessFollowsCommand` asked of it, with that function's handling
 * of `||` fallbacks, groups, pipelines and unbalanced quotes. A `target`
 * piped from another command is taken to prove nothing before it, the
 * reading that counts less in the case it decides: a failure that names no
 * step with a pipeline last, as in `git commit -m x && git log | head -1`,
 * where the commit may be the step that failed.
 */
function chainRunBefore(chain: ShellChain, target: number): ShellChain | null {
  if (target < 1 || chain.operators[target - 1] !== '&&') return null;
  return {
    segments: chain.segments.slice(0, target),
    operators: chain.operators.slice(0, target - 1),
    quotesBalanced: chain.quotesBalanced,
  };
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
  while (last > 0 && segmentRunsNoCommand(segments[last]!)) last--;
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

/** Index of the last `git push` that `skip` doesn't rule out when `error`
 *  holds rejection text, or -1. */
function rejectedPushIndex(
  segments: readonly string[],
  isGit: readonly boolean[],
  error: string,
  skip: (i: number) => boolean = () => false,
): number {
  if (!REJECT_INDICATORS.some((re) => re.test(error))) return -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (isGit[i] && !skip(i) && GIT_PUSH_RE.test(segments[i]!)) return i;
  }
  return -1;
}

/** The lines of `error` that any of `indicators` match. */
function linesMatching(error: string, indicators: readonly RegExp[]): string {
  return error
    .split('\n')
    .filter((line) => indicators.some((re) => re.test(line)))
    .join('\n');
}

/** The lines of `error` that report a rejected push, so a push classified on
 *  them is not typed by the conflict text beside them. */
function rejectionText(error: string): string {
  return linesMatching(error, REJECT_INDICATORS);
}

const CONFLICT_TEXT_INDICATORS: readonly RegExp[] = [
  ...MERGE_CONFLICT_INDICATORS,
  REBASE_CONFLICT_RE,
];

/** A commit's refusal to run over unmerged files, which neither a stash
 *  pop's status block nor a usual commit subject prints. */
const UNMERGED_COMMIT_RE = /Committing is not possible/i;

// Lines that carry a commit's subject rather than a failure: the summary a
// commit that landed prints, and a rebase conflict's echo of the one it
// stopped at.
const COMMIT_SUBJECT_LINE_RE = /^\[[^\]\n]+ [0-9a-f]{7,}\]|could not apply/i;

/** `error` without the lines that echo a commit subject, so a subject such as
 *  "Fix pre-commit hook failed on CI" doesn't read as a commit failure. */
function commitOutputLines(error: string): string {
  return error
    .split('\n')
    .filter((line) => !COMMIT_SUBJECT_LINE_RE.test(line))
    .join('\n');
}

/** The git segment whose output `error` is, and whether it is a commit that
 *  failed beside conflict text another step printed. */
interface ErrorOwner {
  /** The segment index, or -1 when no segment's output `error` is. */
  readonly owner: number;
  /** The owner is a commit that failed while the error also holds conflict
   *  text it didn't print: a conflict-capable step before its `&&` run did,
   *  or none in the command did. The commit's own lines are its failure. */
  readonly commitOverConflict: boolean;
}

/**
 * The git segment whose output `error` is. The hook payload carries one error
 * for the whole command, not one per segment, but conflict, rejection and
 * commit-failure text names the kind of git command that printed it.
 * Conflict and commit-failure text go to the earliest segment that can print
 * them in the last `&&` run holding one: the failure stops the run, and any
 * of those segments may be the one it stopped at, so the earliest counts no
 * step as run that may not have. `git pull && git commit && git checkout
 * other` hands a conflict to the pull, and `git commit -m a && git commit -m
 * b` hands a failed hook to the first commit. When a conflict-capable step
 * before the conflict's run can have printed the conflict text, a commit in
 * that run, before the step that can conflict, that printed a failure of its
 * own is what stopped the run, as in `git stash pop; git commit -m x && git
 * pull` or `git merge x; git add -A && git commit -m m && git rebase main`,
 * so it takes the failure. Otherwise rejection text goes to the last `git
 * push`, or commit-failure text to its commit, whichever comes later.
 */
function errorSegmentIndex(
  { segments, operators }: ShellChain,
  isGit: readonly boolean[],
  error: string,
): ErrorOwner {
  const earliestInLastRun = (re: RegExp): number => {
    const last = lastGitSegment(segments, isGit, re);
    if (last === -1) return -1;
    for (let i = andRunStart(operators, last); i < last; i++) {
      if (isGit[i] && re.test(segments[i]!)) return i;
    }
    return last;
  };
  const conflictText = CONFLICT_TEXT_INDICATORS.some((re) => re.test(error));
  if (conflictText) {
    const conflict = earliestInLastRun(GIT_CONFLICT_CAPABLE_RE);
    if (conflict !== -1) {
      const run = andRunStart(operators, conflict);
      const conflictBeforeRun =
        lastGitSegment(segments.slice(0, run), isGit, GIT_CONFLICT_CAPABLE_RE) !== -1;
      // The refusal is the commit's whatever printed the conflict text; other
      // commit-only text counts when an earlier step can own the conflict.
      const commitStopped =
        UNMERGED_COMMIT_RE.test(error) ||
        (conflictBeforeRun &&
          OWN_COMMIT_FAILURE_INDICATORS.some((re) => re.test(commitOutputLines(error))));
      if (commitStopped) {
        for (let i = run; i < conflict; i++) {
          if (isGit[i] && GIT_COMMIT_RE.test(segments[i]!)) {
            return { owner: i, commitOverConflict: true };
          }
        }
      }
      return { owner: conflict, commitOverConflict: false };
    }
  }
  const push = rejectedPushIndex(segments, isGit, error);
  const commit = COMMIT_FAILURE_INDICATORS.some((re) => re.test(error))
    ? earliestInLastRun(GIT_COMMIT_RE)
    : -1;
  const owner = Math.max(push, commit);
  // No step here can conflict, so a commit refusing over unmerged files saw
  // conflict text another command left, as `git status` prints it.
  const refusedOverUnmerged =
    owner !== -1 && owner === commit && conflictText && UNMERGED_COMMIT_RE.test(error);
  return { owner, commitOverConflict: refusedOverUnmerged };
}

/**
 * Classifies every git segment of a heredoc-stripped shell command, so a
 * chained `git commit -m x && git push` yields a commit AND a push instead
 * of whichever verb `classifyGitCommand` ranks first.
 *
 * The hook reports one success/error pair for the whole command, so for a
 * failed command each segment's outcome is read off bash's grouping. The
 * failure goes to the segment the error text names (see `errorSegmentIndex`),
 * and the segments `&&` then kept from running are dropped. Rejection text
 * also names the last push that ran and may have failed when other text
 * names another segment, as the pull's conflict does in `git pull; git
 * push`. When the text names none, the failure is taken to be the last
 * command's, but any step of the final `&&` run may be the one that failed,
 * so the steps after its first are dropped as possibly never run. A segment
 * is marked succeeded only when the step the failure goes to running proves
 * it did (see `chainRunBefore`), so a commit before a rejected push or a
 * failing `gh pr create` still counts. That proof needs the quotes to
 * balance: bash refuses a command whose quote never closes, so the `&&` may
 * be quoted text and nothing may have run. Dropping needs no such check,
 * since a dropped step counts nowhere, while a kept one that never ran would
 * still count in the totals that ignore `success`, such as `pullCount` and
 * `forcePushes`. Every other segment keeps the command's `success`, which
 * for a failed command counts no commit or push (see `isCountedCommit` and
 * `isCountedPush`), except that a segment `&` runs in the background is
 * never marked succeeded. The target directory comes from the whole
 * command, so a `cd dir &&` in an earlier segment still attributes every
 * git segment.
 */
export function classifyGitSegments(
  command: string,
  record: ToolCallRecord,
  resolveRepo: (dir: string | null) => string | null,
): ClassifiedGitSegment[] {
  const chain = splitShellChain(command);
  const { segments, operators } = chain;
  const isGit = segments.map((s) => GIT_SEGMENT_RE.test(s));
  const error = (record.error as string) ?? '';
  const errorOwner = errorSegmentIndex(chain, isGit, error);
  let owner = errorOwner.owner;
  // Segments (dropFrom, dropThrough] did not, or may not, have run.
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
  const dropped = (i: number): boolean => i > dropFrom && i <= dropThrough;
  const before = chainRunBefore(chain, failedAt);
  const provenSucceeded = (i: number): boolean =>
    before !== null && i < failedAt && segmentSuccessFollowsCommand(before, i);
  // Rejection text names the last push that ran and may have failed: not one
  // `&&` kept from running, nor one `&&` proves succeeded.
  const rejected = rejectedPushIndex(
    segments,
    isGit,
    error,
    (i) => dropped(i) || provenSucceeded(i),
  );
  // A commit that took the failure over conflict text (see errorSegmentIndex)
  // gets only its own lines, and the conflict goes to the conflict-capable
  // step before it that printed it, such as the `git stash pop` in
  // `git stash pop; git commit -m x && git pull`.
  const { commitOverConflict } = errorOwner;
  const conflictAt = commitOverConflict
    ? lastGitSegment(segments.slice(0, owner), isGit, GIT_CONFLICT_CAPABLE_RE)
    : -1;
  const targetDir = gitCommandTargetDir(command, record.cwd as string | undefined);
  return segments.flatMap((segment, i) => {
    if (!isGit[i] || dropped(i)) return [];
    const forSegment =
      i === owner
        ? commitOverConflict
          ? { ...record, error: linesMatching(error, COMMIT_FAILURE_INDICATORS) }
          : record
        : i === conflictAt
          ? { ...record, success: false, error: linesMatching(error, CONFLICT_TEXT_INDICATORS) }
          : i === rejected
            ? { ...record, success: false, error: rejectionText(error) }
            : {
                ...record,
                success: (record.success || provenSucceeded(i)) && !inBackground(operators, i),
                error: undefined,
              };
    return [{ segment, event: classifyGitCommand(segment, forSegment, resolveRepo, targetDir) }];
  });
}
