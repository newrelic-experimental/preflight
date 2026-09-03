import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getLogOutput } from '../__test-utils__/log-output.js';
import { LocalStore } from '../storage/local-store.js';
import { CopilotAppUsageWatcher } from './copilot-app-usage-watcher.js';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'copilot-app-usage-watcher-test-'));
}

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_SESSION_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

interface SessionRow {
  readonly id: string;
  readonly model: string | null;
  readonly updated_at?: string;
  readonly total_input_tokens: number;
  readonly total_output_tokens: number;
  readonly total_cached_tokens: number;
  readonly total_reasoning_tokens: number;
}

function createDb(dbPath: string, withCachedColumn = true): void {
  const db = new DatabaseSync(dbPath);
  const cachedCol = withCachedColumn ? 'total_cached_tokens INTEGER,' : '';
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      model TEXT,
      is_running INTEGER,
      created_at TEXT,
      updated_at TEXT,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      ${cachedCol}
      total_reasoning_tokens INTEGER,
      total_nano_aiu INTEGER,
      execution_location TEXT
    )
  `);
  db.close();
}

function upsertRow(dbPath: string, row: SessionRow): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO sessions
       (id, model, updated_at, total_input_tokens, total_output_tokens, total_cached_tokens, total_reasoning_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       model = excluded.model,
       updated_at = excluded.updated_at,
       total_input_tokens = excluded.total_input_tokens,
       total_output_tokens = excluded.total_output_tokens,
       total_cached_tokens = excluded.total_cached_tokens,
       total_reasoning_tokens = excluded.total_reasoning_tokens`,
  ).run(
    row.id,
    row.model,
    row.updated_at ?? new Date().toISOString(),
    row.total_input_tokens,
    row.total_output_tokens,
    row.total_cached_tokens,
    row.total_reasoning_tokens,
  );
  db.close();
}

