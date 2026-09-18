import { describe, expect, it } from '@jest/globals';
import { commitUrlFromRemote, parseGitRemote, repoNameFromRemote } from './git-remote.js';

describe('parseGitRemote', () => {
  it.each([
    ['git@github.com:acme/widgets.git', 'github.com', 'acme/widgets'],
    ['https://github.com/acme/widgets.git', 'github.com', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'github.com', 'acme/widgets'],
    [
      'https://gitlab.example.com/group/subgroup/widgets.git',
      'gitlab.example.com',
      'subgroup/widgets',
    ],
  ])('parses %s', (remote, host, repoName) => {
    expect(parseGitRemote(remote)).toMatchObject({ host, repoName });
  });

  it('redacts embedded credentials from its safe remote URL', () => {
    const parsed = parseGitRemote(
      'https://someuser:ghp_faketoken1234567890abcd@github.com/acme/widgets.git',
    );

    expect(parsed?.safeRemoteUrl).toBe('https://[REDACTED]@github.com/acme/widgets.git');
    expect(parsed?.safeRemoteUrl).not.toContain('someuser');
    expect(parsed?.safeRemoteUrl).not.toContain('ghp_faketoken1234567890abcd');
  });

  it('redacts credentials containing an at sign without leaking a suffix', () => {
    const parsed = parseGitRemote('https://someuser:p@ssword@github.com/acme/widgets.git');

    expect(parsed?.safeRemoteUrl).toBe('https://[REDACTED]@github.com/acme/widgets.git');
    expect(parsed?.safeRemoteUrl).not.toContain('ssword');
  });

  it('redacts the user component of scp-style SSH remotes', () => {
    expect(parseGitRemote('git@github.com:acme/widgets.git')?.safeRemoteUrl).toBe(
      '[REDACTED]@github.com:acme/widgets.git',
    );
  });

  it.each([null, undefined, '', '/srv/local/repo.git', 'https://github.com/owner'])(
    'rejects an unusable remote: %s',
    (remote) => {
      expect(parseGitRemote(remote)).toBeNull();
    },
  );
});

describe('git remote projections', () => {
  it('returns the owner and repository name', () => {
    expect(repoNameFromRemote('https://token@github.com/acme/widgets.git')).toBe('acme/widgets');
  });

  it('builds a credential-free commit URL', () => {
    expect(commitUrlFromRemote('https://token@github.com/acme/widgets.git', 'abc1234')).toBe(
      'https://github.com/acme/widgets/commit/abc1234',
    );
  });
});
