/**
 * A GitHub PR named independently of any local clone: `owner/repo#N`, with
 * `owner/repo` lowercased because GitHub names are case-insensitive. Two
 * clones of one GitHub repo name the same PR the same way, which the git
 * common dir can't.
 */
export type PrRef = `${string}/${string}#${string}`;

const PR_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_NUMBER_RE = /^\d{1,9}$/;

/** `value` as a lowercased `owner/repo`, or undefined when it isn't one. */
export function parsePrRepo(value: unknown): string | undefined {
  return typeof value === 'string' && PR_REPO_RE.test(value) ? value.toLowerCase() : undefined;
}

/** A `[HOST/]OWNER/REPO` repo name, the form gh takes, as a lowercased
 *  `owner/repo`, or null when it isn't one. */
export function parseGhRepoName(value: string): string | null {
  const parts = value.split('/');
  if (parts.length !== 2 && parts.length !== 3) return null;
  return parsePrRepo(parts.slice(-2).join('/')) ?? null;
}

/** The ref for a PR number in a repo, or null when either is unknown. */
export function prRefOf(repo: unknown, prNumber: string | null | undefined): PrRef | null {
  const parsed = parsePrRepo(repo);
  if (parsed === undefined || typeof prNumber !== 'string' || !PR_NUMBER_RE.test(prNumber)) {
    return null;
  }
  return `${parsed}#${prNumber}` as PrRef;
}

// Any `-R`, `--repo` or `GH_REPO=`, including a short-flag cluster such as
// `-dR`, the same set `ghSegmentOverridesRepo` treats as naming a repo.
const GH_REPO_MENTION_RE = /(?:^|\s)(?:-[A-Za-z]*R|--repo(?=[\s=]|$)|GH_REPO=)/g;
// The forms whose value this can read: `-R x`, `--repo x`, `--repo=x` and a
// `GH_REPO=x` prefix, with the value optionally quoted.
const GH_REPO_VALUE_RE = /(?:^|\s)(?:-R\s+|--repo(?:\s+|=)|GH_REPO=)(["']?)([^\s"']+)\1(?=\s|$)/;

/**
 * The `owner/repo` a `gh` segment names with `-R`/`--repo` or a `GH_REPO=`
 * prefix, or null when it names none, names more than one, or names one in a
 * form this doesn't read. Both take `[HOST/]OWNER/REPO` (`gh help
 * environment`, `gh pr merge --help`).
 */
export function ghSegmentRepo(segment: string): string | null {
  if ((segment.match(GH_REPO_MENTION_RE) ?? []).length !== 1) return null;
  const value = GH_REPO_VALUE_RE.exec(segment)?.[2];
  return value === undefined ? null : parseGhRepoName(value);
}
