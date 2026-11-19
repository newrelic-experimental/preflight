/**
 * The Copilot app's usage from its `data.db` counters to a session's cost:
 * CopilotAppUsageWatcher, the hook buffer, HookEventProcessor, the token-usage
 * sinks src/index.ts uses, CostTracker, and SessionStore across a restart. The
 * app exposes no per-request id, so each delta is named by the counter range
 * it covers; these tests pin that a re-read, a lost cursor and a counter reset
 * still count every token once. The database is a SQLite file with the app's
 * `sessions` columns, as in copilot-app-usage-watcher.test.ts: no real app
 * database was available to test against.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CostTracker } from '../metrics/cost-tracker.js';
import { costSeedOf } from '../metrics/first-save-baselines.js';
import { LocalSessionAggregator } from '../metrics/local-session-aggregator.js';
import { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import type { SessionTracker } from '../metrics/session-tracker.js';
import { recordTokenEventUsage } from '../metrics/usage-recording.js';
import { LocalStore } from '../storage/local-store.js';
import { SessionStore, buildSessionSummary } from '../storage/session-store.js';
import { CopilotAppUsageWatcher } from './copilot-app-usage-watcher.js';
import { HookEventProcessor } from './event-processor.js';

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MODEL = 'claude-sonnet-4-5';

interface Totals {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
}

function createDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, model TEXT, is_running INTEGER,
      created_at TEXT, updated_at TEXT,
      total_input_tokens INTEGER, total_output_tokens INTEGER,
      total_cached_tokens INTEGER, total_reasoning_tokens INTEGER,
      total_nano_aiu INTEGER, execution_location TEXT
    )
  `);
  db.close();
}

function setTotals(dbPath: string, t: Totals): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO sessions (id, model, updated_at, total_input_tokens, total_output_tokens,
       total_cached_tokens, total_reasoning_tokens)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
       total_input_tokens = excluded.total_input_tokens,
       total_output_tokens = excluded.total_output_tokens,
       total_cached_tokens = excluded.total_cached_tokens`,
  ).run(SESSION_ID, MODEL, new Date().toISOString(), t.input, t.output, t.cached);
  db.close();
}

function sessionTracker(): SessionTracker {
  const start = Date.now();
  return {
    getMetrics: () => ({
      sessionId: SESSION_ID,
      sessionName: null,
      sessionStartTime: start,
      toolCallCount: 0,
      toolCallCountByTool: {},
      bashCommandsRun: 0,
      toolSuccessRate: null,
    }),
  } as unknown as SessionTracker;
}

/** One --stdio engine process for the session: reads the buffer into its own trackers. */
class Engine {
  readonly cost = new CostTracker();
  private readonly models = new ModelUsageTracker();
  private readonly processor: HookEventProcessor;
  private readonly store: LocalStore;

  constructor(private readonly storagePath: string) {
    const persisted = new SessionStore({ storagePath }).loadSession(SESSION_ID);
    if (persisted) this.cost.seedFromPersisted(costSeedOf(persisted).costTracker);
    this.store = new LocalStore(storagePath, SESSION_ID);
    const sinks = {
      costTracker: this.cost,
      modelUsageTracker: this.models,
      localSessionAggregator: new LocalSessionAggregator(),
    };
    this.processor = new HookEventProcessor({
      store: this.store,
      onRecord: () => undefined,
      onTokenEvent: (e) => {
        recordTokenEventUsage(sinks, e, true);
      },
    });
  }

  pump(): void {
    this.processor.processEvents(this.store.drainBuffer());
  }

  save(): void {
    new SessionStore({ storagePath: this.storagePath }).saveSession(
      buildSessionSummary({
        sessionTracker: sessionTracker(),
        costTracker: this.cost,
        modelUsageTracker: this.models,
        developer: 'dev',
      }),
    );
  }
}

