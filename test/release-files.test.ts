import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  VERSION_FILES,
  changesetReleases,
  dateNewEntries,
  findBranchProblems,
  findDroppedReleases,
  findPendingReleases,
  findReleaseBlockers,
  findReleaseEdits,
  findVersionMismatches,
  isMainModule,
  parseCommand,
  readPackageJson,
  readChangesetsAtCommit,
  readPendingChangesets,
  releaseHeadings,
  releasedEntries,
  setVersion,
  syncedFiles,
  type ReadFile,
} from '../scripts/release-files.js';

const repoRoot = resolve(__dirname, '..');

const INTRO = '# Changelog\n\nAll notable changes to this project are documented in this file.\n';

function makeChangelog(...entries: string[]): string {
  return [INTRO, ...entries].join('\n');
}

const RELEASED_ENTRY = '## 1.63.1 - 2026-10-08\n\n### Fixed\n\n- An older fix.\n';

/** What `changeset version` leaves at the top of the file, before `sync` dates it. */
const NEW_ENTRY = '## 1.64.0\n\n### Minor Changes\n\n- A new feature.\n\n  Second paragraph.\n';

function versionFile(path: string): (typeof VERSION_FILES)[number] {
  const file = VERSION_FILES.find((f) => f.path === path);
  if (!file) throw new Error(`no VERSION_FILES entry for ${path}`);
  return file;
}

/** A repo whose files all carry `version`, as release-files.ts reads them. */
function makeFiles(
  version: string,
  changelog = makeChangelog(RELEASED_ENTRY),
): Map<string, string> {
  return new Map([
    ['package.json', `{\n  "name": "@newrelic/preflight",\n  "version": "${version}"\n}\n`],
    [
      'package-lock.json',
      JSON.stringify(
        {
          name: '@newrelic/preflight',
          version,
          lockfileVersion: 3,
          packages: {
            '': { name: '@newrelic/preflight', version },
            'node_modules/zod': { version: '4.4.3' },
          },
        },
        null,
        2,
      ) + '\n',
    ],
    [
      'server.json',
      JSON.stringify(
        {
          name: 'io.github.newrelic-experimental/preflight',
          version,
          packages: [{ registryType: 'npm', identifier: '@newrelic/preflight', version }],
        },
        null,
        2,
      ) + '\n',
    ],
    [
      'plugin/.claude-plugin/plugin.json',
      `{\n  "name": "newrelic-preflight",\n  "version": "${version}",\n  "keywords": ["observability", "mcp"]\n}\n`,
    ],
    ['kiro-power/plugin.json', `{\n  "name": "preflight",\n  "version": "${version}"\n}\n`],
    ['CHANGELOG.md', changelog],
  ]);
}

function makeReader(files: Map<string, string>): ReadFile {
  return (path) => {
    const contents = files.get(path);
    if (contents === undefined) throw new Error(`no fixture for ${path}`);
    return contents;
  };
}

function withPackageVersion(files: Map<string, string>, version: string): Map<string, string> {
  const copy = new Map(files);
  copy.set('package.json', `{\n  "name": "@newrelic/preflight",\n  "version": "${version}"\n}\n`);
  return copy;
}

describe('releaseHeadings', () => {
  it('lists release headings newest first, with their dates', () => {
    expect(releaseHeadings(makeChangelog(NEW_ENTRY, RELEASED_ENTRY))).toEqual([
      { version: '1.64.0', date: undefined },
      { version: '1.63.1', date: '2026-10-08' },
    ]);
  });

  it('reads prerelease versions', () => {
    expect(releaseHeadings('## 2.0.0-beta.1 - 2026-11-01\n')).toEqual([
      { version: '2.0.0-beta.1', date: '2026-11-01' },
    ]);
  });

  it('ignores the legacy bracketed headings and lower-level headings', () => {
    expect(releaseHeadings('## [1.0.0] - 2026-06-23\n\n### 1.0 notes\n')).toEqual([]);
  });
});

describe('dateNewEntries', () => {
  it('dates the heading changeset version added and leaves dated ones alone', () => {
    const dated = dateNewEntries(makeChangelog(NEW_ENTRY, RELEASED_ENTRY), '2026-10-09');
    expect(releaseHeadings(dated)).toEqual([
      { version: '1.64.0', date: '2026-10-09' },
      { version: '1.63.1', date: '2026-10-08' },
    ]);
    expect(dated).toBe(
      makeChangelog(NEW_ENTRY.replace('## 1.64.0', '## 1.64.0 - 2026-10-09'), RELEASED_ENTRY),
    );
  });
});

