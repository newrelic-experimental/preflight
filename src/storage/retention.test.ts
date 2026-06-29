import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { purgeOldSessions } from './retention.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = resolve(tmpdir(), randomUUID());
  mkdirSync(resolve(dir, 'sessions'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeSessionFile(storagePath: string, name: string): void {
  const path = resolve(storagePath, 'sessions', name);
  writeFileSync(path, JSON.stringify({ sessionId: name }), { mode: 0o600 });
  // Note: fs mtime reflects actual write time; Jest fake timers do not affect it.
  // Tests for "old file deletion" would require utimes() — omitted here.
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('purgeOldSessions', () => {
  it('returns 0 when sessions directory does not exist', () => {
    const dir = resolve(tmpdir(), randomUUID()); // never created
    expect(purgeOldSessions(dir, 30)).toBe(0);
  });

  it('does not delete recently-created files', () => {
    const dir = makeTempDir();
    writeSessionFile(dir, '2026-04-27_session1.json');
    const deleted = purgeOldSessions(dir, 30);
    expect(deleted).toBe(0);
    expect(existsSync(resolve(dir, 'sessions', '2026-04-27_session1.json'))).toBe(true);
  });

  it('returns 0 for empty sessions directory', () => {
    const dir = makeTempDir();
    expect(purgeOldSessions(dir, 30)).toBe(0);
  });

  it('ignores non-JSON files', () => {
    const dir = makeTempDir();
    writeFileSync(resolve(dir, 'sessions', 'readme.txt'), 'ignore me');
    expect(purgeOldSessions(dir, 0)).toBe(0); // 0 day retention: only .json deleted
  });

  it('deletes JSON files older than retainDays', () => {
    const dir = makeTempDir();
    const filePath = resolve(dir, 'sessions', '2026-01-01_old-session.json');
    writeFileSync(filePath, JSON.stringify({ sessionId: 'old' }), { mode: 0o600 });
    // Back-date mtime to 40 days ago
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, oldDate, oldDate);

    const deleted = purgeOldSessions(dir, 30);
    expect(deleted).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it('keeps files younger than retainDays', () => {
    const dir = makeTempDir();
    const filePath = resolve(dir, 'sessions', '2026-01-01_recent-enough.json');
    writeFileSync(filePath, JSON.stringify({ sessionId: 'recent' }), { mode: 0o600 });
    // Back-date to 29 days ago — should be kept under 30-day retention
    const recentDate = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, recentDate, recentDate);

    const deleted = purgeOldSessions(dir, 30);
    expect(deleted).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU / interruption tests
// ---------------------------------------------------------------------------

describe('purgeOldSessions — interruption and TOCTOU', () => {
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

  it('continues purging remaining files when unlinkSync throws for one entry (EISDIR)', () => {
    const dir = makeTempDir();
    const sessionsDir = resolve(dir, 'sessions');

    // Two real old session files
    const file1 = join(sessionsDir, '2026-01-01_real1.json');
    const file2 = join(sessionsDir, '2026-01-01_real2.json');
    writeFileSync(file1, JSON.stringify({ sessionId: 'real1' }), { mode: 0o600 });
    writeFileSync(file2, JSON.stringify({ sessionId: 'real2' }), { mode: 0o600 });
    utimesSync(file1, oldDate, oldDate);
    utimesSync(file2, oldDate, oldDate);

    // A directory with a .json name — statSync sees its (old) mtime, but unlinkSync throws EISDIR
    const fakeDir = join(sessionsDir, '2026-01-01_fake.json');
    mkdirSync(fakeDir);
    utimesSync(fakeDir, oldDate, oldDate);

    const deleted = purgeOldSessions(dir, 30);

    // The two real files are deleted; the directory entry survives
    expect(deleted).toBe(2);
    expect(existsSync(file1)).toBe(false);
    expect(existsSync(file2)).toBe(false);
    expect(existsSync(fakeDir)).toBe(true);

    // A warning was logged for the failing entry
    const logged = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged.some((l: string) => l.includes('"warn"') && l.includes('session file'))).toBe(
      true,
    );
  });

  it('continues purging when statSync throws for a dangling symlink (TOCTOU: file vanished after readdir)', () => {
    const dir = makeTempDir();
    const sessionsDir = resolve(dir, 'sessions');

    // A real old file that should be purged
    const realFile = join(sessionsDir, '2026-01-01_real.json');
    writeFileSync(realFile, JSON.stringify({ sessionId: 'real' }), { mode: 0o600 });
    utimesSync(realFile, oldDate, oldDate);

    // Dangling symlink: shows up in readdirSync but statSync follows it and throws ENOENT,
    // simulating a file that was deleted between the readdir and stat calls.
    const dangling = join(sessionsDir, '2026-01-01_dangling.json');
    symlinkSync('/nonexistent_target_nr_retention_test', dangling);

    const deleted = purgeOldSessions(dir, 30);

    // Real file is deleted; dangling symlink triggers a caught error and is left untouched
    expect(deleted).toBe(1);
    expect(existsSync(realFile)).toBe(false);
    // The symlink itself still exists (we never reached unlinkSync for it)
    expect(() => lstatSync(dangling)).not.toThrow();

    const logged = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged.some((l: string) => l.includes('"warn"') && l.includes('session file'))).toBe(
      true,
    );
  });

  it('handles sessions-directory write permission revoked mid-purge, then succeeds on retry', () => {
    if (process.getuid?.() === 0) return; // root bypasses permission checks

    const dir = makeTempDir();
    const sessionsDir = resolve(dir, 'sessions');

    const file1 = join(sessionsDir, '2026-01-01_a.json');
    const file2 = join(sessionsDir, '2026-01-01_b.json');
    writeFileSync(file1, JSON.stringify({ sessionId: 'a' }), { mode: 0o600 });
    writeFileSync(file2, JSON.stringify({ sessionId: 'b' }), { mode: 0o600 });
    utimesSync(file1, oldDate, oldDate);
    utimesSync(file2, oldDate, oldDate);

    // Revoke write permission on the sessions directory — statSync succeeds but unlinkSync fails
    chmodSync(sessionsDir, 0o555);

    try {
      const sweep1 = purgeOldSessions(dir, 30);
      expect(sweep1).toBe(0);
      expect(existsSync(file1)).toBe(true);
      expect(existsSync(file2)).toBe(true);

      const logged = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(logged.some((l: string) => l.includes('"warn"') && l.includes('session file'))).toBe(
        true,
      );
    } finally {
      chmodSync(sessionsDir, 0o700);
    }

    // Restore permissions and sweep again — files are now deleted (retried next sweep)
    const sweep2 = purgeOldSessions(dir, 30);
    expect(sweep2).toBe(2);
    expect(existsSync(file1)).toBe(false);
    expect(existsSync(file2)).toBe(false);
  });
});
