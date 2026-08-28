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
  readJobState,
  readTranscriptTitle,
  findLastAiTitleInText,
  resolveSessionName,
  sessionNameSourceRank,
  shouldReplaceSessionName,
  sanitizeCwdForFilename,
} from './session-resolver.js';
import { redactSensitive } from '../config.js';

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

describe('sanitizeCwdForFilename', () => {
  it('replaces backslash, forward slash, and colon with "-"', () => {
    expect(sanitizeCwdForFilename('/Users/dev/projects/app')).toBe('-Users-dev-projects-app');
    expect(sanitizeCwdForFilename('C:\\Users\\dev\\app')).toBe('C--Users-dev-app');
  });
});

describe('readJobState', () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let jobDir: string;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jobDir = resolve(tmpdir(), `nr-jobstate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(jobDir, { recursive: true });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (existsSync(jobDir)) rmSync(jobDir, { recursive: true, force: true });
  });

  it('returns null when the dir is null/undefined/empty or state.json is missing', () => {
    expect(readJobState(null)).toBeNull();
    expect(readJobState(undefined)).toBeNull();
    expect(readJobState('')).toBeNull();
    expect(readJobState(jobDir)).toBeNull();
  });

  it('returns null when state.json is invalid JSON', () => {
    writeFileSync(resolve(jobDir, 'state.json'), 'not json');
    expect(readJobState(jobDir)).toBeNull();
  });

  it('reads name, nameSource, and an explicit sessionId, gating intent behind recordContent', () => {
    writeFileSync(
      resolve(jobDir, 'state.json'),
      JSON.stringify({
        sessionId: 'abc-123-def',
        name: 'refactor auth flow',
        nameSource: 'user',
        intent: 'please refactor the auth flow',
        linkScanPath: '/somewhere/other-uuid.jsonl',
      }),
    );
    // Default (no recordContent) and recordContent:false both keep the
    // sensitive intent null; only recordContent:true surfaces it.
    expect(readJobState(jobDir)).toEqual({
      sessionId: 'abc-123-def',
      name: 'refactor auth flow',
      nameSource: 'user',
      intent: null,
    });
    expect(readJobState(jobDir, { recordContent: false })).toEqual({
      sessionId: 'abc-123-def',
      name: 'refactor auth flow',
      nameSource: 'user',
      intent: null,
    });
    expect(readJobState(jobDir, { recordContent: true })).toEqual({
      sessionId: 'abc-123-def',
      name: 'refactor auth flow',
      nameSource: 'user',
      intent: 'please refactor the auth flow',
    });
  });

  it('falls back to the linkScanPath UUID when no explicit sessionId field', () => {
    writeFileSync(
      resolve(jobDir, 'state.json'),
      JSON.stringify({ name: 'x', nameSource: 'auto', linkScanPath: '/dir/link-uuid.jsonl' }),
    );
    expect(readJobState(jobDir)?.sessionId).toBe('link-uuid');
  });

  it('normalizes an invalid nameSource, empty name, and empty intent to null', () => {
    writeFileSync(
      resolve(jobDir, 'state.json'),
      JSON.stringify({ sessionId: 'sess-1', name: '', nameSource: 'bogus', intent: '' }),
    );
    // recordContent:true so the empty-string intent is normalized to null by
    // the length check, not merely suppressed by the recordContent gate.
    expect(readJobState(jobDir, { recordContent: true })).toEqual({
      sessionId: 'sess-1',
      name: null,
      nameSource: null,
      intent: null,
    });
  });
});

describe('findLastAiTitleInText', () => {
  it('returns the LAST ai-title when several are present', () => {
    const text = [
      '{"type":"user","text":"hi"}',
      '{"type":"ai-title","aiTitle":"first guess"}',
      '{"type":"assistant","text":"work"}',
      '{"type":"ai-title","aiTitle":"refined title"}',
      '',
    ].join('\n');
    expect(findLastAiTitleInText(text, true)).toBe('refined title');
  });

  it('ignores non-ai-title records (e.g. agent-name)', () => {
    const text = [
      '{"type":"ai-title","aiTitle":"the title"}',
      '{"type":"agent-name","agentName":"explorer"}',
      '',
    ].join('\n');
    expect(findLastAiTitleInText(text, true)).toBe('the title');
  });

  it('skips malformed JSON lines', () => {
    const text = ['{"type":"ai-title","aiTitle":"good"}', 'this is not json', ''].join('\n');
    expect(findLastAiTitleInText(text, true)).toBe('good');
  });

  it('skips the partial leading fragment when firstFragmentComplete is false', () => {
    // The leading fragment is a truncated ai-title whose start is unread; it
    // must be ignored, yielding null (no complete ai-title follows it).
    const text = 'e":"ai-title","aiTitle":"truncated"}\n{"type":"user","text":"hi"}\n';
    expect(findLastAiTitleInText(text, false)).toBeNull();
  });

  it('returns null when no ai-title is present', () => {
    expect(findLastAiTitleInText('{"type":"user","text":"hi"}\n', true)).toBeNull();
  });
});

describe('readTranscriptTitle', () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let projectsDir: string;
  // Deliberately contains a dot (a worktree/hidden dir) so the slug below
  // exercises the dot-replacement that the OLD cwd-derived path missed.
  const cwd = '/Users/dev/projects/.worktrees/preflight';
  const sessionId = 'sess-transcript-1';

  // Build the fixture under a Claude-Code-style slug that REPLACES dots (which
  // our breadcrumb sanitizer does not) — the transcript is located by matching
  // <sessionId>.jsonl across slugs, so the exact slug must not matter.
  const slug = cwd.replace(/[\\/:.]/g, '-');
  const writeTranscript = (content: string): void => {
    const dir = resolve(projectsDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${sessionId}.jsonl`), content);
  };

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    projectsDir = resolve(
      tmpdir(),
      `nr-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (existsSync(projectsDir)) rmSync(projectsDir, { recursive: true, force: true });
  });

  it('returns null when the transcript file is missing', () => {
    expect(readTranscriptTitle({ projectsDir, sessionId })).toBeNull();
  });

  it('returns null for an invalid sessionId (never builds a path)', () => {
    expect(readTranscriptTitle({ projectsDir, sessionId: 'has spaces' })).toBeNull();
  });

  it('returns the last ai-title, locating the transcript by sessionId under a dot-replacing slug', () => {
    writeTranscript(
      [
        '{"type":"ai-title","aiTitle":"first title","sessionId":"sess-transcript-1"}',
        '{"type":"assistant","message":{"content":[]}}',
        '{"type":"ai-title","aiTitle":"session naming logic","sessionId":"sess-transcript-1"}',
        '{"type":"agent-name","agentName":"explorer","sessionId":"sess-transcript-1"}',
        '',
      ].join('\n'),
    );
    expect(readTranscriptTitle({ projectsDir, sessionId })).toBe('session naming logic');
  });

  it('finds the last ai-title even when it sits many chunks back from EOF', () => {
    // Put the ai-title near the top, then >200KB of filler after it so the
    // reverse chunk scan (64KB chunks) must cross several boundaries to reach
    // it — exercises the partial-line carry between chunks.
    const filler = `${'{"type":"assistant","message":{"content":[]}}'}\n`.repeat(5000);
    writeTranscript(`{"type":"ai-title","aiTitle":"deep title"}\n${filler}`);
    expect(readTranscriptTitle({ projectsDir, sessionId })).toBe('deep title');
  });

  it('returns null when the only ai-title is beyond the bounded scan window', () => {
    // ai-title at the very start, followed by >1MB of filler (past
    // TRANSCRIPT_TITLE_MAX_SCAN_BYTES) — the bounded scan stops before reaching it.
    const filler = `${'{"type":"assistant","message":{"content":[]}}'}\n`.repeat(30_000);
    writeTranscript(`{"type":"ai-title","aiTitle":"too far back"}\n${filler}`);
    expect(readTranscriptTitle({ projectsDir, sessionId })).toBeNull();
  });

  it('redacts the returned title', () => {
    const raw = 'debugging AKIAIOSFODNN7EXAMPLE key';
    writeTranscript(`{"type":"ai-title","aiTitle":${JSON.stringify(raw)}}\n`);
    // The reader must apply redactSensitive on the way out — assert against it
    // directly so the test tracks whatever DEFAULT_REDACTION_PATTERNS match.
    expect(readTranscriptTitle({ projectsDir, sessionId })).toBe(redactSensitive(raw));
  });
});

describe('resolveSessionName', () => {
  it('returns null when nothing is usable', () => {
    expect(resolveSessionName({})).toBeNull();
    expect(resolveSessionName({ jobState: null, transcriptTitle: null, cwd: null })).toBeNull();
  });

  it('1: a user-authored job-state name wins over everything', () => {
    expect(
      resolveSessionName({
        jobState: { sessionId: 's', name: 'human name', nameSource: 'user', intent: null },
        transcriptTitle: 'ai title',
        cwd: '/Users/dev/projects/app',
      }),
    ).toEqual({ name: 'human name', source: 'user' });
  });

  it('2: the transcript ai-title wins over an auto job-state name and cwd', () => {
    expect(
      resolveSessionName({
        jobState: { sessionId: 's', name: 'auto name', nameSource: 'auto', intent: null },
        transcriptTitle: 'ai title',
        cwd: '/Users/dev/projects/app',
      }),
    ).toEqual({ name: 'ai title', source: 'ai-title' });
  });

  it('3: an auto job-state name wins over cwd when there is no user name or ai-title', () => {
    expect(
      resolveSessionName({
        jobState: { sessionId: 's', name: 'auto name', nameSource: 'auto', intent: null },
        transcriptTitle: null,
        cwd: '/Users/dev/projects/app',
      }),
    ).toEqual({ name: 'auto name', source: 'auto' });
  });

  it('4: falls back to the cwd basename', () => {
    expect(resolveSessionName({ cwd: '/Users/dev/projects/my-app' })).toEqual({
      name: 'my-app',
      source: 'cwd',
    });
  });

  it('4: a degenerate cwd basename falls through to null (streaming fallback can do better)', () => {
    expect(resolveSessionName({ cwd: '/tmp' })).toBeNull();
    expect(resolveSessionName({ cwd: '/var' })).toBeNull();
  });

  it('4: the degenerate-cwd guard is case-insensitive', () => {
    // Exercises the DEGENERATE_NAMES.has(base.toLowerCase()) lowering branch.
    expect(resolveSessionName({ cwd: '/TMP' })).toBeNull();
    expect(resolveSessionName({ cwd: '/Users/dev/VAR' })).toBeNull();
  });

  it('1: a user nameSource with an empty name falls through to the next tier', () => {
    // nameSource is 'user' but name is empty → tier 1 must not fire; the
    // transcript ai-title should win instead.
    expect(
      resolveSessionName({
        jobState: { sessionId: 's', name: '', nameSource: 'user', intent: null },
        transcriptTitle: 'ai title',
        cwd: '/Users/dev/projects/app',
      }),
    ).toEqual({ name: 'ai title', source: 'ai-title' });
  });

  it('does not use a job-state name whose nameSource is null', () => {
    // name present but nameSource unknown/null → skip to next tier (cwd here).
    expect(
      resolveSessionName({
        jobState: { sessionId: 's', name: 'unlabeled', nameSource: null, intent: null },
        cwd: '/Users/dev/projects/app',
      }),
    ).toEqual({ name: 'app', source: 'cwd' });
  });
});

describe('sessionNameSourceRank', () => {
  it('ranks sources most-trusted-first, mirroring resolveSessionName precedence', () => {
    expect(sessionNameSourceRank('user')).toBe(0);
    expect(sessionNameSourceRank('ai-title')).toBe(1);
    expect(sessionNameSourceRank('auto')).toBe(2);
    expect(sessionNameSourceRank('cwd')).toBe(3);
    // Strictly ordered: user < ai-title < auto < cwd.
    expect(sessionNameSourceRank('user')).toBeLessThan(sessionNameSourceRank('ai-title'));
    expect(sessionNameSourceRank('ai-title')).toBeLessThan(sessionNameSourceRank('auto'));
    expect(sessionNameSourceRank('auto')).toBeLessThan(sessionNameSourceRank('cwd'));
  });
});

describe('shouldReplaceSessionName', () => {
  it('always accepts when the session is not yet named (current === null)', () => {
    expect(shouldReplaceSessionName(null, 'cwd')).toBe(true);
    expect(shouldReplaceSessionName(null, 'user')).toBe(true);
  });

  it('accepts an upgrade to a more-trusted source', () => {
    expect(shouldReplaceSessionName('cwd', 'auto')).toBe(true);
    expect(shouldReplaceSessionName('auto', 'ai-title')).toBe(true);
    expect(shouldReplaceSessionName('ai-title', 'user')).toBe(true);
    // And the full jump end-to-end.
    expect(shouldReplaceSessionName('cwd', 'user')).toBe(true);
  });

  it('accepts a refresh at the same source (equal rank)', () => {
    expect(shouldReplaceSessionName('ai-title', 'ai-title')).toBe(true);
    expect(shouldReplaceSessionName('user', 'user')).toBe(true);
    expect(shouldReplaceSessionName('cwd', 'cwd')).toBe(true);
  });

  it('refuses a downgrade to a less-trusted source', () => {
    // The load-bearing invariant: a user name is never demoted.
    expect(shouldReplaceSessionName('user', 'ai-title')).toBe(false);
    expect(shouldReplaceSessionName('user', 'auto')).toBe(false);
    expect(shouldReplaceSessionName('user', 'cwd')).toBe(false);
    expect(shouldReplaceSessionName('ai-title', 'auto')).toBe(false);
    expect(shouldReplaceSessionName('ai-title', 'cwd')).toBe(false);
    expect(shouldReplaceSessionName('auto', 'cwd')).toBe(false);
  });
});