describe('releasedEntries', () => {
  it('excludes the introduction', () => {
    const edited = makeChangelog(RELEASED_ENTRY).replace('documented', 'recorded');
    expect(releasedEntries(edited)).toBe(releasedEntries(makeChangelog(RELEASED_ENTRY)));
  });

  it('treats a legacy bracketed heading as the same release', () => {
    const legacy = makeChangelog(RELEASED_ENTRY.replace('## 1.63.1', '## [1.63.1]'));
    expect(releasedEntries(legacy)).toBe(releasedEntries(makeChangelog(RELEASED_ENTRY)));
  });

  it('includes an Unreleased section added above the releases', () => {
    const unreleased = makeChangelog('## [Unreleased]\n\n- Not yet.\n', RELEASED_ENTRY);
    expect(releasedEntries(unreleased)).not.toBe(releasedEntries(makeChangelog(RELEASED_ENTRY)));
  });
});

describe('setVersion', () => {
  it('bumps only the root package in package-lock.json, in npm layout', () => {
    const lock = makeFiles('1.63.1').get('package-lock.json') ?? '';
    const bumped = JSON.parse(
      setVersion(versionFile('package-lock.json'), lock, '1.64.0', '@newrelic/preflight'),
    );
    expect(bumped.version).toBe('1.64.0');
    expect(bumped.packages[''].version).toBe('1.64.0');
    expect(bumped.packages['node_modules/zod'].version).toBe('4.4.3');
  });

  it('keeps the layout Prettier gave a file it edits in place', () => {
    const manifest = makeFiles('1.63.1').get('plugin/.claude-plugin/plugin.json') ?? '';
    expect(
      setVersion(
        versionFile('plugin/.claude-plugin/plugin.json'),
        manifest,
        '1.64.0',
        '@newrelic/preflight',
      ),
    ).toBe(manifest.replace('"version": "1.63.1"', '"version": "1.64.0"'));
  });

  it('bumps the server and its npm package in server.json', () => {
    const server = makeFiles('1.63.1').get('server.json') ?? '';
    const bumped = JSON.parse(
      setVersion(versionFile('server.json'), server, '1.64.0', '@newrelic/preflight'),
    );
    expect(bumped.version).toBe('1.64.0');
    expect(bumped.packages[0].version).toBe('1.64.0');
  });

  it('refuses an in-place edit that would change a version the release does not own', () => {
    const server = JSON.stringify(
      {
        version: '1.63.1',
        packages: [
          { registryType: 'npm', identifier: '@newrelic/preflight', version: '1.63.1' },
          { registryType: 'oci', identifier: 'example', version: '0.1.0' },
        ],
      },
      null,
      2,
    );
    expect(() =>
      setVersion(versionFile('server.json'), server, '1.64.0', '@newrelic/preflight'),
    ).toThrow(/isn't the package's version/);
  });

  it('fails when server.json has no npm entry for the package', () => {
    const server = JSON.stringify({ version: '1.63.1', packages: [] });
    expect(() =>
      setVersion(versionFile('server.json'), server, '1.64.0', '@newrelic/preflight'),
    ).toThrow(/no npm package entry/);
  });
});

describe('syncedFiles', () => {
  it('carries the bumped package.json version everywhere and dates the new entry', () => {
    const files = withPackageVersion(
      makeFiles('1.63.1', makeChangelog(NEW_ENTRY, RELEASED_ENTRY)),
      '1.64.0',
    );
    const updates = syncedFiles(makeReader(files), '2026-10-09');

    expect([...updates.keys()].sort()).toEqual(
      [...VERSION_FILES.map((f) => f.path), 'CHANGELOG.md'].sort(),
    );
    const synced = new Map([...files, ...updates]);
    expect(findVersionMismatches(makeReader(synced))).toEqual([]);
    expect(releaseHeadings(synced.get('CHANGELOG.md') ?? '')[0]).toEqual({
      version: '1.64.0',
      date: '2026-10-09',
    });
  });

  it('changes nothing when every file already agrees', () => {
    expect(syncedFiles(makeReader(makeFiles('1.63.1')), '2026-10-09').size).toBe(0);
  });
});

