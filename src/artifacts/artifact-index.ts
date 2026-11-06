import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';

import { createLogger } from '../shared/index.js';
import type { AuditRecord } from '../security/audit-trail.js';
import {
  isPlaceholderIdentity,
  WorktreeIdentityResolver,
  type WorktreeIdentity,
} from '../metrics/git-workspace-identity.js';

const logger = createLogger('artifact-index');

/** Newest audit rows scanned per `list()`. Bounds the cost on a long-lived daemon. */
export const ARTIFACT_SCAN_LIMIT = 20_000;

const HTML_PATH = /\.html?$/i;
const WRITE_ACTIONS: ReadonlySet<AuditRecord['action']> = new Set(['FileWrite', 'FileEdit']);

export interface ArtifactEntry {
  readonly path: string;
  readonly name: string;
  /** Relative to the worktree root for repo groups, else the basename. */
  readonly relativePath: string;
  readonly worktreeLabel: string | null;
  readonly sessionIds: readonly string[];
  readonly firstWrittenAt: number;
  readonly lastWrittenAt: number;
  readonly writeCount: number;
  readonly sizeBytes: number;
}

export type ArtifactGroupKind = 'repo' | 'directory';

export interface ArtifactGroup {
  /** `repoKey` for repo groups, the directory path otherwise. */
  readonly key: string;
  readonly kind: ArtifactGroupKind;
  readonly label: string;
  readonly lastWrittenAt: number;
  /** Newest `lastWrittenAt` first. */
  readonly artifacts: readonly ArtifactEntry[];
}

export interface ArtifactIndexDeps {
  readonly loadAuditLog: () => readonly Pick<
    AuditRecord,
    'action' | 'filePath' | 'sessionId' | 'timestamp'
  >[];
  readonly resolveRepo: (dir: string) => WorktreeIdentity | null;
  /** Null if the path is missing or not a regular file. */
  readonly statFile: (path: string) => { readonly sizeBytes: number } | null;
}

interface WriteAccumulator {
  readonly path: string;
  readonly sessionIds: Set<string>;
  firstWrittenAt: number;
  lastWrittenAt: number;
  writeCount: number;
}

interface MutableGroup {
  readonly key: string;
  readonly kind: ArtifactGroupKind;
  readonly label: string;
  lastWrittenAt: number;
  readonly artifacts: ArtifactEntry[];
}

export function buildArtifactIndex(deps: ArtifactIndexDeps): ArtifactGroup[] {
  const writes = new Map<string, WriteAccumulator>();
  for (const record of deps.loadAuditLog()) {
    if (!WRITE_ACTIONS.has(record.action)) continue;
    const path = record.filePath;
    if (path === undefined || !isAbsolute(path) || !HTML_PATH.test(path)) continue;

    let acc = writes.get(path);
    if (!acc) {
      acc = {
        path,
        sessionIds: new Set(),
        firstWrittenAt: record.timestamp,
        lastWrittenAt: record.timestamp,
        writeCount: 0,
      };
      writes.set(path, acc);
    }
    acc.writeCount += 1;
    acc.firstWrittenAt = Math.min(acc.firstWrittenAt, record.timestamp);
    acc.lastWrittenAt = Math.max(acc.lastWrittenAt, record.timestamp);
    if (record.sessionId) acc.sessionIds.add(record.sessionId);
  }

  const repoByDir = new Map<string, WorktreeIdentity | null>();
  const repoFor = (dir: string): WorktreeIdentity | null => {
    if (!repoByDir.has(dir)) repoByDir.set(dir, deps.resolveRepo(dir));
    return repoByDir.get(dir) ?? null;
  };

  const groups = new Map<string, MutableGroup>();
  for (const acc of writes.values()) {
    const stat = deps.statFile(acc.path);
    if (stat === null) continue;

    const dir = dirname(acc.path);
    const identity = repoFor(dir);
    const repo = identity !== null && !isPlaceholderIdentity(identity) ? identity : null;

    const artifact: ArtifactEntry = {
      path: acc.path,
      name: basename(acc.path),
      relativePath: (repo && relativeWithin(repo.worktreeRoot, acc.path)) || basename(acc.path),
      worktreeLabel: repo ? repo.worktreeLabel : null,
      sessionIds: [...acc.sessionIds],
      firstWrittenAt: acc.firstWrittenAt,
      lastWrittenAt: acc.lastWrittenAt,
      writeCount: acc.writeCount,
      sizeBytes: stat.sizeBytes,
    };

    const key = repo ? repo.repoKey : dir;
    let group = groups.get(key);
    if (!group) {
      group = repo
        ? { key, kind: 'repo', label: repoLabel(repo), lastWrittenAt: 0, artifacts: [] }
        : { key, kind: 'directory', label: tildePath(dir), lastWrittenAt: 0, artifacts: [] };
      groups.set(key, group);
    }
    group.artifacts.push(artifact);
    group.lastWrittenAt = Math.max(group.lastWrittenAt, artifact.lastWrittenAt);
  }

  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      kind: group.kind,
      label: group.label,
      lastWrittenAt: group.lastWrittenAt,
      artifacts: [...group.artifacts].sort(byNewestThenPath),
    }))
    .sort((a, b) => b.lastWrittenAt - a.lastWrittenAt || compareKeys(a.key, b.key));
}

export function createArtifactIndex(auditLog: {
  getAuditLog(limit?: number): readonly AuditRecord[];
}): {
  list(): ArtifactGroup[];
  find(path: string): ArtifactEntry | null;
} {
  const resolver = new WorktreeIdentityResolver();
  const deps: ArtifactIndexDeps = {
    loadAuditLog: () => auditLog.getAuditLog(ARTIFACT_SCAN_LIMIT),
    resolveRepo: (dir) => resolver.resolve(dir),
    statFile: statRegularFile,
  };

  const list = (): ArtifactGroup[] => {
    const groups = buildArtifactIndex(deps);
    logger.debug('Artifact index built', {
      groups: groups.length,
      artifacts: groups.reduce((n, g) => n + g.artifacts.length, 0),
    });
    return groups;
  };

  return {
    list,
    find(path) {
      for (const group of list()) {
        for (const artifact of group.artifacts) {
          if (artifact.path === path) return artifact;
        }
      }
      return null;
    },
  };
}

function statRegularFile(path: string): { readonly sizeBytes: number } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { sizeBytes: st.size } : null;
  } catch {
    return null;
  }
}

function relativeWithin(root: string | null, path: string): string | null {
  if (root === null) return null;
  const rel = relative(root, path);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel;
}

function repoLabel(repo: WorktreeIdentity): string {
  if (repo.repoName) return repo.repoName;
  // A non-bare clone keys on `<checkout>/.git`; the checkout dir is its name.
  const primaryDir = repo.repoKey.endsWith('/.git') ? dirname(repo.repoKey) : repo.repoKey;
  return basename(primaryDir);
}

function tildePath(path: string): string {
  const home = homedir();
  if (home.length > 1 && (path === home || path.startsWith(home + sep))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function byNewestThenPath(a: ArtifactEntry, b: ArtifactEntry): number {
  return b.lastWrittenAt - a.lastWrittenAt || compareKeys(a.path, b.path);
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
