import { describe, it, expect } from '@jest/globals';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildArtifactIndex,
  createArtifactIndex,
  type ArtifactIndexDeps,
} from './artifact-index.js';
import {
  UNATTRIBUTED_WORKSPACE_KEY,
  type WorktreeIdentity,
} from '../metrics/git-workspace-identity.js';

type AuditInput = ReturnType<ArtifactIndexDeps['loadAuditLog']>[number];

function makeWrite(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    action: 'FileWrite',
    filePath: '/work/repo/report.html',
    sessionId: 'sess-1',
    timestamp: 1_000,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<WorktreeIdentity> = {}): WorktreeIdentity {
  return {
    repoKey: '/work/repo/.git',
    worktreeKey: '/work/repo/.git',
    repoName: 'acme/repo',
    worktreeRoot: '/work/repo',
    worktreeLabel: 'primary',
    branch: 'main',
    ...overrides,
  };
}

interface FakeOptions {
  readonly records?: readonly AuditInput[];
  readonly repos?: Record<string, WorktreeIdentity | null>;
  readonly files?: Record<string, number>;
}

function makeDeps(options: FakeOptions = {}): ArtifactIndexDeps {
  const { records = [], repos = {}, files = {} } = options;
  return {
    loadAuditLog: () => records,
    resolveRepo: (dir) => repos[dir] ?? null,
    statFile: (path) => (path in files ? { sizeBytes: files[path]! } : null),
  };
}

describe('buildArtifactIndex: filtering', () => {
  it('keeps .html and .htm regardless of case and drops other extensions', () => {
    const records = [
      makeWrite({ filePath: '/w/a.html' }),
      makeWrite({ filePath: '/w/b.HTM' }),
      makeWrite({ filePath: '/w/c.Html' }),
      makeWrite({ filePath: '/w/d.txt' }),
      makeWrite({ filePath: '/w/e.html.bak' }),
    ];
    const groups = buildArtifactIndex(
      makeDeps({
        records,
        files: { '/w/a.html': 1, '/w/b.HTM': 1, '/w/c.Html': 1, '/w/d.txt': 1, '/w/e.html.bak': 1 },
      }),
    );
    const names = groups.flatMap((g) => g.artifacts.map((a) => a.name)).sort();
    expect(names).toEqual(['a.html', 'b.HTM', 'c.Html']);
  });

  it('ignores FileRead and other non-write actions', () => {
    const records = [
      makeWrite({ action: 'FileRead', filePath: '/w/read.html' }),
      makeWrite({ action: 'BashCommand', filePath: '/w/bash.html' }),
      makeWrite({ action: 'FileEdit', filePath: '/w/edited.html' }),
    ];
    const groups = buildArtifactIndex(
      makeDeps({ records, files: { '/w/read.html': 1, '/w/bash.html': 1, '/w/edited.html': 1 } }),
    );
    expect(groups.flatMap((g) => g.artifacts.map((a) => a.path))).toEqual(['/w/edited.html']);
  });

  it('ignores relative paths and records without a filePath', () => {
    const records = [
      makeWrite({ filePath: 'relative/out.html' }),
      makeWrite({ filePath: undefined }),
      makeWrite({ filePath: '/w/abs.html' }),
    ];
    const groups = buildArtifactIndex(makeDeps({ records, files: { '/w/abs.html': 1 } }));
    expect(groups.flatMap((g) => g.artifacts.map((a) => a.path))).toEqual(['/w/abs.html']);
  });

  it('drops paths the stat callback reports as missing or not a regular file', () => {
    const records = [
      makeWrite({ filePath: '/w/gone.html' }),
      makeWrite({ filePath: '/w/here.html' }),
    ];
    const groups = buildArtifactIndex(makeDeps({ records, files: { '/w/here.html': 7 } }));
    expect(groups.flatMap((g) => g.artifacts.map((a) => a.path))).toEqual(['/w/here.html']);
    expect(groups[0]!.artifacts[0]!.sizeBytes).toBe(7);
  });
});

describe('buildArtifactIndex: folding writes', () => {
  it('folds repeated writes into one artifact with count, first/last times and distinct sessions', () => {
    const records = [
      makeWrite({ timestamp: 2_000, sessionId: 'sess-b' }),
      makeWrite({ timestamp: 1_000, sessionId: 'sess-a' }),
      makeWrite({ timestamp: 3_000, sessionId: 'sess-a' }),
      makeWrite({ timestamp: 2_500, sessionId: null }),
    ];
    const groups = buildArtifactIndex(
      makeDeps({
        records,
        repos: { '/work/repo': makeIdentity() },
        files: { '/work/repo/report.html': 42 },
      }),
    );
    expect(groups).toHaveLength(1);
    const [artifact] = groups[0]!.artifacts;
    expect(artifact).toEqual({
      path: '/work/repo/report.html',
      name: 'report.html',
      relativePath: 'report.html',
      worktreeLabel: 'primary',
      sessionIds: ['sess-b', 'sess-a'],
      firstWrittenAt: 1_000,
      lastWrittenAt: 3_000,
      writeCount: 4,
      sizeBytes: 42,
    });
  });
});