describe('findVersionMismatches', () => {
  it('passes when every file agrees with package.json', () => {
    expect(findVersionMismatches(makeReader(makeFiles('1.63.1')))).toEqual([]);
  });

  it('names each file and field that disagrees', () => {
    const files = makeFiles('1.63.1');
    files.set(
      'kiro-power/plugin.json',
      (files.get('kiro-power/plugin.json') ?? '').replace('1.63.1', '1.62.0'),
    );
    expect(findVersionMismatches(makeReader(files))).toEqual([
      'kiro-power/plugin.json version is "1.62.0", but package.json is at 1.63.1.',
    ]);
  });

  it('flags a bump that has no CHANGELOG entry', () => {
    const files = withPackageVersion(makeFiles('1.63.1'), '1.64.0');
    const synced = new Map([...files, ...syncedFiles(makeReader(files), '2026-10-09')]);
    expect(findVersionMismatches(makeReader(synced))).toEqual([
      "CHANGELOG.md's newest entry is for 1.63.1, but package.json is at 1.64.0.",
    ]);
  });

  it('flags a new entry that sync has not dated', () => {
    const files = makeFiles('1.64.0', makeChangelog(NEW_ENTRY, RELEASED_ENTRY));
    expect(findVersionMismatches(makeReader(files))).toEqual([
      "CHANGELOG.md's 1.64.0 heading has no date.",
    ]);
  });
});

function makeChangeset(bump: string | undefined, summary = 'A change.'): string {
  return `---\n${bump ? `'@newrelic/preflight': ${bump}\n` : ''}---\n\n${summary}\n`;
}

describe('findDroppedReleases', () => {
  const base = new Map([
    ['fix.md', makeChangeset('patch')],
    ['feature.md', makeChangeset('minor')],
    ['tooling.md', makeChangeset(undefined)],
  ]);

  it('passes a PR that adds changesets, raises a bump, or only edits the text', () => {
    const head = new Map([
      ['fix.md', makeChangeset('minor')],
      ['feature.md', makeChangeset('minor', 'Reworded.')],
      ['tooling.md', makeChangeset(undefined)],
      ['new.md', makeChangeset('patch')],
    ]);
    expect(findDroppedReleases(base, head)).toEqual([]);
  });

  it('passes a PR that renames a changeset without changing it', () => {
    const head = new Map(base);
    head.delete('feature.md');
    head.set('feature-renamed.md', makeChangeset('minor'));
    expect(findDroppedReleases(base, head)).toEqual([]);
  });

  it("passes a PR that deletes one and rewrites another to the deleted one's text", () => {
    // fix.md now carries feature.md's minor release, and its own patch is raised, not lost.
    const head = new Map(base);
    head.delete('feature.md');
    head.set('fix.md', makeChangeset('minor'));
    expect(findDroppedReleases(base, head)).toEqual([]);
  });

  it('counts identical changesets, so folding two into one file drops one', () => {
    const twins = new Map([
      ['a.md', makeChangeset('patch', 'Same.')],
      ['c.md', makeChangeset('patch', 'Same.')],
    ]);
    const folded = new Map([['b.md', makeChangeset('patch', 'Same.')]]);
    expect(findDroppedReleases(twins, folded)).toEqual([
      expect.stringMatching(/^\.changeset\/c\.md was deleted, dropping its patch release/),
    ]);
  });

  it('passes a PR that deletes an empty changeset, which drops nothing', () => {
    const head = new Map(base);
    head.delete('tooling.md');
    expect(findDroppedReleases(base, head)).toEqual([]);
  });

  it('flags a deleted, emptied, or lowered release', () => {
    const head = new Map([
      ['fix.md', makeChangeset(undefined)],
      ['tooling.md', makeChangeset(undefined)],
    ]);
    const problems = findDroppedReleases(base, head);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^\.changeset\/feature\.md was deleted, dropping its minor release of @newrelic\/preflight; \.changeset\/fix\.md lowered @newrelic\/preflight from patch to none\./,
    );

    const lowered = findDroppedReleases(
      base,
      new Map([...base, ['feature.md', makeChangeset('patch')]]),
    );
    expect(lowered[0]).toMatch(
      /^\.changeset\/feature\.md lowered @newrelic\/preflight from minor to patch\./,
    );
  });
});

