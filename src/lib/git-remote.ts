export interface ParsedGitRemote {
  readonly host: string;
  readonly path: string;
  readonly repoName: string;
  readonly safeRemoteUrl: string;
}

function repoNameFromPath(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return segments.slice(-2).join('/');
}

function stripUrlCredentials(remote: string): string {
  const authorityStart = remote.indexOf('://') + 3;
  const suffixStart = remote.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = suffixStart === -1 ? remote.length : authorityStart + suffixStart;
  const authority = remote.slice(authorityStart, authorityEnd);
  const credentialEnd = authority.lastIndexOf('@');
  if (credentialEnd === -1) return remote;
  return `${remote.slice(0, authorityStart)}[REDACTED]@${authority.slice(credentialEnd + 1)}${remote.slice(authorityEnd)}`;
}

/** Parse a git remote once, redacting URL credentials at the boundary. */
export function parseGitRemote(remote: string | null | undefined): ParsedGitRemote | null {
  if (typeof remote !== 'string') return null;
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
      const repoName = repoNameFromPath(path);
      if (!url.host || !repoName) return null;
      return {
        host: url.host,
        path,
        repoName,
        safeRemoteUrl: stripUrlCredentials(trimmed),
      };
    } catch {
      return null;
    }
  }

  const scp = /^(?:([^@/:]+)@)?([^/:]+):(.+)$/.exec(trimmed);
  if (!scp) return null;
  const user = scp[1];
  const host = scp[2];
  const rawPath = scp[3];
  const path = rawPath?.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!host || !path) return null;
  const repoName = repoNameFromPath(path);
  if (!repoName) return null;
  return {
    host,
    path,
    repoName,
    safeRemoteUrl: user ? `[REDACTED]@${host}:${rawPath}` : trimmed,
  };
}

/** Parse `owner/name` out of a git remote URL. */
export function repoNameFromRemote(remote: string | null | undefined): string | null {
  return parseGitRemote(remote)?.repoName ?? null;
}

/** Build a browsable commit URL without propagating remote credentials. */
export function commitUrlFromRemote(remote: string | null, hash: string): string | null {
  if (!hash) return null;
  const parsed = parseGitRemote(remote);
  if (!parsed) return null;
  return `https://${parsed.host}/${parsed.path}/commit/${hash}`;
}
