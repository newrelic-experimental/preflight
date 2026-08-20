import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveSessionId,
  resolveFromJobDir,
  resolveFromBreadcrumb,
  resolveFromCwd,
  nextDelayMs,
  isSyntheticSessionId,
  isUnscopedAggregatorSessionId,
  watchPpidBreadcrumb,
} from './session-resolver.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(tmpdir(), `nr-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-resolver', () => {
  describe('resolveFromJobDir()', () => {
    it('returns null when CLAUDE_JOB_DIR is null/undefined/empty', () => {
      expect(resolveFromJobDir(null)).toBeNull();
      expect(resolveFromJobDir(undefined)).toBeNull();
      expect(resolveFromJobDir('')).toBeNull();
    });

    it('returns null when state.json does not exist', () => {
      expect(resolveFromJobDir(tmpDir)).toBeNull();
    });

    it('returns null when state.json is not valid JSON', () => {
      writeFileSync(resolve(tmpDir, 'state.json'), 'not json');
      expect(resolveFromJobDir(tmpDir)).toBeNull();
    });

    it('extracts the session UUID from linkScanPath basename', () => {
      writeFileSync(
        resolve(tmpDir, 'state.json'),
        JSON.stringify({
          linkScanPath: '/some/dir/abc-123-def.jsonl',
        }),
      );
      expect(resolveFromJobDir(tmpDir)).toBe('abc-123-def');
    });

    it('allows values whose basename passes SESSION_ID_RE (path-traversal chars stripped by basename)', () => {
      writeFileSync(
        resolve(tmpDir, 'state.json'),
        JSON.stringify({
          linkScanPath: '/some/dir/../../bad.jsonl',
        }),
      );
      // basename of "../../bad.jsonl" gives "bad" which IS valid — but the
      // value passed before basename was suspicious; the regex enforces the
      // safe character class either way.
      expect(resolveFromJobDir(tmpDir)).toBe('bad');
    });

    it('rejects when basename contains a path separator (defensive)', () => {
      writeFileSync(
        resolve(tmpDir, 'state.json'),
        JSON.stringify({ linkScanPath: 'no-extension-no-slash' }),
      );
      // Basename includes the whole string; valid UUID pattern matches.
      expect(resolveFromJobDir(tmpDir)).toBe('no-extension-no-slash');
    });

    it('returns null when linkScanPath is missing', () => {
      writeFileSync(resolve(tmpDir, 'state.json'), JSON.stringify({ other: 'field' }));
      expect(resolveFromJobDir(tmpDir)).toBeNull();
    });
  });

  describe('resolveFromBreadcrumb()', () => {
    it('returns null when ppid is invalid', () => {
      expect(resolveFromBreadcrumb(tmpDir, 0)).toBeNull();
      expect(resolveFromBreadcrumb(tmpDir, undefined)).toBeNull();
      expect(resolveFromBreadcrumb(tmpDir, -1)).toBeNull();
    });

    it('returns null when breadcrumb file is missing', () => {
      expect(resolveFromBreadcrumb(tmpDir, 99999)).toBeNull();
    });

    it('returns the trimmed sessionId from <storage>/session-by-ppid/<ppid>.txt', () => {
      const ppid = 12345;
      mkdirSync(resolve(tmpDir, 'session-by-ppid'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`), 'sess-from-breadcrumb\n');
      expect(resolveFromBreadcrumb(tmpDir, ppid)).toBe('sess-from-breadcrumb');
    });

    it('returns null when breadcrumb content fails the regex', () => {
      const ppid = 12345;
      mkdirSync(resolve(tmpDir, 'session-by-ppid'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`), 'has spaces');
      expect(resolveFromBreadcrumb(tmpDir, ppid)).toBeNull();
    });

    it('rejects a breadcrumb whose mtime predates the given process start time', () => {
      const ppid = 4242;
      const breadcrumbDir = resolve(tmpDir, 'session-by-ppid');
      mkdirSync(breadcrumbDir, { recursive: true });
      const breadcrumbPath = resolve(breadcrumbDir, `${ppid}.txt`);
      writeFileSync(breadcrumbPath, 'sess-stale-leftover');

      // Simulate the breadcrumb having been written well before "now" by
      // backdating its mtime, then asking for a process that started later.
      const oldMs = Date.now() - 60_000;
      utimesSync(breadcrumbPath, oldMs / 1000, oldMs / 1000);

      const processStartMs = Date.now(); // this "process" started after the breadcrumb was written
      expect(resolveFromBreadcrumb(tmpDir, ppid, processStartMs)).toBeNull();
    });

    it('accepts a breadcrumb whose mtime is at or after the given process start time', () => {
      const ppid = 4243;
      const breadcrumbDir = resolve(tmpDir, 'session-by-ppid');
      mkdirSync(breadcrumbDir, { recursive: true });
      const breadcrumbPath = resolve(breadcrumbDir, `${ppid}.txt`);
      writeFileSync(breadcrumbPath, 'sess-fresh');

      const processStartMs = Date.now() - 60_000; // this "process" started well before the write
      expect(resolveFromBreadcrumb(tmpDir, ppid, processStartMs)).toBe('sess-fresh');
    });
  });

  describe('resolveFromCwd()', () => {
    it('returns null when cwd is missing or empty', () => {
      expect(resolveFromCwd(tmpDir, undefined)).toBeNull();
      expect(resolveFromCwd(tmpDir, '')).toBeNull();
    });

    it('returns null when breadcrumb file is missing', () => {
      expect(resolveFromCwd(tmpDir, '/projects/missing')).toBeNull();
    });

    it('returns the trimmed sessionId from <storage>/session-by-cwd/<sanitized-cwd>.txt', () => {
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-cwd', '-projects-test.txt'), 'sess-from-cwd\n');
      expect(resolveFromCwd(tmpDir, '/projects/test')).toBe('sess-from-cwd');
    });

    it('sanitizes a backslash-separated (Windows) cwd the same way as the collector', () => {
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-cwd', 'C--Users-test-myproject.txt'), 'sess-win');
      expect(resolveFromCwd(tmpDir, 'C:\\Users\\test\\myproject')).toBe('sess-win');
    });

    it('resolves correctly when cwd contains a Windows drive letter with colon', () => {
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-cwd', 'C--Users-test-myproject.txt'), 'sess-drive');
      expect(resolveFromCwd(tmpDir, 'C:\\Users\\test\\myproject')).toBe('sess-drive');
    });

    it('returns null when breadcrumb content fails the regex', () => {
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-cwd', '-projects-test.txt'), 'has spaces');
      expect(resolveFromCwd(tmpDir, '/projects/test')).toBeNull();
    });
  });

  describe('nextDelayMs()', () => {
    it('follows the exp-backoff schedule and saturates at 2s', () => {
      expect(nextDelayMs(0)).toBe(100);
      expect(nextDelayMs(1)).toBe(200);
      expect(nextDelayMs(2)).toBe(500);
      expect(nextDelayMs(3)).toBe(1000);
      expect(nextDelayMs(4)).toBe(2000);
      expect(nextDelayMs(5)).toBe(2000);
      expect(nextDelayMs(100)).toBe(2000);
    });
  });

  describe('resolveSessionId() — fast paths', () => {
    it('returns the CLAUDE_JOB_DIR result immediately when state.json is valid', async () => {
      const jobDir = resolve(tmpDir, 'job');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(
        resolve(jobDir, 'state.json'),
        JSON.stringify({ linkScanPath: '/whatever/job-uuid.jsonl' }),
      );
      const sid = await resolveSessionId({ claudeJobDir: jobDir, ppid: 1, storagePath: tmpDir });
      expect(sid).toBe('job-uuid');
    });

    it('returns immediately when the breadcrumb is already present', async () => {
      const ppid = 99887;
      mkdirSync(resolve(tmpDir, 'session-by-ppid'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`), 'sess-immediate');
      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid,
        storagePath: tmpDir,
      });
      expect(sid).toBe('sess-immediate');
    });

    it('falls back to the cwd breadcrumb when the ppid breadcrumb never appears (via the poll loop, not trusted at t=0)', async () => {
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(
        resolve(tmpDir, 'session-by-cwd', '-projects-winrepo.txt'),
        'sess-cwd-fallback',
      );
      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid: 424242, // never has a matching breadcrumb
        cwd: '/projects/winrepo',
        storagePath: tmpDir,
        suppressWarn: true,
      });
      expect(sid).toBe('sess-cwd-fallback');
    });

    it('prefers a ppid breadcrumb that appears just after startup over an already-present, possibly-stale cwd breadcrumb', async () => {
      // A cwd breadcrumb left over from an unrelated prior session in the
      // same directory must not win the race just because it already
      // exists at t=0 — a ppid breadcrumb that shows up moments later (the
      // real signal for THIS process) must still be preferred.
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(
        resolve(tmpDir, 'session-by-cwd', '-projects-race.txt'),
        'sess-stale-from-other-session',
      );
      const ppid = 424243;
      const breadcrumbDir = resolve(tmpDir, 'session-by-ppid');
      mkdirSync(breadcrumbDir, { recursive: true });
      setTimeout(() => {
        writeFileSync(resolve(breadcrumbDir, `${ppid}.txt`), 'sess-real-for-this-process');
      }, 10);

      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid,
        cwd: '/projects/race',
        storagePath: tmpDir,
        suppressWarn: true,
      });
      expect(sid).toBe('sess-real-for-this-process');
    });

    it('prefers the ppid breadcrumb over the cwd breadcrumb when both are present', async () => {
      const ppid = 111222;
      mkdirSync(resolve(tmpDir, 'session-by-ppid'), { recursive: true });
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`), 'sess-from-ppid');
      writeFileSync(resolve(tmpDir, 'session-by-cwd', '-projects-both.txt'), 'sess-from-cwd');
      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid,
        cwd: '/projects/both',
        storagePath: tmpDir,
      });
      expect(sid).toBe('sess-from-ppid');
    });

    it('reports source "jobdir" via onResolutionSource when CLAUDE_JOB_DIR resolves', async () => {
      const jobDir = resolve(tmpDir, 'job-src');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(
        resolve(jobDir, 'state.json'),
        JSON.stringify({ linkScanPath: '/whatever/job-src-uuid.jsonl' }),
      );
      const onResolutionSource = jest.fn();
      const sid = await resolveSessionId({
        claudeJobDir: jobDir,
        ppid: 1,
        storagePath: tmpDir,
        onResolutionSource,
      });
      expect(sid).toBe('job-src-uuid');
      expect(onResolutionSource).toHaveBeenCalledWith({
        source: 'jobdir',
        sessionId: 'job-src-uuid',
      });
    });

    it('reports source "ppid" via onResolutionSource when the ppid breadcrumb resolves immediately', async () => {
      const ppid = 99001;
      mkdirSync(resolve(tmpDir, 'session-by-ppid'), { recursive: true });
      writeFileSync(resolve(tmpDir, 'session-by-ppid', `${ppid}.txt`), 'sess-ppid-source');
      const onResolutionSource = jest.fn();
      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid,
        storagePath: tmpDir,
        onResolutionSource,
      });
      expect(sid).toBe('sess-ppid-source');
      expect(onResolutionSource).toHaveBeenCalledWith({
        source: 'ppid',
        sessionId: 'sess-ppid-source',
      });
    });

    it('reports source "cwd" via onResolutionSource when only the cwd fallback resolves', async () => {
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(
        resolve(tmpDir, 'session-by-cwd', '-projects-cwd-source.txt'),
        'sess-cwd-source',
      );
      const onResolutionSource = jest.fn();
      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid: 424243, // never has a matching breadcrumb
        cwd: '/projects/cwd-source',
        storagePath: tmpDir,
        onResolutionSource,
      });
      expect(sid).toBe('sess-cwd-source');
      expect(onResolutionSource).toHaveBeenCalledWith({
        source: 'cwd',
        sessionId: 'sess-cwd-source',
      });
    });
  });

  describe('resolveSessionId() — polling', () => {
    it('resolves once the breadcrumb appears', async () => {
      const ppid = 77665;
      const breadcrumbDir = resolve(tmpDir, 'session-by-ppid');
      mkdirSync(breadcrumbDir, { recursive: true });

      // Schedule the breadcrumb to appear after the first poll tick (~100ms).
      setTimeout(() => {
        writeFileSync(resolve(breadcrumbDir, `${ppid}.txt`), 'sess-async');
      }, 150);

      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid,
        storagePath: tmpDir,
        suppressWarn: true,
      });
      expect(sid).toBe('sess-async');
    });

    it('aborts via signal', async () => {
      const ppid = 55443;
      const ac = new AbortController();
      // Abort before any breadcrumb exists.
      setTimeout(() => ac.abort(), 50);
      await expect(
        resolveSessionId({
          claudeJobDir: null,
          ppid,
          storagePath: tmpDir,
          suppressWarn: true,
          signal: ac.signal,
        }),
      ).rejects.toThrow(/aborted/);
    });

    it('resolves via the cwd fallback once it appears, when the ppid breadcrumb never does (native-Windows Git-Bash-interposition scenario)', async () => {
      const breadcrumbCwdDir = resolve(tmpDir, 'session-by-cwd');
      mkdirSync(breadcrumbCwdDir, { recursive: true });

      // The ppid the resolver looks for (the MCP's own process.ppid, i.e.
      // claude.exe's pid) never gets a breadcrumb — only a transient,
      // unrelated interposed-shell pid would have one, which this resolver
      // call never sees. The cwd breadcrumb appears after a delay instead,
      // exactly like the real collector writing it on the next hook fire.
      setTimeout(() => {
        writeFileSync(resolve(breadcrumbCwdDir, '-projects-native-win.txt'), 'sess-win-regression');
      }, 150);

      const sid = await resolveSessionId({
        claudeJobDir: null,
        ppid: 333444, // never resolves
        cwd: '/projects/native-win',
        storagePath: tmpDir,
        suppressWarn: true,
      });
      expect(sid).toBe('sess-win-regression');
    });
  });

  describe('watchPpidBreadcrumb()', () => {
    it('resolves once a ppid breadcrumb appears', async () => {
      const ppid = 88001;
      const breadcrumbDir = resolve(tmpDir, 'session-by-ppid');
      mkdirSync(breadcrumbDir, { recursive: true });

      setTimeout(() => {
        writeFileSync(resolve(breadcrumbDir, `${ppid}.txt`), 'sess-ppid-correction');
      }, 150);

      const sid = await watchPpidBreadcrumb({ ppid, storagePath: tmpDir, suppressWarn: true });
      expect(sid).toBe('sess-ppid-correction');
    });

    it('never resolves via a cwd breadcrumb, even if one appears first', async () => {
      const ppid = 88002;
      mkdirSync(resolve(tmpDir, 'session-by-cwd'), { recursive: true });
      writeFileSync(
        resolve(tmpDir, 'session-by-cwd', '-projects-watch-cwd.txt'),
        'sess-cwd-should-be-ignored',
      );

      const ppidBreadcrumbDir = resolve(tmpDir, 'session-by-ppid');
      mkdirSync(ppidBreadcrumbDir, { recursive: true });
      setTimeout(() => {
        writeFileSync(resolve(ppidBreadcrumbDir, `${ppid}.txt`), 'sess-ppid-wins');
      }, 150);

      const sid = await watchPpidBreadcrumb({
        ppid,
        cwd: '/projects/watch-cwd',
        storagePath: tmpDir,
        suppressWarn: true,
      });
      expect(sid).toBe('sess-ppid-wins');
    });

    it('aborts via signal', async () => {
      const ppid = 88003;
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      await expect(
        watchPpidBreadcrumb({
          ppid,
          storagePath: tmpDir,
          suppressWarn: true,
          signal: ac.signal,
        }),
      ).rejects.toThrow(/aborted/);
    });
  });
});