describe('findBranchProblems', () => {
  it('fails the PR that adds a changeset this script cannot read', () => {
    const files = makeReader(makeFiles('1.63.1'));
    const problems = findBranchProblems(
      { read: files, changesets: new Map() },
      { read: files, changesets: new Map([['odd.md', "---\n'@newrelic/preflight': soon\n---\n"]]) },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^\.changeset\/odd\.md has a frontmatter line this script can't read/,
    );
  });

  describe('when an unreadable changeset is already on main', () => {
    const files = makeReader(makeFiles('1.63.1'));
    const odd = "---\n'@newrelic/preflight': soon\n---\n";
    const onMain = { read: files, changesets: new Map([['odd.md', odd]]) };

    // Only a maintainer merging over the check gets one there. npm test's repo-wide parse fails
    // every PR then too, so this check fails them the same way until one fixes it.
    it("fails a PR that doesn't touch it", () => {
      const unrelated = new Map([
        ['odd.md', odd],
        ['other.md', makeChangeset('patch')],
      ]);
      expect(findBranchProblems(onMain, { read: files, changesets: unrelated })).toEqual([
        expect.stringMatching(/^\.changeset\/odd\.md has a frontmatter line/),
      ]);
    });

    it('passes the PR that fixes it', () => {
      const fixed = new Map([['odd.md', makeChangeset('patch')]]);
      expect(findBranchProblems(onMain, { read: files, changesets: fixed })).toEqual([]);
    });

    it('fails a PR that edits it and leaves it unreadable', () => {
      const stillOdd = new Map([['odd.md', `${odd}\nReworded.\n`]]);
      expect(findBranchProblems(onMain, { read: files, changesets: stillOdd })).toEqual([
        expect.stringMatching(/^\.changeset\/odd\.md has a frontmatter line/),
      ]);
    });
  });

  it('compares the merge base with the head, not the other way round', () => {
    const files = makeReader(makeFiles('1.63.1'));
    const problems = findBranchProblems(
      { read: files, changesets: new Map([['fix.md', makeChangeset('patch')]]) },
      { read: files, changesets: new Map() },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^\.changeset\/fix\.md was deleted/);
  });

  it('reports a hand bump, a dropped release, and a missing CHANGELOG entry together', () => {
    const problems = findBranchProblems(
      {
        read: makeReader(makeFiles('1.63.1')),
        changesets: new Map([['fix.md', makeChangeset('patch')]]),
      },
      { read: makeReader(makeFiles('1.63.2')), changesets: new Map() },
    );
    expect(problems).toEqual([
      expect.stringMatching(/^package\.json's version changed from 1\.63\.1 to 1\.63\.2/),
      expect.stringMatching(/^\.changeset\/fix\.md was deleted/),
      "CHANGELOG.md's newest entry is for 1.63.1, but package.json is at 1.63.2.",
    ]);
  });
});

describe('readChangesetsAtCommit', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'release-files-git-')));
    // Git sets GIT_DIR, GIT_INDEX_FILE and the like for hooks, and `npm test` runs from the
    // pre-push hook. Inherited, they would point every git command here, including `init` and
    // `config`, at the repository being pushed instead of this temporary one. So every git
    // command here gets an environment with no GIT_* variables, and HOME set to the temporary
    // directory so the user's global config (commit signing, say) doesn't apply either.
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      HOME: dir,
      // Git also reads $XDG_CONFIG_HOME/git/config as global config.
      XDG_CONFIG_HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, env, stdio: 'pipe', encoding: 'utf8' });
    git('init', '-q');
    if (git('rev-parse', '--absolute-git-dir').trim() !== join(dir, '.git')) {
      throw new Error(`git init in ${dir} didn't create a repository there; refusing to go on`);
    }
    // A temporary repo's own identity, set with --local so it can never land anywhere else.
    git('config', '--local', 'user.email', 'test@example.com');
    git('config', '--local', 'user.name', 'test');
    writeFileSync(join(dir, 'README.md'), '# Repo\n');
    git('add', '-A');
    git('commit', '-qm', 'before changesets');
    mkdirSync(join(dir, '.changeset', 'pre'), { recursive: true });
    writeFileSync(join(dir, '.changeset', 'README.md'), '# Changesets\n');
    writeFileSync(join(dir, '.changeset', 'config.json'), '{}\n');
    writeFileSync(join(dir, '.changeset', 'pre', 'used.md'), makeChangeset('patch'));
    writeFileSync(join(dir, '.changeset', 'fix.md'), makeChangeset('patch'));
    writeFileSync(join(dir, '.changeset', 'ünïcode.md'), makeChangeset('minor'));
    git('add', '-A');
    git('commit', '-qm', 'changesets');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the changesets committed at a commit, the way the working tree is read', () => {
    const atCommit = readChangesetsAtCommit('HEAD', { cwd: dir, env });
    expect([...atCommit.keys()].sort()).toEqual(['fix.md', 'ünïcode.md']);
    expect(atCommit).toEqual(readPendingChangesets(join(dir, '.changeset')));
  });

  it('finds none at a commit from before .changeset/ existed', () => {
    expect(readChangesetsAtCommit('HEAD~1', { cwd: dir, env }).size).toBe(0);
  });
});

