import { describe, it, expect } from '@jest/globals';
import {
  commitUrlFromRemote,
  parseGitRemote,
  repoNameFromRemote,
  stripRemoteCredentials,
} from './git-remote.js';

describe('stripRemoteCredentials', () => {
  it.each([
    ['https://user:token@github.com/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['https://token@github.com/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['ssh://git@github.com/acme/widgets.git', 'ssh://github.com/acme/widgets.git'],
    ['git@github.com:acme/widgets.git', 'github.com:acme/widgets.git'],
    ['https://github.com/acme/widgets.git', 'https://github.com/acme/widgets.git'],
    ['/srv/git/acme/widgets.git', '/srv/git/acme/widgets.git'],
  ])('%s -> %s', (input, expected) => {
    expect(stripRemoteCredentials(input)).toBe(expected);
  });
});

describe('repoNameFromRemote', () => {
  it.each([
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
    ['https://gitlab.com/group/subgroup/widgets.git', 'subgroup/widgets'],
    ['  https://github.com/acme/widgets.git  ', 'acme/widgets'],
  ])('parses %s', (remote, expected) => {
    expect(repoNameFromRemote(remote)).toBe(expected);
  });

  it('returns null for missing input', () => {
    expect(repoNameFromRemote(null)).toBeNull();
    expect(repoNameFromRemote(undefined)).toBeNull();
    expect(repoNameFromRemote('')).toBeNull();
  });

  // The reason this parser is shared: a naive "last two path segments" regex
  // captures the credential as the owner when the path has a single segment.
  it.each([
    'https://ghp_secrettoken@github.com/widgets.git',
    'https://user:ghp_secrettoken@github.com/acme/widgets.git',
    'https://ghp_secrettoken@github.com/acme/widgets.git',
  ])('never leaks credentials from %s', (remote) => {
    const name = repoNameFromRemote(remote);
    expect(name ?? '').not.toContain('ghp_secrettoken');
    expect(name ?? '').not.toContain('@');
  });
});

describe('commitUrlFromRemote', () => {
  const hash = 'abc1234';

  it.each([
    ['git@github.com:acme/widgets.git', `https://github.com/acme/widgets/commit/${hash}`],
    ['https://github.com/acme/widgets.git', `https://github.com/acme/widgets/commit/${hash}`],
    ['https://token@github.com/acme/widgets.git', `https://github.com/acme/widgets/commit/${hash}`],
    ['git@gitlab.com:acme/widgets.git', `https://gitlab.com/acme/widgets/commit/${hash}`],
    [
      'https://gitlab.com/group/subgroup/widgets.git',
      `https://gitlab.com/group/subgroup/widgets/commit/${hash}`,
    ],
  ])('builds %s', (remote, expected) => {
    expect(commitUrlFromRemote(remote, hash)).toBe(expected);
  });

  it('returns null without a host, a remote, or a hash', () => {
    expect(commitUrlFromRemote(null, hash)).toBeNull();
    expect(commitUrlFromRemote('/srv/local/repo.git', hash)).toBeNull();
    expect(commitUrlFromRemote('git@github.com:acme/widgets.git', '')).toBeNull();
  });

  it('keeps the full path for nested groups, not just the last two segments', () => {
    expect(commitUrlFromRemote('git@gitlab.com:group/subgroup/widgets.git', hash)).toBe(
      `https://gitlab.com/group/subgroup/widgets/commit/${hash}`,
    );
  });
});

describe('parseGitRemote', () => {
  it('splits host and path for a scheme URL', () => {
    expect(parseGitRemote('https://github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets',
      ownerRepo: 'acme/widgets',
    });
  });

  it('splits host and path for scp-like syntax', () => {
    expect(parseGitRemote('git@github.com:acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets',
      ownerRepo: 'acme/widgets',
    });
  });

  it('reports no host for a local path', () => {
    expect(parseGitRemote('/srv/git/acme/widgets.git')).toEqual({
      host: null,
      path: '/srv/git/acme/widgets',
      ownerRepo: 'acme/widgets',
    });
  });
});
