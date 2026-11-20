import { ghSegmentRepo, parsePrRepo, prRefOf } from './pr-ref.js';

describe('parsePrRepo', () => {
  it('lowercases an owner/repo and rejects anything else', () => {
    expect(parsePrRepo('Acme/My.App_2-x')).toBe('acme/my.app_2-x');
    expect(parsePrRepo('acme')).toBeUndefined();
    expect(parsePrRepo('acme/app/extra')).toBeUndefined();
    expect(parsePrRepo('acme/app#4')).toBeUndefined();
    expect(parsePrRepo(`${'a'.repeat(101)}/app`)).toBeUndefined();
    expect(parsePrRepo(42)).toBeUndefined();
  });
});

describe('prRefOf', () => {
  it('names the PR as owner/repo#N, or null when either part is unknown', () => {
    expect(prRefOf('Acme/App', '42')).toBe('acme/app#42');
    expect(prRefOf(undefined, '42')).toBeNull();
    expect(prRefOf('acme/app', null)).toBeNull();
    expect(prRefOf('acme/app', '4x')).toBeNull();
  });
});

describe('ghSegmentRepo', () => {
  it.each([
    ['gh pr merge 5 -R acme/app', 'acme/app'],
    ['gh pr merge 5 --repo Acme/App --squash', 'acme/app'],
    ['gh pr merge 5 --repo=acme/app', 'acme/app'],
    ['gh pr merge 5 -R github.example.com/acme/app', 'acme/app'],
    ['gh pr merge 5 -R "acme/app"', 'acme/app'],
    ['GH_REPO=acme/app gh pr merge 5', 'acme/app'],
  ])('reads the repo %s names', (segment, repo) => {
    expect(ghSegmentRepo(segment)).toBe(repo);
  });

  it.each([
    ['no repo named', 'gh pr merge 5'],
    ['a value it cannot read', 'gh pr merge 5 -R acme'],
    ['a short-flag cluster', 'gh pr merge 5 -dR acme/app'],
    ['two repos named', 'GH_REPO=acme/one gh pr merge 5 -R acme/two'],
  ])('is null for %s', (_label, segment) => {
    expect(ghSegmentRepo(segment)).toBeNull();
  });
});