describe('changesetReleases', () => {
  it('reads the bump a changeset asks for, quoted either way or not at all', () => {
    expect(changesetReleases("---\n'@newrelic/preflight': minor\n---\n\nNew.\n", 'a.md')).toEqual(
      new Map([['@newrelic/preflight', 'minor']]),
    );
    expect(changesetReleases('---\r\n"@newrelic/preflight": patch\r\n---\r\n', 'b.md')).toEqual(
      new Map([['@newrelic/preflight', 'patch']]),
    );
    expect(changesetReleases('---\npreflight: major # breaking\n---\n', 'c.md')).toEqual(
      new Map([['preflight', 'major']]),
    );
  });

  it('reads a quoted bump, which Changesets accepts too', () => {
    expect(changesetReleases("---\n'@newrelic/preflight': 'minor'\n---\n", 'd.md')).toEqual(
      new Map([['@newrelic/preflight', 'minor']]),
    );
    expect(changesetReleases('---\n"@newrelic/preflight": "patch"\n---\n', 'e.md')).toEqual(
      new Map([['@newrelic/preflight', 'patch']]),
    );
  });

  it('reads an empty changeset as releasing nothing', () => {
    expect(changesetReleases('---\n---\n\nTooling only.\n', 'empty.md').size).toBe(0);
  });

  it('throws on frontmatter it cannot read instead of guessing', () => {
    expect(() => changesetReleases('No frontmatter.\n', 'bad.md')).toThrow(/bad.md/);
    expect(() => changesetReleases('---\n- a list\n---\n', 'list.md')).toThrow(/list.md/);
  });

  it('throws when it names a package twice instead of picking one bump', () => {
    const twice = "---\n'@newrelic/preflight': major\n'@newrelic/preflight': patch\n---\n";
    expect(() => changesetReleases(twice, 'twice.md')).toThrow(
      /twice\.md names @newrelic\/preflight more than once/,
    );
    // The same key written with a space before the colon is still the same key.
    const spaced = '---\npreflight : major\npreflight: patch\n---\n';
    expect(() => changesetReleases(spaced, 'spaced.md')).toThrow(/names preflight more than once/);
    // But a quoted key with a space inside is a different key, as it is to YAML.
    const quoted = "---\n'preflight ': major\npreflight: patch\n---\n";
    expect(changesetReleases(quoted, 'quoted.md')).toEqual(
      new Map([
        ['preflight ', 'major'],
        ['preflight', 'patch'],
      ]),
    );
  });
});

describe('findPendingReleases', () => {
  it('passes when nothing is pending, or only empty and none-bump changesets', () => {
    expect(findPendingReleases(new Map(), '1.64.0')).toEqual([]);
    expect(
      findPendingReleases(
        new Map([
          ['empty.md', '---\n---\n\nTooling.\n'],
          ['none.md', "---\n'@newrelic/preflight': none\n---\n\nNothing.\n"],
        ]),
        '1.64.0',
      ),
    ).toEqual([]);
  });

  it('names each changeset that would ship without a CHANGELOG entry', () => {
    const problems = findPendingReleases(
      new Map([
        ['late-fix.md', "---\n'@newrelic/preflight': patch\n---\n\nA fix.\n"],
        ['empty.md', '---\n---\n'],
      ]),
      '1.64.0',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^\.changeset\/late-fix\.md is waiting for a release/);
    expect(problems[0]).toContain('the 1.64.0 CHANGELOG entry leaves it out');
  });
});

