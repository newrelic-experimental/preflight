#!/usr/bin/env tsx
/**
 * Keeps every file that carries Preflight's version in step with package.json.
 *
 * `changeset version` bumps package.json and adds the release's CHANGELOG.md entry, but the
 * version is also written in package-lock.json, server.json (the MCP Registry manifest), and
 * both plugin manifests. `npm run version-packages` runs `changeset version` and then `sync`
 * below, so the release PR changes all of these files together and no other PR touches them.
 *
 *   tsx scripts/release-files.ts sync
 *     Copies package.json's version into the other files and dates the CHANGELOG entry that
 *     `changeset version` just added.
 *   tsx scripts/release-files.ts check [--base <ref>]
 *     Fails if any of those files disagrees with package.json, or if the newest CHANGELOG
 *     entry isn't for package.json's version. Without --base, which is how release.yml runs it
 *     before tagging, it also fails while .changeset/ holds a changeset that releases
 *     something, or one it can't read. With --base it fails if, since its merge base with
 *     <ref>, HEAD has changed the version or an already-released CHANGELOG entry, deleted,
 *     emptied, or lowered a pending changeset's bump, or holds a changeset it can't read; CI
 *     runs that on every PR except the release PR.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

type JsonObject = Record<string, unknown>;

/** Reads a file by its path from the repo root. Injected so tests can work in memory. */
export type ReadFile = (path: string) => string;

interface VersionFile {
  readonly path: string;
  /** The objects whose `version` the release owns, each labelled for error messages. */
  readonly holders: (
    json: JsonObject,
    packageName: string,
  ) => ReadonlyArray<readonly [label: string, holder: JsonObject]>;
  /**
   * `npm` rewrites the whole file in the layout npm itself gives package-lock.json.
   * `in-place` replaces the version strings where they stand so that Prettier's layout
   * survives, which only works while every `"version"` key in the file is one the release owns.
   */
  readonly layout: 'npm' | 'in-place';
}

export const VERSION_FILES: readonly VersionFile[] = [
  {
    path: 'package-lock.json',
    layout: 'npm',
    holders: (lock) => [
      ['version', lock],
      ['packages[""].version', asObject(asObject(lock.packages, 'packages')[''], 'packages[""]')],
    ],
  },
  {
    // The server's own version, and the version of the npm package the registry entry runs.
    path: 'server.json',
    layout: 'in-place',
    holders: (server, packageName) => {
      const npmPackages = asArray(server.packages, 'packages').flatMap((entry, i) => {
        const pkg = asObject(entry, `packages[${i}]`);
        return pkg.registryType === 'npm' && pkg.identifier === packageName
          ? [[`packages[${i}].version`, pkg] as const]
          : [];
      });
      if (npmPackages.length === 0) {
        throw new Error(`server.json has no npm package entry for ${packageName}`);
      }
      return [['version', server], ...npmPackages];
    },
  },
  {
    path: 'plugin/.claude-plugin/plugin.json',
    layout: 'in-place',
    holders: (m) => [['version', m]],
  },
  { path: 'kiro-power/plugin.json', layout: 'in-place', holders: (m) => [['version', m]] },
];

// `## 1.64.0 - 2026-10-09`. `changeset version` writes the heading without a date and `sync`
// adds one. A prerelease suffix (`-beta.0`) still parses, but prereleases (`changeset pre`)
// aren't set up: release.yml publishes every version under npm's `latest` tag.
const RELEASE_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?: - (\d{4}-\d{2}-\d{2}))?$/gm;

// Before Changesets, headings put the version in brackets: `## [1.63.1] - 2026-10-08`.
const LEGACY_RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm;

const CHANGESETS_DOC = 'CONTRIBUTING.md#changesets';
const RELEASING_DOC = 'CONTRIBUTING.md#releasing';

export interface ReleaseHeading {
  readonly version: string;
  readonly date: string | undefined;
}

/** Release headings in file order, newest first. */
export function releaseHeadings(changelog: string): ReleaseHeading[] {
  return [...changelog.matchAll(RELEASE_HEADING)].map((m) => ({ version: m[1], date: m[2] }));
}