describe('buildArtifactIndex: grouping', () => {
  it('folds two worktrees of one repoKey into one repo group with distinct worktree labels', () => {
    const primary = makeIdentity({ worktreeRoot: '/work/repo', worktreeLabel: 'primary' });
    const linked = makeIdentity({
      worktreeKey: '/work/repo/.git/worktrees/feat',
      worktreeRoot: '/work/feat',
      worktreeLabel: 'feat',
    });
    const records = [
      makeWrite({ filePath: '/work/repo/a.html', timestamp: 1_000 }),
      makeWrite({ filePath: '/work/feat/docs/b.html', timestamp: 2_000 }),
    ];
    const groups = buildArtifactIndex(
      makeDeps({
        records,
        repos: { '/work/repo': primary, '/work/feat/docs': linked },
        files: { '/work/repo/a.html': 1, '/work/feat/docs/b.html': 1 },
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '/work/repo/.git', kind: 'repo', label: 'acme/repo' });
    expect(groups[0]!.artifacts.map((a) => [a.relativePath, a.worktreeLabel])).toEqual([
      ['docs/b.html', 'feat'],
      ['a.html', 'primary'],
    ]);
  });

  it('puts a file outside any repo in a directory group labelled with ~ for the home directory', () => {
    const dir = join(homedir(), 'scratch', 'reports');
    const records = [makeWrite({ filePath: join(dir, 'summary.html') })];
    const groups = buildArtifactIndex(
      makeDeps({ records, files: { [join(dir, 'summary.html')]: 5 } }),
    );
    expect(groups).toEqual([
      {
        key: dir,
        kind: 'directory',
        label: '~/scratch/reports',
        lastWrittenAt: 1_000,
        artifacts: [
          expect.objectContaining({
            path: join(dir, 'summary.html'),
            name: 'summary.html',
            relativePath: 'summary.html',
            worktreeLabel: null,
          }),
        ],
      },
    ]);
  });

  it('treats a placeholder identity as not a repo', () => {
    const placeholder = makeIdentity({
      repoKey: UNATTRIBUTED_WORKSPACE_KEY,
      worktreeKey: UNATTRIBUTED_WORKSPACE_KEY,
      repoName: null,
      worktreeRoot: null,
      worktreeLabel: UNATTRIBUTED_WORKSPACE_KEY,
    });
    const groups = buildArtifactIndex(
      makeDeps({
        records: [makeWrite({ filePath: '/elsewhere/x.html' })],
        repos: { '/elsewhere': placeholder },
        files: { '/elsewhere/x.html': 1 },
      }),
    );
    expect(groups[0]).toMatchObject({ kind: 'directory', key: '/elsewhere' });
  });

  it('labels a repo without a remote name by its checkout directory', () => {
    const identity = makeIdentity({
      repoKey: '/src/tool/.git',
      worktreeKey: '/src/tool/.git',
      repoName: null,
      worktreeRoot: '/src/tool',
    });
    const groups = buildArtifactIndex(
      makeDeps({
        records: [makeWrite({ filePath: '/src/tool/out.html' })],
        repos: { '/src/tool': identity },
        files: { '/src/tool/out.html': 1 },
      }),
    );
    expect(groups[0]!.label).toBe('tool');
  });
});

describe('buildArtifactIndex: ordering', () => {
  it('orders groups and their artifacts newest first', () => {
    const records = [
      makeWrite({ filePath: '/old/a.html', timestamp: 1_000 }),
      makeWrite({ filePath: '/new/b.html', timestamp: 5_000 }),
      makeWrite({ filePath: '/new/c.html', timestamp: 3_000 }),
      makeWrite({ filePath: '/new/c.html', timestamp: 4_000 }),
      makeWrite({ filePath: '/mid/d.html', timestamp: 2_000 }),
      makeWrite({ filePath: '/mid/e.html', timestamp: 2_500 }),
    ];
    const files = {
      '/old/a.html': 1,
      '/new/b.html': 1,
      '/new/c.html': 1,
      '/mid/d.html': 1,
      '/mid/e.html': 1,
    };
    const groups = buildArtifactIndex(makeDeps({ records, files }));
    expect(groups.map((g) => g.key)).toEqual(['/new', '/mid', '/old']);
    expect(groups[0]!.lastWrittenAt).toBe(5_000);
    expect(groups[0]!.artifacts.map((a) => a.path)).toEqual(['/new/b.html', '/new/c.html']);
    expect(groups[1]!.artifacts.map((a) => a.path)).toEqual(['/mid/e.html', '/mid/d.html']);
  });

  it('resolves each directory once per call', () => {
    const calls: string[] = [];
    buildArtifactIndex({
      loadAuditLog: () => [
        makeWrite({ filePath: '/same/a.html' }),
        makeWrite({ filePath: '/same/b.html' }),
      ],
      resolveRepo: (dir) => {
        calls.push(dir);
        return null;
      },
      statFile: () => ({ sizeBytes: 1 }),
    });
    expect(calls).toEqual(['/same']);
  });
});

describe('createArtifactIndex', () => {
  it('lists and finds a real HTML file written in the audit log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-index-'));
    try {
      const file = join(dir, 'report.html');
      writeFileSync(file, '<h1>hi</h1>');
      const index = createArtifactIndex({
        getAuditLog: () => [
          {
            id: 'call-1',
            timestamp: 1_000,
            action: 'FileWrite',
            tool: 'Write',
            detail: file,
            developer: 'dev',
            filePath: file,
            sessionId: 'sess-1',
          },
        ],
      });
      const found = index.find(file);
      expect(found).toMatchObject({ path: file, name: 'report.html', sizeBytes: 11 });
      expect(index.find(join(dir, 'missing.html'))).toBeNull();
      expect(index.list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