describe('CopilotAppUsageWatcher', () => {
  let storagePath: string;
  let copilotDir: string;
  let dbPath: string;
  let stderrSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    storagePath = mkTmp();
    copilotDir = mkTmp();
    dbPath = join(copilotDir, 'data.db');
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(copilotDir, { recursive: true, force: true });
  });

  function readTokenEvents(sessionId = SESSION_ID): Record<string, unknown>[] {
    const bufPath = join(storagePath, `buffer-${sessionId}.jsonl`);
    if (!existsSync(bufPath)) return [];
    return readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.mode === 'token');
  }

  function makeWatcher(overrides?: {
    /** Pass `null` for unscoped (--local) mode; omit for the default scoped session. */
    parentSessionId?: string | null;
    localStore?: LocalStore;
  }): CopilotAppUsageWatcher {
    const parentSessionId =
      overrides && 'parentSessionId' in overrides ? overrides.parentSessionId : SESSION_ID;
    return new CopilotAppUsageWatcher({
      storagePath,
      copilotDir,
      parentSessionId: parentSessionId ?? undefined,
      localStore: overrides?.localStore,
    });
  }

  it('emits one token event on the first poll with input/cache/output split from totals', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 65016,
      total_output_tokens: 477,
      total_cached_tokens: 62361,
      total_reasoning_tokens: 0,
    });
    makeWatcher().poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mode: 'token',
      tool: 'copilot-app-usage',
      sessionId: SESSION_ID,
      model: 'claude-opus-4-7',
      inputTokens: 65016 - 62361,
      cacheReadTokens: 62361,
      cacheCreationTokens: 0,
      outputTokens: 477,
    });
  });

  it('emits nothing on a second poll with unchanged totals', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 1000,
      total_output_tokens: 100,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    const watcher = makeWatcher();
    watcher.poll();
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(1);
  });

  it('emits exactly one delta event when totals grow', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 1000,
      total_output_tokens: 100,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    const watcher = makeWatcher();
    watcher.poll();
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 1500,
      total_output_tokens: 250,
      total_cached_tokens: 200,
      total_reasoning_tokens: 0,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      inputTokens: 500 - 200,
      cacheReadTokens: 200,
      outputTokens: 150,
    });
  });

  it('re-baselines silently when totals shrink, then emits only the post-re-baseline delta', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 5000,
      total_output_tokens: 500,
      total_cached_tokens: 100,
      total_reasoning_tokens: 0,
    });
    const watcher = makeWatcher();
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(1);

    // Totals shrink (session id reused after a fork/reset).
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 200,
      total_output_tokens: 20,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(1); // no new emission

    // Next growth, measured from the shrunk baseline.
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 300,
      total_output_tokens: 50,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 0,
    });
  });

  it('sets dbMissing and emits nothing when data.db does not exist', () => {
    const watcher = makeWatcher();
    watcher.poll();
    expect(watcher.getHealth().dbMissing).toBe(true);
    expect(readTokenEvents()).toHaveLength(0);
  });

  it('increments schemaDrifts and emits nothing when the sessions table is missing an expected column', () => {
    createDb(dbPath, /* withCachedColumn */ false);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO sessions (id, model, updated_at, total_input_tokens, total_output_tokens, total_reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(SESSION_ID, 'claude-opus-4-7', new Date().toISOString(), 100, 10, 0);
    db.close();

    const watcher = makeWatcher();
    watcher.poll();
    watcher.poll(); // second failing poll must not warn again (once-per-process latch)
    expect(watcher.getHealth().schemaDrifts).toBe(2);
    expect(readTokenEvents()).toHaveLength(0);
    const warnLines = getLogOutput(stderrSpy, '\n')
      .split('\n')
      .filter((line) => line.includes('schema drift or lock'));
    expect(warnLines).toHaveLength(1);
  });

  it('skips rows whose id is not a UUID', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: 'not-a-uuid',
      model: 'claude-opus-4-7',
      total_input_tokens: 100,
      total_output_tokens: 10,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    makeWatcher({ parentSessionId: null }).poll();
    expect(readTokenEvents('not-a-uuid')).toHaveLength(0);
    expect(existsSync(join(storagePath, 'buffer-not-a-uuid.jsonl'))).toBe(false);
  });

  it('scoped mode only emits for the parent session id even with other rows present', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 100,
      total_output_tokens: 10,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    upsertRow(dbPath, {
      id: OTHER_SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 999,
      total_output_tokens: 99,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    makeWatcher({ parentSessionId: SESSION_ID }).poll();
    expect(readTokenEvents(SESSION_ID)).toHaveLength(1);
    expect(readTokenEvents(OTHER_SESSION_ID)).toHaveLength(0);
  });

  it('a new watcher instance over the same storagePath does not re-emit already-cursored totals', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 1000,
      total_output_tokens: 100,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    makeWatcher().poll();
    expect(readTokenEvents()).toHaveLength(1);

    makeWatcher().poll(); // fresh instance, same storagePath
    expect(readTokenEvents()).toHaveLength(1);
  });

  it('passes through a NULL model as "unknown"', () => {
    createDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO sessions (id, model, updated_at, total_input_tokens, total_output_tokens, total_cached_tokens, total_reasoning_tokens)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run(SESSION_ID, new Date().toISOString(), 100, 10, 0, 0);
    db.close();

    makeWatcher().poll();
    expect(readTokenEvents()[0]).toMatchObject({ model: 'unknown' });
  });

  it('builds a deterministic messageId from the session id and cumulative totals', () => {
    createDb(dbPath);
    upsertRow(dbPath, {
      id: SESSION_ID,
      model: 'claude-opus-4-7',
      total_input_tokens: 1234,
      total_output_tokens: 56,
      total_cached_tokens: 0,
      total_reasoning_tokens: 0,
    });
    makeWatcher().poll();
    expect(readTokenEvents()[0]).toMatchObject({
      messageId: `copilot-app:${SESSION_ID}:1234:56`,
    });
  });
});
