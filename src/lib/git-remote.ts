/**
 * One parser for git remote URLs, shared by every call site that needs an
 * `owner/repo` name or a browsable commit URL.
 *
 * Four copies of this logic existed before (`inferProjectId` in config.ts, an
 * inline regex in index.ts, and `repoNameFromRemote`/`commitUrlFromRemote` in
 * metrics/local-session-aggregator.ts), and only some of them dropped the
 * credentials a remote can carry. `https://<token>@host/repo` parsed with a
 * naive "last two path segments" regex yields `<token>@host/repo` — the token
 * then travels into whatever field the caller stores. Credentials are stripped
 * here, once, before anything else looks at the string.
 *
 * Supported shapes:
 *   https://host/owner/repo(.git)      scheme URL
 *   ssh://git@host/owner/repo(.git)    scheme URL with userinfo
 *   git@host:owner/repo(.git)          scp-like syntax
 *   /srv/git/owner/repo.git            local path (no host)
 */

/** Scheme URL: captures everything after `scheme://`. */
const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.+)$/;

/** Leading `user@` or `user:password@`, up to the first `/` or `@`. */
const LEADING_USERINFO = /^[^/@]*@/;

/** scp-like `host:path`, where the host looks like a hostname (contains a dot). */
const SCP_LIKE = /^([^/:]+\.[^/:]+):(.+)$/;

/** `host/path` inside a scheme URL. */
const HOST_PATH = /^([^/]+)\/(.+)$/;

export interface ParsedGitRemote {
  /** Hostname, or null for a local path with no host component. */
  readonly host: string | null;
  /** Path after the host, with any trailing `.git` removed. */
  readonly path: string;
  /** Last two path segments, e.g. `acme/widgets`, or null if there are fewer than two. */
  readonly ownerRepo: string | null;
}

/**
 * Removes any `user@` / `user:password@` prefix from a remote URL. Applied to
 * the part after the scheme for a URL, and to the whole string for scp-like
 * syntax. A local path (no userinfo) is returned unchanged.
 */
export function stripRemoteCredentials(remote: string): string {
  const trimmed = remote.trim();
  const url = SCHEME_URL.exec(trimmed);
  if (url) {
    const scheme = trimmed.slice(0, trimmed.length - url[1].length);
    return scheme + url[1].replace(LEADING_USERINFO, '');
  }
  return trimmed.replace(LEADING_USERINFO, '');
}

export function parseGitRemote(remote: string | null | undefined): ParsedGitRemote | null {
  if (typeof remote !== 'string') return null;
  const stripped = stripRemoteCredentials(remote);
  if (stripped.length === 0) return null;

  const url = SCHEME_URL.exec(stripped);
  const body = url ? url[1] : stripped;

  let host: string | null = null;
  let rawPath = body;

  const scp = SCP_LIKE.exec(body);
  if (scp) {
    host = scp[1];
    rawPath = scp[2];
  } else if (url) {
    const hostPath = HOST_PATH.exec(body);
    if (!hostPath) return null;
    host = hostPath[1];
    rawPath = hostPath[2];
  }

  const path = rawPath.replace(/\.git$/, '').replace(/\/+$/, '');
  if (path.length === 0) return null;

  const segments = path.split('/').filter((s) => s.length > 0);
  const ownerRepo = segments.length >= 2 ? segments.slice(-2).join('/') : null;

  return { host, path, ownerRepo };
}

/** `owner/repo` for a remote, or null when it cannot be determined. */
export function repoNameFromRemote(remote: string | null | undefined): string | null {
  return parseGitRemote(remote)?.ownerRepo ?? null;
}

/**
 * Browsable commit URL for a remote, or null for a remote with no host (a
 * local path is not browsable) or an empty hash.
 */
export function commitUrlFromRemote(
  remote: string | null | undefined,
  hash: string,
): string | null {
  if (!hash) return null;
  const parsed = parseGitRemote(remote);
  if (!parsed?.host) return null;
  return `https://${parsed.host}/${parsed.path}/commit/${hash}`;
}
