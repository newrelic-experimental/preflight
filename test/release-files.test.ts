import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  VERSION_FILES,
  dateNewEntries,
  findReleaseEdits,
  findVersionMismatches,
  isMainModule,
  releaseEntry,
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

describe('releaseEntry', () => {
  it("returns the version's entry without its heading", () => {
    expect(releaseEntry(makeChangelog(NEW_ENTRY, RELEASED_ENTRY), '1.64.0')).toBe(
      '### Minor Changes\n\n- A new feature.\n\n  Second paragraph.',
    );
  });

  it('runs to the end of the file for the oldest entry', () => {
    expect(releaseEntry(makeChangelog(NEW_ENTRY, RELEASED_ENTRY), '1.63.1')).toBe(
      '### Fixed\n\n- An older fix.',
    );
  });

  it('returns undefined for a version with no entry', () => {
    expect(releaseEntry(makeChangelog(RELEASED_ENTRY), '9.9.9')).toBeUndefined();
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

describe('the files in this repo', () => {
  it('all carry the version in package.json', () => {
    const readRepo: ReadFile = (path) => readFileSync(resolve(repoRoot, path), 'utf8');
    expect(findVersionMismatches(readRepo)).toEqual([]);
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