/** `changelog` with every undated release heading dated `date` (YYYY-MM-DD). */
export function dateNewEntries(changelog: string, date: string): string {
  return changelog.replace(RELEASE_HEADING, (heading, version: string, existing?: string) =>
    existing ? heading : `## ${version} - ${date}`,
  );
}

/**
 * Everything from the first `## ` heading on, with legacy headings normalized. This is the part
 * of the file that only the release PR may change: the introduction above it may be edited
 * freely, but an entry added here by hand (including an `## Unreleased` section) is a release
 * PR's job done early.
 */
export function releasedEntries(changelog: string): string {
  const normalized = changelog.replace(LEGACY_RELEASE_HEADING, '## $1 - $2');
  const start = normalized.search(/^## /m);
  return start === -1 ? '' : normalized.slice(start);
}

export function readPackageJson(read: ReadFile): { name: string; version: string } {
  const pkg = parseObject(read('package.json'), 'package.json');
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new Error('package.json needs a string name and version');
  }
  return { name: pkg.name, version: pkg.version };
}

/** `text` with every version the release owns in `file` set to `version`. */
export function setVersion(
  file: VersionFile,
  text: string,
  version: string,
  packageName: string,
): string {
  const json = parseObject(text, file.path);
  for (const [, holder] of file.holders(json, packageName)) holder.version = version;
  if (file.layout === 'npm') return `${JSON.stringify(json, null, 2)}\n`;

  const edited = text.replace(
    /("version"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (_match, key: string) => `${key}${JSON.stringify(version)}`,
  );
  if (!isDeepStrictEqual(JSON.parse(edited), json)) {
    throw new Error(
      `${file.path} has a "version" key that isn't the package's version, so it can't be ` +
        'edited in place. Teach VERSION_FILES in scripts/release-files.ts which keys to bump.',
    );
  }
  return edited;
}

/**
 * The files `sync` would change, mapped to their new contents: package.json's version copied
 * into every VERSION_FILES entry, and new CHANGELOG headings dated `date`.
 */
export function syncedFiles(read: ReadFile, date: string): Map<string, string> {
  const { name, version } = readPackageJson(read);
  const updates = new Map<string, string>();
  for (const file of VERSION_FILES) {
    const before = read(file.path);
    const after = setVersion(file, before, version, name);
    if (after !== before) updates.set(file.path, after);
  }
  const changelog = read('CHANGELOG.md');
  const dated = dateNewEntries(changelog, date);
  if (dated !== changelog) updates.set('CHANGELOG.md', dated);
  return updates;
}

/** Each way the version files disagree with package.json; empty when they all agree. */
export function findVersionMismatches(read: ReadFile): string[] {
  const { name, version } = readPackageJson(read);
  const problems: string[] = [];
  for (const file of VERSION_FILES) {
    const json = parseObject(read(file.path), file.path);
    for (const [label, holder] of file.holders(json, name)) {
      if (holder.version !== version) {
        problems.push(
          `${file.path} ${label} is ${JSON.stringify(holder.version)}, but package.json is at ${version}.`,
        );
      }
    }
  }
  const newest = releaseHeadings(read('CHANGELOG.md'))[0];
  if (!newest) {
    problems.push('CHANGELOG.md has no release headings.');
  } else if (newest.version !== version) {
    problems.push(
      `CHANGELOG.md's newest entry is for ${newest.version}, but package.json is at ${version}.`,
    );
  } else if (!newest.date) {
    problems.push(`CHANGELOG.md's ${version} heading has no date.`);
  }
  return problems;
}

// A frontmatter line naming a package and its bump, as `changeset add` writes it:
// `'@newrelic/preflight': minor`. Either side may be quoted, as YAML (and so Changesets)
// allows, and a trailing comment is allowed.
const CHANGESET_RELEASE = /^(['"]?)([^'"]+)\1\s*:\s*(['"]?)(major|minor|patch|none)\3\s*(?:#.*)?$/;

/**
 * The bump a changeset asks for, by package name: none for an empty changeset
 * (`npx changeset --empty`). Reads the frontmatter shapes `changeset add` writes and throws on
 * anything else instead of guessing, since Release refuses or proceeds on the answer.
 */
export function changesetReleases(text: string, label: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((line) => line.trim() !== '');
  const close = lines.findIndex((line, i) => i > open && line.trim() === '---');
  if (open === -1 || lines[open].trim() !== '---' || close === -1) {
    throw new Error(`${label} doesn't start with frontmatter between two --- lines.`);
  }
  const releases = new Map<string, string>();
  for (const line of lines.slice(open + 1, close)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = CHANGESET_RELEASE.exec(trimmed);
    if (!m) throw new Error(`${label} has a frontmatter line this script can't read: ${trimmed}`);
    // An unquoted key keeps any space before the colon, which YAML doesn't count as part of the
    // key. A quoted key is taken as written, spaces included, as YAML does.
    const pkg = m[1] === '' ? m[2].trim() : m[2];
    if (releases.has(pkg)) {
      throw new Error(`${label} names ${pkg} more than once, so its bump is ambiguous.`);
    }
    releases.set(pkg, m[4]);
  }
  return releases;
}

/**
 * The pending changesets (file name to contents) that would release something, as one
 * problem; empty when every one is empty or bumps nothing. Release tags the commit it runs on,
 * so a changeset still pending there means that commit ships a change the CHANGELOG entry for
 * package.json's version leaves out.
 */
export function findPendingReleases(
  changesets: ReadonlyMap<string, string>,
  version: string,
): string[] {
  // An unreadable changeset is reported by findUnreadableChangesets in findReleaseBlockers.
  const releasing = [...changesets]
    .filter(([name, text]) =>
      [...(readReleasesOrUndefined(text, `.changeset/${name}`)?.values() ?? [])].some(
        (bump) => bump !== 'none',
      ),
    )
    .map(([name]) => `.changeset/${name}`)
    .sort();
  if (releasing.length === 0) return [];
  return [
    `${releasing.join(', ')} ${releasing.length === 1 ? 'is' : 'are'} waiting for a release, ` +
      `but the ${version} CHANGELOG entry leaves ${releasing.length === 1 ? 'it' : 'them'} out, ` +
      `so publishing from this commit would ship ${version} with changes its entry doesn't ` +
      'mention. This happens when a PR with a changeset merges after the release PR and before ' +
      'Release runs. Merge the release PR that release-pr.yml opens for it, then run Release ' +
      `again. That release also ships everything in ${version}.`,
  ];
}

/**
 * Everything that stops Release from tagging this commit: a version file that disagrees with
 * package.json, a pending changeset whose change the CHANGELOG entry leaves out, and a pending
 * changeset this script can't read, since it can't tell whether that one releases something.
 */
export function findReleaseBlockers(
  read: ReadFile,
  changesets: ReadonlyMap<string, string>,
): string[] {
  return [
    ...findVersionMismatches(read),
    ...findUnreadableChangesets(changesets),
    ...findPendingReleases(changesets, readPackageJson(read).version),
  ];
}

/** Each release-PR-only change a branch made since `base`; empty when it made none. */
export function findReleaseEdits(base: ReadFile, head: ReadFile): string[] {
  const problems: string[] = [];
  const before = readPackageJson(base).version;
  const after = readPackageJson(head).version;
  if (before !== after) {
    problems.push(
      `package.json's version changed from ${before} to ${after}. Versions are bumped only by ` +
        'the release PR. Revert the bump in package.json, package-lock.json, server.json, and ' +
        `both plugin manifests, and describe the change in a changeset instead (${CHANGESETS_DOC}).`,
    );
  }
  if (releasedEntries(base('CHANGELOG.md')) !== releasedEntries(head('CHANGELOG.md'))) {
    problems.push(
      'CHANGELOG.md changed below its introduction. Entries are written by the release PR from ' +
        'the changesets in .changeset/, so revert the CHANGELOG.md edit and put the text in a ' +
        `changeset instead (${CHANGESETS_DOC}). If you're correcting an entry that has already ` +
        'been released, a maintainer can merge over this check.',
    );
  }
  return problems;
}

/** One side of a `check --base` comparison: its files and its pending changesets. */
export interface Snapshot {
  readonly read: ReadFile;
  readonly changesets: ReadonlyMap<string, string>;
}

/**
 * Everything a PR other than the release PR must not do, comparing its merge base with its
 * head: bump the version, edit a released CHANGELOG entry, or drop a pending release. Plus any
 * version file that disagrees with package.json.
 */
export function findBranchProblems(base: Snapshot, head: Snapshot): string[] {
  return [
    ...findReleaseEdits(base.read, head.read),
    // Every changeset in the head, as Release reads them all and npm test parses them all.
    ...findUnreadableChangesets(head.changesets),
    ...findDroppedReleases(base.changesets, head.changesets),
    ...findVersionMismatches(head.read),
  ];
}

/**
 * Each changeset this script can't read, as a problem. findBranchProblems runs it on a PR's
 * changesets, so the PR that adds an unreadable one fails. If one reaches main anyway (a
 * maintainer merged over the check), every PR fails until one fixes or removes it, and
 * findReleaseBlockers keeps Release from running meanwhile.
 */
export function findUnreadableChangesets(changesets: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, text] of [...changesets].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      changesetReleases(text, `.changeset/${name}`);
    } catch (err: unknown) {
      problems.push(
        `${err instanceof Error ? err.message : String(err)} Write each bump as ` +
          `\`'@newrelic/preflight': patch\`, \`minor\`, or \`major\` (${CHANGESETS_DOC}).`,
      );
    }
  }
  return problems;
}

