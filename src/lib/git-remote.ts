/**
 * The one parser for git remote URLs (`git remote get-url origin` output).
 *
 * Every function here strips these credentials before returning anything:
 *
 * - URL userinfo. A login name is kept only where it is one by convention:
 *   `ssh://`, `git+ssh://`, and `ssh+git://` (case-sensitively, as git matches
 *   them) and scp-like `user@host:path`. There the name (usually `git`) stays,
 *   up to its first `:`, `@`, `/`, `?`, or `#`, and the rest of the userinfo
 *   goes. Every other scheme loses its whole userinfo, including `https://`,
 *   `git+https://`, and schemes not listed, since hosts accept a token as the
 *   username. Outside `file://`, the userinfo runs to the last `@` in the
 *   value, so an unencoded `@`, `/`, `?`, or `#` in a password cannot push
 *   part of it into the host or path.
 * - Query strings and fragments (`...repo.git?token=...`).
 *
 * A credential anywhere else, such as a token used as a path segment, is not
 * recognized here; `redactSensitive()` is the backstop for those.
 *
 * Accepted shapes: `https://`/`http://`, `ssh://` (with or without a port),
 * `git://`, `file://`, scp-like `[user@]host:owner/repo`, and local paths.
 * Any host is accepted, including GitHub Enterprise and self-hosted GitLab.
 *
 * A remote-helper remote, `<transport>::<address>`, is recognized before any
 * of those, as git recognizes it, and every function returns null for it. git
 * passes the address verbatim to `git-remote-<transport>`, so its syntax is
 * the helper's own: `ext::` takes a shell command and `codecommit::` takes
 * `region://profile@repo`. No rule here can locate a credential in it. Its
 * host also does not know git's commit hashes (git-cinnabar's Mercurial) or
 * holds only ciphertext (gcrypt), so a commit link would be broken anyway.
 */

export interface ParsedGitRemote {
  /** Lower-cased scheme (`https`, `ssh`, ...), `scp` for `[user@]host:path`, or `local` for a filesystem path. */
  readonly protocol: string;
  /** Host without userinfo or port. Null for `local` and `file` remotes. */
  readonly host: string | null;
  /** Port as written, or null. */
  readonly port: string | null;
  /** Login name (e.g. `git`) for ssh-family and scp remotes. Null for every other scheme, whose username may be a token. */
  readonly user: string | null;
  /** Repository path with no leading or trailing slashes and no `.git` suffix. */
  readonly path: string;
  /** `owner/name`: the last two path segments, or `host/name` when a remote with a host has a one-segment path (see {@link projectIdFromRemote}). Null otherwise. */
  readonly ownerRepo: string | null;
}