describe('findReleaseEdits', () => {
  const base = makeReader(makeFiles('1.63.1'));

  it('passes a branch that leaves the version and released entries alone', () => {
    const files = makeFiles('1.63.1');
    files.set('.changeset/new-feature.md', '---\n"@newrelic/preflight": minor\n---\n\nNew.\n');
    expect(findReleaseEdits(base, makeReader(files))).toEqual([]);
  });

  it('flags a hand-bumped version', () => {
    const problems = findReleaseEdits(base, makeReader(makeFiles('1.63.2')));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^package.json's version changed from 1.63.1 to 1.63.2/);
  });

  it('flags a hand-written CHANGELOG entry', () => {
    const head = makeReader(makeFiles('1.63.1', makeChangelog(NEW_ENTRY, RELEASED_ENTRY)));
    const problems = findReleaseEdits(base, head);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^CHANGELOG.md changed below its introduction/);
  });

  it('flags a bullet added under an already-released heading', () => {
    const head = makeReader(
      makeFiles('1.63.1', makeChangelog(`${RELEASED_ENTRY}- Slipped in later.\n`)),
    );
    expect(findReleaseEdits(base, head)).toHaveLength(1);
  });

  it('passes a base from before the switch to unbracketed headings', () => {
    const legacyBase = makeReader(
      makeFiles('1.63.1', makeChangelog(RELEASED_ENTRY.replace('## 1.63.1', '## [1.63.1]'))),
    );
    expect(findReleaseEdits(legacyBase, makeReader(makeFiles('1.63.1')))).toEqual([]);
  });
});

describe('readPendingChangesets', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-files-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads only the changesets, not the README, config, or prerelease folder', () => {
    writeFileSync(join(dir, 'README.md'), '# Changesets\n');
    writeFileSync(join(dir, 'config.json'), '{}\n');
    writeFileSync(join(dir, 'changelog.mjs'), 'export default {};\n');
    mkdirSync(join(dir, 'pre'));
    writeFileSync(join(dir, 'pre', 'used.md'), "---\n'@newrelic/preflight': patch\n---\n");
    writeFileSync(join(dir, 'fix.md'), "---\n'@newrelic/preflight': patch\n---\n\nA fix.\n");

    expect([...readPendingChangesets(dir)]).toEqual([
      ['fix.md', "---\n'@newrelic/preflight': patch\n---\n\nA fix.\n"],
    ]);
  });
});

describe('findReleaseBlockers', () => {
  it('passes a release commit whose only pending changesets are empty', () => {
    const changesets = new Map([['tooling.md', '---\n---\n\nTooling only.\n']]);
    expect(findReleaseBlockers(makeReader(makeFiles('1.63.1')), changesets)).toEqual([]);
  });

  it('blocks a commit with a changeset it cannot read, and says how to fix it', () => {
    const changesets = new Map([['odd.md', "---\n'@newrelic/preflight': soon\n---\n"]]);
    expect(findReleaseBlockers(makeReader(makeFiles('1.63.1')), changesets)).toEqual([
      expect.stringMatching(
        /^\.changeset\/odd\.md has a frontmatter line .* Write each bump as `'@newrelic\/preflight': patch`/,
      ),
    ]);
  });

  it('blocks a commit where a changeset merged after the release PR', () => {
    const changesets = new Map([['late.md', "---\n'@newrelic/preflight': patch\n---\n\nLate.\n"]]);
    const blockers = findReleaseBlockers(makeReader(makeFiles('1.63.1')), changesets);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/^\.changeset\/late\.md is waiting for a release/);
  });

  it('reports a version file that disagrees along with a pending changeset', () => {
    const files = withPackageVersion(makeFiles('1.63.1'), '1.64.0');
    const changesets = new Map([['late.md', "---\n'@newrelic/preflight': patch\n---\n\nLate.\n"]]);
    const blockers = findReleaseBlockers(makeReader(files), changesets);
    expect(blockers).toEqual(expect.arrayContaining(findVersionMismatches(makeReader(files))));
    expect(blockers).toContainEqual(expect.stringMatching(/late\.md is waiting for a release/));
  });
});