function readReleasesOrUndefined(text: string, label: string): Map<string, string> | undefined {
  try {
    return changesetReleases(text, label);
  } catch {
    return undefined;
  }
}

const BUMP_RANK: Readonly<Record<string, number>> = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * Each pending release that `base` had and `head` dropped, as one problem: a changeset that
 * bumped something and was deleted, emptied, or lowered to a smaller bump. Both maps are file
 * name to contents. Only the release PR consumes changesets, and any of these drops a change
 * from the next CHANGELOG entry, or shrinks its bump, without anything else noticing. Deleting
 * an empty changeset drops nothing, and moving one's text to another file without changing it
 * (a rename, or rewriting another changeset to it) keeps its release, so both pass. A
 * changeset this script can't read is skipped here; findUnreadableChangesets reports it.
 *
 * It guards bumps, not entry text. Rewriting a changeset's summary passes, including rewriting
 * it into another changeset's text, so a lost CHANGELOG bullet is for review to catch.
 */
export function findDroppedReleases(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
): string[] {
  // How many times each text is new in the head under its name: in a new file, or written over
  // another. Each deleted changeset whose text moved uses up one, so two identical changesets
  // folded into one file still count as one dropped.
  const movedTexts = new Map<string, number>();
  for (const [name, text] of head) {
    if (base.get(name) !== text) movedTexts.set(text, (movedTexts.get(text) ?? 0) + 1);
  }
  const dropped: string[] = [];
  for (const [name, text] of [...base].sort(([a], [b]) => a.localeCompare(b))) {
    const label = `.changeset/${name}`;
    const before = readReleasesOrUndefined(text, label);
    if (before === undefined) continue;
    const headText = head.get(name);
    const moves = movedTexts.get(text) ?? 0;
    if (headText === undefined && moves > 0) {
      movedTexts.set(text, moves - 1);
      continue;
    }
    const after = headText === undefined ? undefined : readReleasesOrUndefined(headText, label);
    if (headText !== undefined && after === undefined) continue;
    for (const [pkg, bump] of before) {
      if (bump === 'none') continue;
      if (after === undefined) {
        dropped.push(`${label} was deleted, dropping its ${bump} release of ${pkg}`);
        break;
      }
      const now = after.get(pkg) ?? 'none';
      if (BUMP_RANK[now] < BUMP_RANK[bump]) {
        dropped.push(`${label} lowered ${pkg} from ${bump} to ${now}`);
      }
    }
  }
  if (dropped.length === 0) return [];
  return [
    `${dropped.join('; ')}. Only the release PR consumes changesets, so restore what was ` +
      `dropped; to change an entry's text, edit its changeset in place (${CHANGESETS_DOC}). If ` +
      'this PR reverts the change a changeset describes, or a reviewer agreed a bump should be ' +
      'lower, a maintainer can merge over this check.',
  ];
}