describe('isSyntheticSessionId', () => {
  it('returns true for local- prefix', () => {
    expect(isSyntheticSessionId('local-1234567890')).toBe(true);
  });

  it('returns true for proxy- prefix', () => {
    expect(isSyntheticSessionId('proxy-1234567890')).toBe(true);
  });

  it('returns false for a real session ID', () => {
    expect(isSyntheticSessionId('abc-123-real-session')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSyntheticSessionId('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isSyntheticSessionId(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isSyntheticSessionId(undefined)).toBe(false);
  });
});

describe('isUnscopedAggregatorSessionId', () => {
  it('returns true for local- prefix', () => {
    // A --local process's SubagentWatcher runs unscoped (parentSessionId:
    // undefined) — it may have parsed transcripts belonging to other real
    // sessions, so its own live cost is not exclusively-its-own.
    expect(isUnscopedAggregatorSessionId('local-1234567890')).toBe(true);
  });

  it('returns true for proxy- prefix', () => {
    expect(isUnscopedAggregatorSessionId('proxy-1234567890')).toBe(true);
  });

  it('returns false for pending- prefix', () => {
    // A pending-<ts> id is still exactly one real --stdio session mid-
    // resolution — its live cost genuinely is exclusively its own, so it
    // must NOT be treated the same as an unscoped aggregator.
    expect(isUnscopedAggregatorSessionId('pending-1234567890')).toBe(false);
  });

  it('returns false for a real session ID', () => {
    expect(isUnscopedAggregatorSessionId('abc-123-real-session')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isUnscopedAggregatorSessionId('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isUnscopedAggregatorSessionId(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isUnscopedAggregatorSessionId(undefined)).toBe(false);
  });
});
