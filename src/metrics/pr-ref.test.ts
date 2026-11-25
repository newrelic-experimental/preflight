import { ghSegmentRepo, parsePrRepo, prRefOf } from './pr-ref.js';

describe('parsePrRepo', () => {
  it('lowercases an owner/repo and rejects anything else', () => {
    expect(parsePrRepo('Acme/My.App_2-x')).toBe('acme/my.app_2-x');
    expect(parsePrRepo('acme')).toBeUndefined();
    expect(parsePrRepo('a/b/c/d')).toBeUndefined();
    expect(parsePrRepo('acme/app#4')).toBeUndefined();
    expect(parsePrRepo(`${'a'.repeat(101)}/app`)).toBeUndefined();
    expect(parsePrRepo(42)).toBeUndefined();
  });
});

describe('parsePrRepo hosts', () => {
  it('keeps a host other than github.com and drops github.com', () => {
    expect(parsePrRepo('GHE.Example.com/Acme/App')).toBe('ghe.example.com/acme/app');
    expect(parsePrRepo('github.com/Acme/App')).toBe('acme/app');
    expect(parsePrRepo('ghe.example.com:8443/acme/app')).toBeUndefined();
    expect(parsePrRepo('-bad-/acme/app')).toBeUndefined();
  });

  it('gives github.com and a GHE host with one owner, repo and number two refs', () => {
    expect(prRefOf('github.com/acme/app', '7')).toBe('acme/app#7');
    expect(prRefOf('ghe.example.com/acme/app', '7')).toBe('ghe.example.com/acme/app#7');
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
    ['gh pr merge 5 -R github.example.com/acme/app', 'github.example.com/acme/app'],
    ['gh pr merge 5 -R github.com/acme/app', 'acme/app'],
    ['GH_REPO=ghe.example.com/acme/app gh pr merge 5', 'ghe.example.com/acme/app'],
    ['gh pr merge 5 -R "acme/app"', 'acme/app'],
    ['GH_REPO=acme/app gh pr merge 5', 'acme/app'],
    ['GH_REPO="Acme/App" gh pr merge 5', 'acme/app'],
    ["gh pr merge 5 -R 'acme/app'", 'acme/app'],
    ['gh pr merge 5 -Racme/app', 'acme/app'],
    ['gh pr merge 5 --body "see -R acme/other" -R acme/app', 'acme/app'],
    ['gh pr merge 5 --body "-R x" --repo acme/app', 'acme/app'],
  ])('reads the repo %s names', (segment, repo) => {
    expect(ghSegmentRepo(segment)).toBe(repo);
  });

  it.each([
    ['no repo named', 'gh pr merge 5'],
    ['a value it cannot read', 'gh pr merge 5 -R acme'],
    ['a short-flag cluster', 'gh pr merge 5 -dR acme/app'],
    ['a quoted -R in a --body value', 'gh pr merge 5 --body "see -R acme/other"'],
    ['a quoted --repo in a --subject value', "gh pr merge 5 --subject 'fix --repo=acme/other'"],
    ['a quoted GH_REPO= in a --body value', 'gh pr merge 5 --body "GH_REPO=acme/other"'],
    ['a short-flag cluster with an attached value', 'gh pr merge 5 -dRacme/app'],
    ['two repos named', 'GH_REPO=acme/one gh pr merge 5 -R acme/two'],
  ])('is null for %s', (_label, segment) => {
    expect(ghSegmentRepo(segment)).toBeNull();
  });
});