function parseObject(text: string, label: string): JsonObject {
  return asObject(JSON.parse(text), label);
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a JSON array`);
  return value;
}

/**
 * Every changeset waiting in `dir` (the repo's .changeset/), file name to contents. In
 * prerelease mode (`changeset pre`), `changeset version` moves the changesets it used into
 * .changeset/pre/ rather than deleting them, so they aren't read here.
 */
export function readPendingChangesets(dir: string): Map<string, string> {
  return new Map(
    readdirSync(dir)
      .filter(isChangesetName)
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
  );
}

/** Where git runs: the repo's directory and the environment (GIT_DIR and the like) it sees. */
export interface GitOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The changesets committed at `commit`, the same way readPendingChangesets reads the working
 * tree. A commit from before .changeset/ existed has none.
 */
export function readChangesetsAtCommit(
  commit: string,
  options: GitOptions = {},
): Map<string, string> {
  // -z keeps names verbatim; the path form lists nothing, instead of failing, when the
  // directory is missing.
  const names = git(['ls-tree', '-z', '--name-only', commit, '--', '.changeset/'], options)
    .split('\0')
    .filter((path) => path.startsWith('.changeset/'))
    .map((path) => path.slice('.changeset/'.length))
    .filter(isChangesetName);
  return new Map(
    names.map((name) => [name, git(['show', `${commit}:.changeset/${name}`], options)]),
  );
}

/** A changeset is a Markdown file directly in .changeset/, other than its README. */
function isChangesetName(name: string): boolean {
  return name.endsWith('.md') && name !== 'README.md' && !name.includes('/');
}

function git(args: readonly string[], { cwd, env }: GitOptions = {}): string {
  return execFileSync('git', args, {
    cwd: cwd ?? process.cwd(),
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function report(problems: readonly string[], fix: string): number {
  if (problems.length === 0) return 0;
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(`\n${fix}`);
  return 1;
}

export type Command =
  | { readonly name: 'sync' }
  | { readonly name: 'check' }
  | { readonly name: 'check-base'; readonly base: string };

/**
 * The command `argv` asks for, or undefined for anything but the exact forms in the usage line,
 * so a typo such as `check --base=origin/main` can't quietly run a different check.
 */
export function parseCommand(argv: readonly string[]): Command | undefined {
  const [command, ...args] = argv;
  if (args.length === 0 && (command === 'sync' || command === 'check')) {
    return { name: command };
  }
  if (command === 'check' && args.length === 2 && args[0] === '--base' && args[1] !== '') {
    return { name: 'check-base', base: args[1] };
  }
  return undefined;
}

function main(argv: readonly string[]): number {
  const readWorkingTree: ReadFile = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');
  const command = parseCommand(argv);

  if (command?.name === 'sync') {
    const date = new Date().toISOString().slice(0, 10);
    for (const [path, contents] of syncedFiles(readWorkingTree, date)) {
      writeFileSync(resolve(process.cwd(), path), contents);
      console.log(`Updated ${path}`);
    }
    return report(
      findVersionMismatches(readWorkingTree),
      'Run this after `changeset version` (npm run version-packages runs both).',
    );
  }

  if (command?.name === 'check') {
    const changesets = readPendingChangesets(resolve(process.cwd(), '.changeset'));
    return report(
      findReleaseBlockers(readWorkingTree, changesets),
      'Only the release PR should change the version files, and Release should run before ' +
        `another PR with a changeset merges after it (${RELEASING_DOC}).`,
    );
  }

  if (command?.name === 'check-base') {
    const { base } = command;
    const forkPoint = git(['merge-base', base, 'HEAD']).trim();
    const readForkPoint: ReadFile = (path) => git(['show', `${forkPoint}:${path}`]);
    return report(
      findBranchProblems(
        { read: readForkPoint, changesets: readChangesetsAtCommit(forkPoint) },
        {
          read: readWorkingTree,
          changesets: readPendingChangesets(resolve(process.cwd(), '.changeset')),
        },
      ),
      `Compared with ${base} at ${forkPoint.slice(0, 7)}, its merge base with HEAD.`,
    );
  }

  console.error('Usage: tsx scripts/release-files.ts <sync | check [--base <ref>]>');
  return 2;
}

// Uses process.argv[1] rather than import.meta.url, which ts-jest's CommonJS output can't
// parse, so the test file can import this module without running it.
export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry).endsWith(join('scripts', 'release-files.ts'));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