describe('release-pr.yml', () => {
  // The pull-request job installs nothing, so it lists the version files itself instead of
  // reading VERSION_FILES. A file added to only one side would fail every release PR.
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release-pr.yml'), 'utf8');
  // package.json is where the version comes from, so it isn't in VERSION_FILES, but the release
  // patch bumps it too.
  const versionPaths = ['package.json', ...VERSION_FILES.map((f) => f.path)].sort();

  it('lets the release patch modify exactly the version files and CHANGELOG.md', () => {
    const allowlist = /\$1 == "M" && \$2 ~ \/\^\((.+)\)\$\//.exec(workflow);
    expect(allowlist).not.toBeNull();
    const paths = (allowlist?.[1] ?? '').split('|').map((p) => p.replace(/\\(.)/g, '$1'));
    expect(paths.sort()).toEqual([...versionPaths, 'CHANGELOG.md'].sort());
  });

  // The `for spec in` loop's `'<path>|<jq filter>'` entries.
  function workflowSpecs(): Array<[path: string, filter: string]> {
    const loop = /for spec in \\\n([\s\S]*?); do\n/.exec(workflow);
    expect(loop).not.toBeNull();
    return [...(loop?.[1] ?? '').matchAll(/^\s+'([^'|]+)\|(.*)'(?: \\)?$/gm)].map((m) => [
      m[1],
      m[2],
    ]);
  }

  it('checks the contents of every version file', () => {
    expect(
      workflowSpecs()
        .map(([path]) => path)
        .sort(),
    ).toEqual(versionPaths);
  });

  it("sets each file's version fields the way sync does", () => {
    // Runs each jq filter on the real file and compares it with what sync would write, so a
    // field that only one side bumps, or a package rename the filter misses, fails here.
    const readRepo: ReadFile = (path) => readFileSync(resolve(repoRoot, path), 'utf8');
    const { name } = readPackageJson(readRepo);
    const version = '9.9.9';
    try {
      execFileSync('jq', ['--version'], { stdio: 'ignore' });
    } catch (err: unknown) {
      throw new Error(
        "This test runs jq, which wouldn't start. Is it installed and on PATH? See " +
          'Prerequisites in CONTRIBUTING.md.',
        { cause: err },
      );
    }
    for (const [path, filter] of workflowSpecs()) {
      const text = readRepo(path);
      const viaJq: unknown = JSON.parse(
        // The lockfile alone is about 0.5 MB, so leave room past Node's 1 MiB default.
        execFileSync('jq', ['--arg', 'v', version, filter], {
          input: text,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
      // changeset version bumps package.json; sync copies its version everywhere else.
      const viaSync: unknown =
        path === 'package.json'
          ? { ...JSON.parse(text), version }
          : JSON.parse(setVersion(versionFile(path), text, version, name));
      expect([path, viaJq]).toEqual([path, viaSync]);
    }
  });
});

describe('the files in this repo', () => {
  it('all carry the version in package.json', () => {
    const readRepo: ReadFile = (path) => readFileSync(resolve(repoRoot, path), 'utf8');
    expect(findVersionMismatches(readRepo)).toEqual([]);
  });

  it('hold only changesets whose frontmatter Release can read', () => {
    // Release refuses to run while a changeset it can't read is pending, so catch one in the PR
    // that adds it.
    for (const [name, text] of readPendingChangesets(resolve(repoRoot, '.changeset'))) {
      expect(() => changesetReleases(text, name)).not.toThrow();
    }
  });
});

describe('parseCommand', () => {
  it('accepts the forms package.json and the workflows use', () => {
    expect(parseCommand(['sync'])).toEqual({ name: 'sync' });
    expect(parseCommand(['check'])).toEqual({ name: 'check' });
    expect(parseCommand(['check', '--base', 'origin/main'])).toEqual({
      name: 'check-base',
      base: 'origin/main',
    });
  });

  it('rejects anything else instead of running a different check', () => {
    for (const argv of [
      [],
      ['check', '--base=origin/main'],
      ['check', '--base'],
      ['check', '--base', ''],
      ['check', 'origin/main'],
      ['check', '--base', 'origin/main', 'extra'],
      ['sync', 'extra'],
      ['notes'],
      ['release'],
    ]) {
      expect(parseCommand(argv)).toBeUndefined();
    }
  });
});

describe('isMainModule', () => {
  const originalArgv1 = process.argv[1];

  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  it('returns false when argv[1] resolves to a different file', () => {
    process.argv[1] = resolve(repoRoot, 'test', 'release-files.test.ts');
    expect(isMainModule()).toBe(false);
  });

  it('returns true when argv[1] resolves to scripts/release-files.ts', () => {
    process.argv[1] = resolve(repoRoot, 'scripts', 'release-files.ts');
    expect(isMainModule()).toBe(true);
  });
});
