import { redactSensitive } from '../config.js';
import {
  commitUrlFromRemote,
  parseGitRemote,
  repoNameFromRemote,
  stripRemoteCredentials,
} from './git-remote.js';

// Verbatim copies of the four parsers this module replaced (#716), kept so the
// matrix below records exactly where the shared parser's output differs.
function legacyConfigProjectId(remote: string): string | null {
  // src/config.ts inferProjectId(), applied to the already-trimmed remote.
  const match = remote.trim().match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function legacyRepoName(remote: string): string | null {
  // src/index.ts repo-context hydration and
  // src/metrics/local-session-aggregator.ts repoNameFromRemote() used the same regex.
  const match = remote.trim().match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function legacyCommitUrl(remote: string, hash: string): string | null {
  // src/metrics/local-session-aggregator.ts commitUrlFromRemote().
  if (!remote || !hash) return null;
  const trimmed = remote.trim().replace(/\.git$/, '');
  const ssh = /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+)$/.exec(trimmed);
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(trimmed);
  const match = ssh ?? https;
  if (!match) return null;
  const [, host, path] = match;
  if (!host || !path) return null;
  return `https://${host}/${path}/commit/${hash}`;
}

function legacyRepoUrl(remote: string): string | null {
  // src/config.ts: inferRepoUrl() returned the raw remote; loadMcpConfig()
  // then ran redactSensitive() on it.
  const trimmed = remote.trim();
  return trimmed === '' ? null : redactSensitive(trimmed);
}

function newRepoUrl(remote: string): string | null {
  const stripped = stripRemoteCredentials(remote);
  return stripped === null ? null : redactSensitive(stripped);
}

const HASH = 'abc1234';
const commit = (hostPath: string): string => `https://${hostPath}/commit/${HASH}`;

interface Row {
  readonly remote: string;
  /** What the old parsers returned. */
  readonly legacy: {
    readonly configProjectId: string | null;
    readonly repoName: string | null;
    readonly commitUrl: string | null;
    readonly repoUrl: string | null;
  };
  /** What the shared parser returns. */
  readonly next: {
    readonly repoName: string | null;
    readonly commitUrl: string | null;
    readonly repoUrl: string | null;
  };
}

function row(
  remote: string,
  legacy: [string | null, string | null, string | null, string | null],
  next: [string | null, string | null, string | null],
): Row {
  const [configProjectId, repoName, commitUrl, repoUrl] = legacy;
  return {
    remote,
    legacy: { configProjectId, repoName, commitUrl, repoUrl },
    next: { repoName: next[0], commitUrl: next[1], repoUrl: next[2] },
  };
}

const GH = 'github.com/acme/widgets';
// Columns: legacy [config projectId, index/aggregator repoName, commitUrl, repoUrl]
//          next   [repoName (all call sites), commitUrl, repoUrl]
const MATRIX: readonly Row[] = [
  // Unchanged: the common shapes.
  row(
    `https://${GH}.git`,
    ['acme/widgets', 'acme/widgets', commit(GH), `https://${GH}.git`],
    ['acme/widgets', commit(GH), `https://${GH}.git`],
  ),
  row(
    `https://${GH}`,
    ['acme/widgets', 'acme/widgets', commit(GH), `https://${GH}`],
    ['acme/widgets', commit(GH), `https://${GH}`],
  ),
  row(
    `http://${GH}.git`,
    ['acme/widgets', 'acme/widgets', commit(GH), `http://${GH}.git`],
    ['acme/widgets', commit(GH), `http://${GH}.git`],
  ),
  row(
    'git@github.com:acme/widgets.git',
    ['acme/widgets', 'acme/widgets', commit(GH), 'git@github.com:acme/widgets.git'],
    ['acme/widgets', commit(GH), 'git@github.com:acme/widgets.git'],
  ),
  row(
    'git@github.com:acme/widgets',
    ['acme/widgets', 'acme/widgets', commit(GH), 'git@github.com:acme/widgets'],
    ['acme/widgets', commit(GH), 'git@github.com:acme/widgets'],
  ),
  row(
    `ssh://git@${GH}.git`,
    ['acme/widgets', 'acme/widgets', commit(GH), `ssh://git@${GH}.git`],
    ['acme/widgets', commit(GH), `ssh://git@${GH}.git`],
  ),
  row(
    'git://github.com/acme/widgets.git',
    ['acme/widgets', 'acme/widgets', null, 'git://github.com/acme/widgets.git'],
    ['acme/widgets', null, 'git://github.com/acme/widgets.git'],
  ),
  row(
    '  https://github.com/acme/widgets.git\n',
    ['acme/widgets', 'acme/widgets', commit(GH), `https://${GH}.git`],
    ['acme/widgets', commit(GH), `https://${GH}.git`],
  ),
  // GitHub Enterprise and other self-hosted hosts.
  row(
    'https://source.datanerd.us/acme/widgets.git',
    [
      'acme/widgets',
      'acme/widgets',
      commit('source.datanerd.us/acme/widgets'),
      'https://source.datanerd.us/acme/widgets.git',
    ],
    [
      'acme/widgets',
      commit('source.datanerd.us/acme/widgets'),
      'https://source.datanerd.us/acme/widgets.git',
    ],
  ),
  row(
    'git@source.datanerd.us:acme/widgets.git',
    [
      'acme/widgets',
      'acme/widgets',
      commit('source.datanerd.us/acme/widgets'),
      'git@source.datanerd.us:acme/widgets.git',
    ],
    [
      'acme/widgets',
      commit('source.datanerd.us/acme/widgets'),
      'git@source.datanerd.us:acme/widgets.git',
    ],
  ),
  row(
    'https://ghe.example.com:8443/acme/widgets.git',
    [
      'acme/widgets',
      'acme/widgets',
      commit('ghe.example.com:8443/acme/widgets'),
      'https://ghe.example.com:8443/acme/widgets.git',
    ],
    [
      'acme/widgets',
      commit('ghe.example.com:8443/acme/widgets'),
      'https://ghe.example.com:8443/acme/widgets.git',
    ],
  ),
  // Nested groups: repoName stays the last two segments; the link keeps the full path.
  row(
    'https://gitlab.com/group/sub/widgets.git',
    [
      'sub/widgets',
      'sub/widgets',
      commit('gitlab.com/group/sub/widgets'),
      'https://gitlab.com/group/sub/widgets.git',
    ],
    [
      'sub/widgets',
      commit('gitlab.com/group/sub/widgets'),
      'https://gitlab.com/group/sub/widgets.git',
    ],
  ),
  row(
    'git@gitlab.com:group/sub/widgets.git',
    [
      'sub/widgets',
      'sub/widgets',
      commit('gitlab.com/group/sub/widgets'),
      'git@gitlab.com:group/sub/widgets.git',
    ],
    ['sub/widgets', commit('gitlab.com/group/sub/widgets'), 'git@gitlab.com:group/sub/widgets.git'],
  ),
  // Local remotes: a name, never a link.
  row(
    '/srv/git/acme/widgets.git',
    ['acme/widgets', 'acme/widgets', null, '/srv/git/acme/widgets.git'],
    ['acme/widgets', null, '/srv/git/acme/widgets.git'],
  ),
  row(
    'file:///srv/git/acme/widgets.git',
    ['acme/widgets', 'acme/widgets', null, 'file:///srv/git/acme/widgets.git'],
    ['acme/widgets', null, 'file:///srv/git/acme/widgets.git'],
  ),
  row(
    'C:/repos/acme/widgets',
    ['acme/widgets', 'acme/widgets', null, 'C:/repos/acme/widgets'],
    ['acme/widgets', null, 'C:/repos/acme/widgets'],
  ),
  row('../widgets', [null, null, null, '../widgets'], [null, null, '../widgets']),
  row('', [null, null, null, null], [null, null, null]),

  // CHANGED: credentials no longer reach any output.
  row(
    'https://token@github.com/acme/widgets.git',
    ['acme/widgets', 'acme/widgets', commit(GH), 'https://token@github.com/acme/widgets.git'],
    ['acme/widgets', commit(GH), `https://${GH}.git`],
  ),
  row(
    'https://user:ghp_secret@github.com/acme/widgets.git',
    ['acme/widgets', 'acme/widgets', commit(GH), '[REDACTED]/acme/widgets.git'],
    ['acme/widgets', commit(GH), `https://${GH}.git`],
  ),
  row(
    'https://oauth2:glpat-abc123@gitlab.com/acme/widgets.git',
    [
      'acme/widgets',
      'acme/widgets',
      commit('gitlab.com/acme/widgets'),
      '[REDACTED]/acme/widgets.git',
    ],
    ['acme/widgets', commit('gitlab.com/acme/widgets'), 'https://gitlab.com/acme/widgets.git'],
  ),
  row(
    'https://ghp_secret@github.com/widgets.git',
    [
      null,
      'ghp_secret@github.com/widgets',
      commit('github.com/widgets'),
      'https://ghp_secret@github.com/widgets.git',
    ],
    [null, commit('github.com/widgets'), 'https://github.com/widgets.git'],
  ),
  row(
    'https://user:p@ss@github.com/acme/widgets.git',
    [
      'acme/widgets',
      'acme/widgets',
      commit('ss@github.com/acme/widgets'),
      '[REDACTED]/acme/widgets.git',
    ],
    ['acme/widgets', commit(GH), `https://${GH}.git`],
  ),
  row(
    'https://github.com/acme/widgets.git?token=abc',
    [
      null,
      'acme/widgets.git?token=abc',
      commit('github.com/acme/widgets.git?token=abc'),
      'https://github.com/acme/widgets.git?[REDACTED]',
    ],
    ['acme/widgets', commit(GH), `https://${GH}.git`],
  ),
  row(
    'ssh://git@github.com/widgets.git',
    [
      null,
      'git@github.com/widgets',
      commit('github.com/widgets'),
      'ssh://git@github.com/widgets.git',
    ],
    [null, commit('github.com/widgets'), 'ssh://git@github.com/widgets.git'],
  ),

  // CHANGED: shapes the old parsers got wrong.
  row(
    'https://github.com/widgets',
    [
      'github.com/widgets',
      'github.com/widgets',
      commit('github.com/widgets'),
      'https://github.com/widgets',
    ],
    [null, commit('github.com/widgets'), 'https://github.com/widgets'],
  ),
  row(
    'https://github.com/acme/widgets/',
    [null, null, commit('github.com/acme/widgets/'), 'https://github.com/acme/widgets/'],
    ['acme/widgets', commit(GH), 'https://github.com/acme/widgets/'],
  ),
  row(
    'https://github.com/acme/widgets.git/',
    [null, null, commit('github.com/acme/widgets.git/'), 'https://github.com/acme/widgets.git/'],
    ['acme/widgets', commit(GH), 'https://github.com/acme/widgets.git/'],
  ),
  row(
    'git@github.com:acme/widgets.git/',
    [null, null, commit('github.com/acme/widgets.git/'), 'git@github.com:acme/widgets.git/'],
    ['acme/widgets', commit(GH), 'git@github.com:acme/widgets.git/'],
  ),
  row(
    'https://github.com/acme/widgets.GIT',
    [
      'acme/widgets.GIT',
      'acme/widgets.GIT',
      commit('github.com/acme/widgets.GIT'),
      'https://github.com/acme/widgets.GIT',
    ],
    ['acme/widgets', commit(GH), 'https://github.com/acme/widgets.GIT'],
  ),
  row(
    'ssh://git@github.com:22/acme/widgets.git',
    [
      'acme/widgets',
      'acme/widgets',
      commit('github.com/22/acme/widgets'),
      'ssh://git@github.com:22/acme/widgets.git',
    ],
    ['acme/widgets', commit(GH), 'ssh://git@github.com:22/acme/widgets.git'],
  ),
  row(
    'ssh://github.com/acme/widgets.git',
    ['acme/widgets', 'acme/widgets', null, 'ssh://github.com/acme/widgets.git'],
    ['acme/widgets', commit(GH), 'ssh://github.com/acme/widgets.git'],
  ),
  row(
    'github.com:acme/widgets.git',
    ['acme/widgets', 'acme/widgets', null, 'github.com:acme/widgets.git'],
    ['acme/widgets', commit(GH), 'github.com:acme/widgets.git'],
  ),
  // CHANGED for config.ts's projectId only: its `[\w.-]` class rejected these.
  row(
    'https://bitbucket.example.com/scm/~jdoe/widgets.git',
    [
      null,
      '~jdoe/widgets',
      commit('bitbucket.example.com/scm/~jdoe/widgets'),
      'https://bitbucket.example.com/scm/~jdoe/widgets.git',
    ],
    [
      '~jdoe/widgets',
      commit('bitbucket.example.com/scm/~jdoe/widgets'),
      'https://bitbucket.example.com/scm/~jdoe/widgets.git',
    ],
  ),
  row(
    'https://github.com/acme/my+repo.git',
    [
      null,
      'acme/my+repo',
      commit('github.com/acme/my+repo'),
      'https://github.com/acme/my+repo.git',
    ],
    ['acme/my+repo', commit('github.com/acme/my+repo'), 'https://github.com/acme/my+repo.git'],
  ),
];

describe('legacy parsers (characterization of the code #716 replaced)', () => {
  it.each(MATRIX.map((r) => [JSON.stringify(r.remote), r] as const))('%s', (_label, r) => {
    expect(legacyConfigProjectId(r.remote)).toBe(r.legacy.configProjectId);
    expect(legacyRepoName(r.remote)).toBe(r.legacy.repoName);
    expect(legacyCommitUrl(r.remote, HASH)).toBe(r.legacy.commitUrl);
    expect(legacyRepoUrl(r.remote)).toBe(r.legacy.repoUrl);
  });
});

describe('shared parser', () => {
  it.each(MATRIX.map((r) => [JSON.stringify(r.remote), r] as const))('%s', (_label, r) => {
    expect(repoNameFromRemote(r.remote)).toBe(r.next.repoName);
    expect(commitUrlFromRemote(r.remote, HASH)).toBe(r.next.commitUrl);
    expect(newRepoUrl(r.remote)).toBe(r.next.repoUrl);
  });

  it('never returns a credential from any function', () => {
    const secrets = ['ghp_secret', 'token', 'glpat-abc123', 'p@ss', 'abc?'];
    for (const r of MATRIX) {
      const outputs = [
        repoNameFromRemote(r.remote),
        commitUrlFromRemote(r.remote, HASH),
        stripRemoteCredentials(r.remote),
        JSON.stringify(parseGitRemote(r.remote)),
      ];
      for (const out of outputs) {
        for (const secret of secrets) {
          if (r.remote.includes(secret)) expect(out ?? '').not.toContain(secret);
        }
      }
    }
  });
});

describe('parseGitRemote', () => {
  it('returns null for a missing remote', () => {
    expect(parseGitRemote(null)).toBeNull();
    expect(parseGitRemote(undefined)).toBeNull();
    expect(parseGitRemote('   ')).toBeNull();
  });

  it('splits an ssh:// remote with a port', () => {
    expect(parseGitRemote('ssh://git:hunter2@ghe.example.com:2222/acme/widgets.git')).toEqual({
      protocol: 'ssh',
      host: 'ghe.example.com',
      port: '2222',
      user: 'git',
      path: 'acme/widgets',
      ownerRepo: 'acme/widgets',
    });
  });

  it('drops the http(s) username entirely, since it may be a token', () => {
    expect(parseGitRemote('https://x-access-token@github.com/acme/widgets')?.user).toBeNull();
  });

  it('keeps the scp login name', () => {
    expect(parseGitRemote('git@github.com:acme/widgets.git')).toMatchObject({
      protocol: 'scp',
      host: 'github.com',
      user: 'git',
      path: 'acme/widgets',
    });
  });

  it('handles an IPv6 host', () => {
    expect(parseGitRemote('ssh://git@[::1]:22/acme/widgets.git')).toMatchObject({
      host: '[::1]',
      port: '22',
      ownerRepo: 'acme/widgets',
    });
  });

  it('rejects owner/name segments containing whitespace', () => {
    expect(repoNameFromRemote('https://github.com/acme/wid gets')).toBeNull();
  });
});

describe('commitUrlFromRemote', () => {
  it('returns null without a hash', () => {
    expect(commitUrlFromRemote('git@github.com:acme/widgets.git', '')).toBeNull();
    expect(commitUrlFromRemote('git@github.com:acme/widgets.git', null)).toBeNull();
  });
});
