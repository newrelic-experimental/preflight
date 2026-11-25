import { shellWords, type ShellWord } from './shell-lexer.js';

/**
 * A GitHub PR named independently of any local clone: `owner/repo#N`, with
 * `owner/repo` lowercased because GitHub names are case-insensitive. Two
 * clones of one GitHub repo name the same PR the same way, which the git
 * common dir can't. A repo on a host other than github.com leads with its
 * host (`ghe.example.com/owner/repo#N`), so the same owner, repo and number
 * on two hosts are two PRs.
 */
export type PrRef = `${string}/${string}#${string}`;

const PR_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const PR_NUMBER_RE = /^\d{1,9}$/;
const GITHUB_HOST = 'github.com';

/** `value` as a lowercased `owner/repo`, or `host/owner/repo` for a host other
 *  than github.com, or undefined when it isn't one. A value with no host is
 *  taken to be on github.com, as is every repo saved before hosts were kept. */
export function parsePrRepo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/');
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const repo = parts.slice(-2).join('/');
  if (!PR_REPO_RE.test(repo)) return undefined;
  if (parts.length === 2) return repo.toLowerCase();
  const host = parts[0]!.toLowerCase();
  if (!PR_HOST_RE.test(host)) return undefined;
  return host === GITHUB_HOST ? repo.toLowerCase() : `${host}/${repo.toLowerCase()}`;
}

/** The ref for a PR number in a repo, or null when either is unknown. */
export function prRefOf(repo: unknown, prNumber: string | null | undefined): PrRef | null {
  const parsed = parsePrRepo(repo);
  if (parsed === undefined || typeof prNumber !== 'string' || !PR_NUMBER_RE.test(prNumber)) {
    return null;
  }
  return `${parsed}#${prNumber}` as PrRef;
}

/** What a word says about the repo: its `value`, `next` when the value is the
 *  next word, neither when it names a repo in a form this can't read, or null
 *  when it names none. Only the unquoted part of a word counts as a flag, so
 *  `--body "GH_REPO=x"` names nothing. */
function repoOfWord({ text, bare }: ShellWord): { value?: string; next?: true } | null {
  if (bare.startsWith('GH_REPO=')) return { value: text.slice('GH_REPO='.length) };
  if (bare.startsWith('--repo=')) return { value: text.slice('--repo='.length) };
  if (text === '--repo' && bare === text) return { next: true };
  if (text === '-R' && bare === text) return { next: true };
  if (bare.startsWith('-R')) return { value: text.slice(2) };
  // A short-flag cluster holding an `R` (`-dR`): another flag in it may take
  // the value, so which word is the repo is unknown.
  if (/^-[A-Za-z]*R/.test(bare)) return {};
  return null;
}

/** True when a `gh` segment names its repo explicitly, with `-R`, `--repo`, or
 *  a `GH_REPO=` prefix, so a PR number in it may belong to a repo other than
 *  the cwd's. A short-flag cluster holding an `R` (`-dR`) counts, which errs
 *  toward treating the segment as aimed elsewhere. */
export function ghSegmentNamesRepo(segment: string): boolean {
  return shellWords(segment).some((word) => repoOfWord(word) !== null);
}

/**
 * The `owner/repo` a `gh` segment names with `-R`/`--repo` or a `GH_REPO=`
 * prefix, or null when it names none, names more than one, or names one in a
 * form this doesn't read. Both take `[HOST/]OWNER/REPO` (`gh help
 * environment`, `gh pr merge --help`). The flags are read from the segment's
 * unquoted words, so a `-R` inside a quoted `--body` names nothing.
 */
export function ghSegmentRepo(segment: string): string | null {
  const words = shellWords(segment);
  const named = words.flatMap((word, i) => {
    const repo = repoOfWord(word);
    return repo === null ? [] : [{ repo, i }];
  });
  if (named.length !== 1) return null;
  const { repo, i } = named[0]!;
  const value = repo.next ? words[i + 1]?.text : repo.value;
  return value === undefined ? null : (parsePrRepo(value) ?? null);
}
