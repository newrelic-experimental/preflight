import { redactSensitive } from '../config.js';
import {
  commitUrlFromRemote,
  parseGitRemote,
  projectIdFromRemote,
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
    readonly projectId: string | null;
  };
}

function row(
  remote: string,
  legacy: [string | null, string | null, string | null, string | null],
  next: [string | null, string | null, string | null, (string | null)?],
): Row {
  const [configProjectId, repoName, commitUrl, repoUrl] = legacy;
  return {
    remote,
    legacy: { configProjectId, repoName, commitUrl, repoUrl },
    next: {
      repoName: next[0],
      commitUrl: next[1],
      repoUrl: next[2],
      projectId: next[3] === undefined ? next[0] : next[3],
    },
  };
}

const GH = 'github.com/acme/widgets';
// Columns: legacy [config projectId, index/aggregator repoName, commitUrl, repoUrl]
//          next   [repoName (index, aggregator, workspace identity), commitUrl, repoUrl,
//                  config projectId when it differs from repoName]
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
  // One path segment: the host stands in for the owner in the local repo name.
  // CHANGED: projectId keeps only the name, since the host can be internal.
  row(
    'https://github.com/widgets',
    [
      'github.com/widgets',
      'github.com/widgets',
      commit('github.com/widgets'),
      'https://github.com/widgets',
    ],
    ['github.com/widgets', commit('github.com/widgets'), 'https://github.com/widgets', 'widgets'],
  ),
  // A userless ssh or scp remote gets no link.
  row(
    'ssh://github.com/acme/widgets.git',
    ['acme/widgets', 'acme/widgets', null, 'ssh://github.com/acme/widgets.git'],
    ['acme/widgets', null, 'ssh://github.com/acme/widgets.git'],
  ),
  row(
    'github.com:acme/widgets.git',
    ['acme/widgets', 'acme/widgets', null, 'github.com:acme/widgets.git'],
    ['acme/widgets', null, 'github.com:acme/widgets.git'],
  ),

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
    [
      'github.com/widgets',
      commit('github.com/widgets'),
      'https://github.com/widgets.git',
      'widgets',
    ],
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
    [
      'github.com/widgets',
      commit('github.com/widgets'),
      'ssh://git@github.com/widgets.git',
      'widgets',
    ],
  ),
  // Remote-helper remotes (`<transport>::<address>`).
  row(
    'hg::https://user:s3cret@hg.example.com/acme/widgets',
    [
      'acme/widgets',
      'acme/widgets',
      commit('hg.example.com/acme/widgets'),
      'hg::[REDACTED]/acme/widgets',
    ],
    [null, null, null],
  ),
  row(
    'gcrypt::https://glpat-abc123@gitlab.com/widgets.git',
    [
      null,
      'glpat-abc123@gitlab.com/widgets',
      commit('gitlab.com/widgets'),
      'gcrypt::https://glpat-abc123@gitlab.com/widgets.git',
    ],
    [null, null, null],
  ),

  // CHANGED: shapes the old parsers got wrong.
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
    'git@git.example.com:widgets.git',
    [null, null, commit('git.example.com/widgets'), 'git@git.example.com:widgets.git'],
    [
      'git.example.com/widgets',
      commit('git.example.com/widgets'),
      'git@git.example.com:widgets.git',
      'widgets',
    ],
  ),
  row(
    'ssh://git@gerrit.example.com:29418/widgets',
    [
      '29418/widgets',
      'git@gerrit.example.com:29418/widgets',
      commit('gerrit.example.com/29418/widgets'),
      'ssh://git@gerrit.example.com:29418/widgets',
    ],
    [
      'gerrit.example.com/widgets',
      commit('gerrit.example.com/widgets'),
      'ssh://git@gerrit.example.com:29418/widgets',
      'widgets',
    ],
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
    expect(projectIdFromRemote(r.remote)).toBe(r.next.projectId);
  });

  it('never returns a credential from any function', () => {
    const secrets = ['ghp_secret', 'token', 'glpat-abc123', 'p@ss', 's3cret'];
    for (const r of MATRIX) {
      const outputs = [
        repoNameFromRemote(r.remote),
        projectIdFromRemote(r.remote),
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

// [remote, stripRemoteCredentials output, secrets no function may return]
const USERINFO_CASES: readonly (readonly [string, string | null, readonly string[]])[] = [
  // Every scheme outside the ssh family loses its whole userinfo.
  [
    'git+https://opaquetoken123@gitlab.example.com/org/repo.git',
    'git+https://gitlab.example.com/org/repo.git',
    ['opaquetoken123'],
  ],
  [
    'git+http://alice:hunter2@gitlab.example.com/org/repo.git',
    'git+http://gitlab.example.com/org/repo.git',
    ['alice', 'hunter2'],
  ],
  [
    'HTTPS://opaquetoken123@github.com/acme/widgets.git',
    'HTTPS://github.com/acme/widgets.git',
    ['opaquetoken123'],
  ],
  [
    'Git+Https://opaquetoken123@github.com/acme/widgets.git',
    'Git+Https://github.com/acme/widgets.git',
    ['opaquetoken123'],
  ],
  [
    'htps://opaquetoken123@github.com/acme/widgets.git',
    'htps://github.com/acme/widgets.git',
    ['opaquetoken123'],
  ],
  [
    'gitlab-ci://opaquetoken123@gitlab.example.com/org/repo.git',
    'gitlab-ci://gitlab.example.com/org/repo.git',
    ['opaquetoken123'],
  ],
  [
    'git://opaquetoken123@git.example.com/org/repo.git',
    'git://git.example.com/org/repo.git',
    ['opaquetoken123'],
  ],
  ['file://opaquetoken123@nas/srv/org/repo.git', 'file://nas/srv/org/repo.git', ['opaquetoken123']],
  // git matches `ssh` case-sensitively, so an uppercase scheme is not ssh.
  [
    'SSH://deploy:hunter2@ghe.example.com/acme/widgets.git',
    'SSH://ghe.example.com/acme/widgets.git',
    ['deploy', 'hunter2'],
  ],
  // An unencoded `/`, `?`, or `#` in the userinfo does not split it.
  [
    'https://alice:hun/ter2@github.com/acme/widgets.git',
    'https://github.com/acme/widgets.git',
    ['alice', 'hun', 'ter2'],
  ],
  [
    'https://opaque/token123@github.com/acme/widgets.git',
    'https://github.com/acme/widgets.git',
    ['opaque', 'token123'],
  ],
  [
    'https://alice:hun?ter2@github.com/acme/widgets.git',
    'https://github.com/acme/widgets.git',
    ['alice', 'hun', 'ter2'],
  ],
  [
    'https://alice:hun#ter2@github.com/acme/widgets.git',
    'https://github.com/acme/widgets.git',
    ['alice', 'hun', 'ter2'],
  ],
  [
    'git+https://alice:p@ss/w0rd@gitlab.example.com/org/repo.git',
    'git+https://gitlab.example.com/org/repo.git',
    ['alice', 'p@ss', 'w0rd'],
  ],
  // The ssh family and scp syntax keep the login name and drop the password.
  [
    'ssh://git:hunter2@ghe.example.com:2222/acme/widgets.git',
    'ssh://git@ghe.example.com:2222/acme/widgets.git',
    ['hunter2'],
  ],
  [
    'git+ssh://git:hunter2@github.com/acme/widgets.git',
    'git+ssh://git@github.com/acme/widgets.git',
    ['hunter2'],
  ],
  ['ssh+git://git@github.com/acme/widgets.git', 'ssh+git://git@github.com/acme/widgets.git', []],
  [
    'ssh://git:hun/ter2@github.com/acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
    ['hun', 'ter2'],
  ],
  [
    'deploy:hun/ter2@github.com:acme/widgets.git',
    'deploy@github.com:acme/widgets.git',
    ['hun', 'ter2'],
  ],
  // The greedy userinfo runs through the query; the login name stops at `@`.
  ['ssh://git@github.com/acme/widgets.git?auth=s3cret@x', 'ssh://git@x', ['auth=', 's3cret']],
  // Remote-helper remotes (`<transport>::<address>`).
  ['hg::https://user:s3cret@hg.example.com/acme/widgets', null, ['user:', 's3cret']],
  ['gcrypt::https://glpat-abc123@gitlab.com/widgets.git', null, ['glpat-abc123']],
  ['gcrypt::deploy:hunter2@gitlab.com:acme/widgets.git', null, ['hunter2']],
  ['codecommit::us-east-1://deploy:hunter2@widgets', null, ['hunter2']],
  [
    'persistent-https::https://opaquetoken123@ghe.example.com/acme/widgets',
    null,
    ['opaquetoken123'],
  ],
  ['ext::sshpass -p hunter2 ssh git@git.example.com %S acme/widgets', null, ['hunter2']],
  ['::https://opaquetoken123@github.com/acme/widgets.git', null, ['opaquetoken123']],
  // An `@` in a local path is not userinfo.
  ['file:///home/me/@work/repo.git', 'file:///home/me/@work/repo.git', []],
  ['/home/me/@work/repo.git', '/home/me/@work/repo.git', []],
  ['C:/repos/a@bb:c', 'C:/repos/a@bb:c', []],
];

describe('userinfo handling', () => {
  it.each(USERINFO_CASES)('%s', (remote, stripped, secrets) => {
    expect(stripRemoteCredentials(remote)).toBe(stripped);
    const outputs = [
      repoNameFromRemote(remote),
      projectIdFromRemote(remote),
      commitUrlFromRemote(remote, HASH),
      stripRemoteCredentials(remote),
      JSON.stringify(parseGitRemote(remote)),
    ];
    for (const out of outputs) {
      for (const secret of secrets) expect(out ?? '').not.toContain(secret);
    }
  });

  it('parses the host and path after a userinfo containing `/`', () => {
    expect(parseGitRemote('https://alice:hun/ter2@github.com/acme/widgets.git')).toEqual({
      protocol: 'https',
      host: 'github.com',
      port: null,
      user: null,
      path: 'acme/widgets',
      ownerRepo: 'acme/widgets',
    });
    expect(commitUrlFromRemote('https://alice:hun/ter2@github.com/acme/widgets.git', HASH)).toBe(
      commit(GH),
    );
  });

  it('keeps no user for a git+https remote', () => {
    expect(
      parseGitRemote('git+https://opaquetoken123@gitlab.example.com/org/repo.git'),
    ).toMatchObject({
      protocol: 'git+https',
      host: 'gitlab.example.com',
      user: null,
      ownerRepo: 'org/repo',
    });
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

  it.each([
    'hg::https://hg.example.com/acme/widgets',
    'gcrypt::git@gitlab.com:acme/widgets.git',
    'codecommit::us-east-1://widgets',
    '::https://github.com/acme/widgets.git',
  ])('returns nothing for the remote-helper remote %s', (remote) => {
    expect(parseGitRemote(remote)).toBeNull();
    expect(repoNameFromRemote(remote)).toBeNull();
    expect(projectIdFromRemote(remote)).toBeNull();
    expect(commitUrlFromRemote(remote, HASH)).toBeNull();
    expect(stripRemoteCredentials(remote)).toBeNull();
  });

  it('rejects owner/name segments containing whitespace', () => {
    expect(repoNameFromRemote('https://github.com/acme/wid gets')).toBeNull();
  });
});

describe('projectIdFromRemote', () => {
  it.each([
    'https://git.corp.internal/widgets.git',
    'git://git.corp.internal/widgets.git',
    'ssh://git@git.corp.internal/widgets',
    'ssh://git@git.corp.internal:29418/widgets',
    'git@git.corp.internal:widgets.git',
    'git.corp.internal:widgets.git',
  ])('keeps the host of the one-segment remote %s out', (remote) => {
    expect(repoNameFromRemote(remote)).toBe('git.corp.internal/widgets');
    expect(projectIdFromRemote(remote)).toBe('widgets');
  });

  it('gives no name for a one-segment local path, as before', () => {
    expect(projectIdFromRemote('widgets')).toBeNull();
    expect(projectIdFromRemote('file:///widgets.git')).toBeNull();
  });
});

describe('commitUrlFromRemote', () => {
  it('returns null without a hash', () => {
    expect(commitUrlFromRemote('git@github.com:acme/widgets.git', '')).toBeNull();
    expect(commitUrlFromRemote('git@github.com:acme/widgets.git', null)).toBeNull();
  });
});
