/**
 * The one parser for git remote URLs (`git remote get-url origin` output).
 *
 * Every function here strips credentials before returning anything, so a
 * caller cannot put a token from a remote into a log line, an event field, a
 * persisted session summary, or a link. Credentials are removed from:
 *
 * - URL userinfo (`https://<token>@host/...`, `https://user:<token>@host/...`,
 *   `ssh://user:<password>@host/...`). For http(s) the whole userinfo goes,
 *   since hosts accept a token as the username. For ssh/git the password goes
 *   and the login name (usually `git`) stays.
 * - Query strings and fragments (`...repo.git?token=...`).
 *
 * Accepted shapes: `https://`/`http://`, `ssh://` (with or without a port),
 * `git://`, `file://`, scp-like `[user@]host:owner/repo`, and local paths.
 * Any host is accepted, including GitHub Enterprise and self-hosted GitLab.
 */

export interface ParsedGitRemote {
  /** Lower-cased scheme (`https`, `ssh`, ...), `scp` for `[user@]host:path`, or `local` for a filesystem path. */
  readonly protocol: string;
  /** Host without userinfo or port. Null for `local` and `file` remotes. */
  readonly host: string | null;
  /** Port as written, or null. */
  readonly port: string | null;
  /** ssh/scp login name (e.g. `git`). Always null for http(s), whose username may be a token. */
  readonly user: string | null;
  /** Repository path with no leading or trailing slashes and no `.git` suffix. */
  readonly path: string;
  /** `owner/name`: the last two path segments. Null when the path has fewer than two. */
  readonly ownerRepo: string | null;
}

// scheme://[userinfo@]hostport[/path][?query][#fragment]. The userinfo group is
// greedy up to the last `@` before the path, so an unencoded `@` inside a
// password is still treated as userinfo rather than as part of the host.
const URL_FORM_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:([^/?#]*)@)?([^/?#]*)([^?#]*)/i;
// [user@]host:path, git's scp-like syntax: a `:` that comes before any `/`.
const SCP_FORM_RE = /^(?:([^/]*)@)?([^/:@]+):([^?#]*)/;
const HOST_PORT_RE = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/;
const HTTP_PROTOCOLS = new Set(['http', 'https']);
/** Protocols whose host serves a browsable web UI at `https://<host>/<path>`. */
const BROWSABLE_PROTOCOLS = new Set(['http', 'https', 'ssh', 'git+ssh', 'ssh+git', 'scp']);
/** Relative-path segments, whitespace, and control characters never form a real owner or repo name. */
function isValidSegment(segment: string): boolean {
  if (segment === '.' || segment === '..') return false;
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return !/\s/.test(segment);
}

function normalizePath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

function ownerRepoOf(path: string): string | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const pair = segments.slice(-2);
  if (!pair.every(isValidSegment)) return null;
  return pair.join('/');
}

/** Login name from a userinfo string, dropping any `:password`. */
function loginName(userinfo: string | undefined): string | null {
  if (!userinfo) return null;
  const name = userinfo.split(':')[0];
  return name ? name : null;
}

function build(
  protocol: string,
  host: string | null,
  port: string | null,
  user: string | null,
  rawPath: string,
): ParsedGitRemote {
  const path = normalizePath(rawPath);
  return { protocol, host, port, user, path, ownerRepo: ownerRepoOf(path) };
}

/**
 * Parse a git remote. Returns null for a missing, empty, or unrecognizable
 * value. Leading and trailing whitespace (e.g. the newline from `git`'s
 * stdout) is ignored.
 */
export function parseGitRemote(remote: string | null | undefined): ParsedGitRemote | null {
  if (typeof remote !== 'string') return null;
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  const url = URL_FORM_RE.exec(trimmed);
  if (url) {
    const protocol = url[1].toLowerCase();
    const hostPort = HOST_PORT_RE.exec(url[3] ?? '');
    const host = hostPort?.[1] ? hostPort[1] : null;
    const port = hostPort?.[2] ? hostPort[2] : null;
    const user = HTTP_PROTOCOLS.has(protocol) ? null : loginName(url[2]);
    return build(protocol, protocol === 'file' ? null : host, port, user, url[4] ?? '');
  }

  // A single-letter "host" is a Windows drive (`C:/repos/x`), not scp syntax.
  const scp = SCP_FORM_RE.exec(trimmed);
  if (scp && scp[2].length > 1) {
    return build('scp', scp[2], null, loginName(scp[1]), scp[3]);
  }

  return build('local', null, null, null, trimmed);
}

/** `owner/name` from a git remote, or null. See {@link ParsedGitRemote.ownerRepo}. */
export function repoNameFromRemote(remote: string | null | undefined): string | null {
  return parseGitRemote(remote)?.ownerRepo ?? null;
}

/**
 * A browsable commit URL (`https://<host>/<path>/commit/<hash>`) for a network
 * remote. Null for local, `file://`, and `git://` remotes, and for a missing
 * hash, so the UI degrades to plain text rather than a broken link. The port
 * is kept for http(s), where it is the web server's; an ssh port is dropped.
 */
export function commitUrlFromRemote(
  remote: string | null | undefined,
  hash: string | null | undefined,
): string | null {
  if (!hash) return null;
  const parsed = parseGitRemote(remote);
  if (!parsed || !parsed.host || !parsed.path) return null;
  if (!BROWSABLE_PROTOCOLS.has(parsed.protocol)) return null;
  const hostPort =
    parsed.port && HTTP_PROTOCOLS.has(parsed.protocol)
      ? `${parsed.host}:${parsed.port}`
      : parsed.host;
  return `https://${hostPort}/${parsed.path}/commit/${hash}`;
}

/**
 * The remote with its credentials, query string, and fragment removed, and
 * otherwise as written (the `.git` suffix and any trailing slash stay). Values
 * that are not a URL or scp-like remote, such as local paths, are returned
 * trimmed but unchanged. Null for a missing or empty value.
 */
export function stripRemoteCredentials(remote: string | null | undefined): string | null {
  if (typeof remote !== 'string') return null;
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  const url = URL_FORM_RE.exec(trimmed);
  if (url) {
    const protocol = url[1].toLowerCase();
    const user = HTTP_PROTOCOLS.has(protocol) ? null : loginName(url[2]);
    return `${url[1]}://${user ? `${user}@` : ''}${url[3] ?? ''}${url[4] ?? ''}`;
  }

  const scp = SCP_FORM_RE.exec(trimmed);
  if (scp && scp[2].length > 1) {
    const user = loginName(scp[1]);
    return `${user ? `${user}@` : ''}${scp[2]}:${scp[3]}`;
  }

  return trimmed;
}
