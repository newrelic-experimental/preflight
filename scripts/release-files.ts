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
 *     something. With --base it fails if HEAD has changed the version or an already-released
 *     CHANGELOG entry since its merge base with <ref>; CI runs that on every PR except the
 *     release PR.
 *   tsx scripts/release-files.ts notes
 *     Prints the CHANGELOG entry for package.json's version, which becomes the release PR's
 *     description.
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

/** The body of `version`'s entry: everything between its heading and the next `## ` heading. */
export function releaseEntry(changelog: string, version: string): string | undefined {
  const heading = [...changelog.matchAll(RELEASE_HEADING)].find((m) => m[1] === version);
  if (heading?.index === undefined) return undefined;
  const start = heading.index + heading[0].length;
  const next = changelog.slice(start).search(/^## /m);
  return changelog.slice(start, next === -1 ? undefined : start + next).trim();
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
// `'@newrelic/preflight': minor`. The quotes are optional, and a trailing comment is allowed.
const CHANGESET_RELEASE = /^(['"]?)([^'"]+)\1\s*:\s*(major|minor|patch|none)\s*(?:#.*)?$/;

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
    releases.set(m[2], m[3]);
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
  const releasing = [...changesets]
    .filter(([name, text]) =>
      [...changesetReleases(text, `.changeset/${name}`).values()].some((bump) => bump !== 'none'),
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
 * package.json, and a pending changeset whose change the CHANGELOG entry leaves out.
 */
export function findReleaseBlockers(
  read: ReadFile,
  changesets: ReadonlyMap<string, string>,
): string[] {
  return [
    ...findVersionMismatches(read),
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
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
  );
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  | { readonly name: 'check-base'; readonly base: string }
  | { readonly name: 'notes' };

/**
 * The command `argv` asks for, or undefined for anything but the exact forms in the usage line,
 * so a typo such as `check --base=origin/main` can't quietly run a different check.
 */
export function parseCommand(argv: readonly string[]): Command | undefined {
  const [command, ...args] = argv;
  if (args.length === 0 && (command === 'sync' || command === 'check' || command === 'notes')) {
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
      [
        ...findReleaseEdits(readForkPoint, readWorkingTree),
        ...findVersionMismatches(readWorkingTree),
      ],
      `Compared with ${base} at ${forkPoint.slice(0, 7)}, its merge base with HEAD.`,
    );
  }

  if (command?.name === 'notes') {
    const { version } = readPackageJson(readWorkingTree);
    const entry = releaseEntry(readWorkingTree('CHANGELOG.md'), version);
    if (entry === undefined) {
      console.error(`CHANGELOG.md has no entry for ${version}.`);
      return 1;
    }
    console.log(entry);
    return 0;
  }

  console.error('Usage: tsx scripts/release-files.ts <sync | check [--base <ref>] | notes>');
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