describe('Copilot app usage, from data.db to session cost', () => {
  let storagePath: string;
  let copilotDir: string;
  let dbPath: string;

  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    storagePath = mkdtempSync(join(tmpdir(), 'copilot-app-cost-'));
    copilotDir = mkdtempSync(join(tmpdir(), 'copilot-app-db-'));
    dbPath = join(copilotDir, 'data.db');
    createDb(dbPath);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(copilotDir, { recursive: true, force: true });
  });

  const watcher = (): CopilotAppUsageWatcher =>
    new CopilotAppUsageWatcher({ storagePath, copilotDir, parentSessionId: SESSION_ID });
  const cursorPath = (): string => join(storagePath, `.copilot-app-usage-pos-${SESSION_ID}`);

  /** The app's own counters are the truth: every token they grew by, once. */
  function expectCounted(cost: CostTracker, t: Totals): void {
    const m = cost.getMetrics();
    expect(m.totalInputTokens + m.totalCacheReadTokens).toBe(t.input);
    expect(m.totalCacheReadTokens).toBe(t.cached);
    expect(m.totalOutputTokens).toBe(t.output);
  }

  it('counts a delta once when a crash re-reads it after a restart', () => {
    const w = watcher();
    setTotals(dbPath, { input: 1_000, output: 100, cached: 200 });
    w.poll();
    // The app grows; the watcher buffers the delta, then the process dies
    // before its cursor write lands, so the next poll reads the same range.
    setTotals(dbPath, { input: 3_000, output: 400, cached: 900 });
    const before = join(storagePath, 'cursor-before');
    copyFileSync(cursorPath(), before);
    w.poll();
    const a = new Engine(storagePath);
    a.pump();
    a.save();
    copyFileSync(before, cursorPath());

    watcher().poll();
    const b = new Engine(storagePath);
    b.pump();
    b.save();

    expectCounted(b.cost, { input: 3_000, output: 400, cached: 900 });
    expectCounted(new Engine(storagePath).cost, { input: 3_000, output: 400, cached: 900 });
  });

  it('counts the growth a crash re-read carries past the range already counted', () => {
    const w = watcher();
    setTotals(dbPath, { input: 1_000, output: 100, cached: 200 });
    w.poll();
    setTotals(dbPath, { input: 3_000, output: 400, cached: 900 });
    const before = join(storagePath, 'cursor-before');
    copyFileSync(cursorPath(), before);
    w.poll();
    const a = new Engine(storagePath);
    a.pump();
    a.save();
    // The cursor write was lost, and the app grew before the restart: the
    // re-read covers the counted range and more.
    copyFileSync(before, cursorPath());
    setTotals(dbPath, { input: 3_600, output: 450, cached: 1_000 });
    watcher().poll();
    const b = new Engine(storagePath);
    b.pump();
    b.save();

    expectCounted(b.cost, { input: 3_600, output: 450, cached: 1_000 });
    expectCounted(new Engine(storagePath).cost, { input: 3_600, output: 450, cached: 1_000 });
  });

  it('counts only the new growth when a lost cursor re-reports the session from zero', () => {
    setTotals(dbPath, { input: 1_000, output: 100, cached: 0 });
    watcher().poll();
    setTotals(dbPath, { input: 2_500, output: 300, cached: 500 });
    watcher().poll();
    const a = new Engine(storagePath);
    a.pump();
    a.save();

    // The cursor is lost after the app has grown again: the re-read from zero
    // carries that growth.
    unlinkSync(cursorPath());
    setTotals(dbPath, { input: 3_000, output: 400, cached: 600 });
    watcher().poll();
    setTotals(dbPath, { input: 4_000, output: 600, cached: 800 });
    watcher().poll();
    const b = new Engine(storagePath);
    b.pump();
    b.save();

    expect(existsSync(cursorPath())).toBe(true);
    expectCounted(b.cost, { input: 4_000, output: 600, cached: 800 });
  });

  it('counts growth after the app resets its counters', () => {
    setTotals(dbPath, { input: 5_000, output: 500, cached: 0 });
    watcher().poll();
    setTotals(dbPath, { input: 1_000, output: 50, cached: 0 });
    watcher().poll();
    setTotals(dbPath, { input: 3_000, output: 250, cached: 0 });
    watcher().poll();
    const engine = new Engine(storagePath);
    engine.pump();

    // 5,000 before the reset, then 2,000 more after it.
    expectCounted(engine.cost, { input: 7_000, output: 700, cached: 0 });
  });
});