// scheme://[userinfo@]hostport[/path][?query][#fragment]. The userinfo is
// greedy up to the last `@` in the value. That over-strips a remote with an
// `@` in its path or query, which no git host produces, rather than letting a
// password containing `/`, `?`, or `#` split across the host and path.
const URL_FORM_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:([\s\S]*)@)?([^/?#]*)([^?#]*)/i;
// In a file:// URL an `@` after the authority is part of a local path.
const FILE_URL_RE = /^(file):\/\/(?:([^/?#]*)@)?([^/?#]*)([^?#]*)/i;
// [user@]host:path, git's scp-like syntax: a `:` with no `/` before it. The
// user runs to the last `@` that is followed by `host:`, for the same reason.
const SCP_FORM_RE = /^(?=[^/]*:)(?:([\s\S]*)@)?([^/:@]+):([^?#]*)/;
// `C:/repos/x` and `C:\repos\x` are Windows paths, not scp syntax.
const DRIVE_PATH_RE = /^[a-z]:/i;
// git's own test in transport_get() (transport.c): an optional
// `[A-Za-z0-9][A-Za-z0-9+.-]*`, then `::`.
const REMOTE_HELPER_RE = /^(?:[A-Za-z0-9][A-Za-z0-9+.-]*)?::/;
const HOST_PORT_RE = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/;
const HTTP_PROTOCOLS = new Set(['http', 'https']);
/** Schemes, as written, whose userinfo is a login name. See the module doc. */
const LOGIN_NAME_SCHEMES = new Set(['ssh', 'git+ssh', 'ssh+git']);
const SSH_PROTOCOLS = new Set(['ssh', 'git+ssh', 'ssh+git', 'scp']);
/** Protocols whose host serves a browsable web UI at `https://<host>/<path>`. */
const BROWSABLE_PROTOCOLS = new Set([...HTTP_PROTOCOLS, ...SSH_PROTOCOLS]);
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

function ownerRepoOf(host: string | null, path: string): string | null {
  // A null name matches every repo in GitEfficiencyTracker.replayTimeline(),
  // so a one-segment remote (Gerrit, cgit, gitolite) takes its host as owner.
  const segments = path.split('/').filter((s) => s.length > 0);
  let pair: string[];
  if (segments.length >= 2) pair = segments.slice(-2);
  else if (host && segments.length === 1) pair = [host, segments[0]];
  else return null;
  if (!pair.every(isValidSegment)) return null;
  return pair.join('/');
}

/**
 * The login name at the start of a userinfo string. The greedy userinfo
 * match can run through a path or query that contains an `@`, so the name
 * stops at the first character that cannot be part of one.
 */
function loginName(userinfo: string | undefined): string | null {
  if (!userinfo) return null;
  const name = /^[^:@/?#]*/.exec(userinfo)?.[0];
  return name ? name : null;
}

interface UrlFormParts {
  /** The scheme as written. */
  readonly scheme: string;
  /** The login name to keep, or null when the scheme's userinfo is dropped. */
  readonly user: string | null;
  readonly hostPort: string;
  readonly path: string;
}

function matchUrlForm(value: string): UrlFormParts | null {
  const url = FILE_URL_RE.exec(value) ?? URL_FORM_RE.exec(value);
  if (!url) return null;
  const scheme = url[1];
  return {
    scheme,
    user: LOGIN_NAME_SCHEMES.has(scheme) ? loginName(url[2]) : null,
    hostPort: url[3] ?? '',
    path: url[4] ?? '',
  };
}

function matchScpForm(value: string): RegExpExecArray | null {
  return DRIVE_PATH_RE.test(value) ? null : SCP_FORM_RE.exec(value);
}

function build(
  protocol: string,
  host: string | null,
  port: string | null,
  user: string | null,
  rawPath: string,
): ParsedGitRemote {
  const path = normalizePath(rawPath);
  return { protocol, host, port, user, path, ownerRepo: ownerRepoOf(host, path) };
}

/**
 * Parse a git remote. Returns null for a missing or empty value; see the
 * module doc for remote-helper remotes. Leading and trailing whitespace
 * (e.g. the newline from `git`'s stdout) is ignored.
 */
export function parseGitRemote(remote: string | null | undefined): ParsedGitRemote | null {
  if (typeof remote !== 'string') return null;
  const trimmed = remote.trim();
  if (trimmed.length === 0 || REMOTE_HELPER_RE.test(trimmed)) return null;

  const url = matchUrlForm(trimmed);
  if (url) {
    const protocol = url.scheme.toLowerCase();
    const hostPort = HOST_PORT_RE.exec(url.hostPort);
    const host = hostPort?.[1] ? hostPort[1] : null;
    const port = hostPort?.[2] ? hostPort[2] : null;
    return build(protocol, protocol === 'file' ? null : host, port, url.user, url.path);
  }

  const scp = matchScpForm(trimmed);
  if (scp) {
    return build('scp', scp[2], null, loginName(scp[1]), scp[3]);
  }

  return build('local', null, null, null, trimmed);
}

/** `owner/name` from a git remote, or null. See {@link ParsedGitRemote.ownerRepo}. */
export function repoNameFromRemote(remote: string | null | undefined): string | null {
  return parseGitRemote(remote)?.ownerRepo ?? null;
}

/**
 * The `project_id` inferred from a git remote: {@link repoNameFromRemote}
 * without the host. `project_id` goes on every event sent to New Relic, and a
 * host can name an internal git server, which only `repo_url` (with its own
 * opt-out) may carry. So a one-segment remote gives just its name.
 */
export function projectIdFromRemote(remote: string | null | undefined): string | null {
  const parsed = parseGitRemote(remote);
  if (!parsed?.ownerRepo) return null;
  // A one-segment path has no `/` after normalizePath(), and its ownerRepo is `host/name`.
  return parsed.path.includes('/') ? parsed.ownerRepo : parsed.path;
}

/**
 * A browsable commit URL (`https://<host>/<path>/commit/<hash>`) for a network
 * remote. Null for local, `file://`, and `git://` remotes, for an ssh or scp
 * remote with no login name, which usually names a `Host` alias from
 * `~/.ssh/config`, and for a missing hash, so the UI degrades to plain text
 * rather than a broken link. The port is kept for http(s), where it is the
 * web server's; an ssh port is dropped.
 */
export function commitUrlFromRemote(
  remote: string | null | undefined,
  hash: string | null | undefined,
): string | null {
  if (!hash) return null;
  const parsed = parseGitRemote(remote);
  if (!parsed || !parsed.host || !parsed.path) return null;
  if (!BROWSABLE_PROTOCOLS.has(parsed.protocol)) return null;
  if (SSH_PROTOCOLS.has(parsed.protocol) && !parsed.user) return null;
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
 * trimmed but unchanged. Null for a missing or empty value; see the module doc
 * for remote-helper remotes.
 */
export function stripRemoteCredentials(remote: string | null | undefined): string | null {
  if (typeof remote !== 'string') return null;
  const trimmed = remote.trim();
  if (trimmed.length === 0 || REMOTE_HELPER_RE.test(trimmed)) return null;

  const url = matchUrlForm(trimmed);
  if (url) {
    return `${url.scheme}://${url.user ? `${url.user}@` : ''}${url.hostPort}${url.path}`;
  }

  const scp = matchScpForm(trimmed);
  if (scp) {
    const user = loginName(scp[1]);
    return `${user ? `${user}@` : ''}${scp[2]}:${scp[3]}`;
  }

  return trimmed;
}
