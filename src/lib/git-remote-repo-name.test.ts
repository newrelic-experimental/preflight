import { stripRepoNameCredentials } from './git-remote.js';

describe('stripRepoNameCredentials', () => {
  it.each([
    ['tok3n@github.com/widgets', 'github.com/widgets'],
    ['user:pass@host.example/org/repo', 'host.example/org/repo'],
    ['a@b@host/widgets', 'host/widgets'],
    ['tok3n@host', 'host'],
    ['org/repo', 'org/repo'],
    ['github.com/widgets', 'github.com/widgets'],
    ['org/repo@v2', 'org/repo@v2'],
    ['tok3n@', null],
    ['tok3n@/widgets', '/widgets'],
    ['', null],
  ])('%j -> %j', (stored, expected) => {
    expect(stripRepoNameCredentials(stored)).toBe(expected);
  });
});
