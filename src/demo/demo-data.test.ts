import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_STORAGE_PATH } from '../config.js';
import { isSyntheticSessionId } from '../hooks/session-resolver.js';
import { localDateKey } from '../lib/date.js';
import { SessionStore } from '../storage/session-store.js';
import { buildDemoData } from './demo-data.js';
import { demoEnv, seedDemoDir } from './demo-command.js';

const NOW = new Date(2026, 10, 2, 15, 30);

let tmpDir: string;

beforeEach(() => {
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  tmpDir = resolve(tmpdir(), `nr-demo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('buildDemoData', () => {
  it('is deterministic for a given now', () => {
    expect(JSON.stringify(buildDemoData(NOW))).toBe(JSON.stringify(buildDemoData(NOW)));
  });

  it('produces session ids the dashboard will list and open', () => {
    for (const s of buildDemoData(NOW).sessions) {
      expect(isSyntheticSessionId(s.sessionId)).toBe(false);
      expect(s.sessionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    }
  });

  it('fills today with sessions that ended before now and carry today-keyed cost', () => {
    const today = buildDemoData(NOW).sessions.filter(
      (s) => localDateKey(s.startTime) === localDateKey(NOW.getTime()),
    );
    expect(today.length).toBeGreaterThanOrEqual(6);
    for (const s of today) {
      expect(s.endTime).toBeLessThanOrEqual(NOW.getTime());
      expect(s.costByDayUsd?.[localDateKey(NOW.getTime())]).toBeGreaterThan(0);
    }
  });

  it('derives aggregates from the timeline so panels agree', () => {
    for (const s of buildDemoData(NOW).sessions) {
      expect(s.toolCallCount).toBe(s.timeline?.length);
      const modelCost = Object.values(s.modelBreakdown).reduce((sum, m) => sum + m.totalCostUsd, 0);
      expect(modelCost).toBeCloseTo(s.estimatedCostUsd ?? 0, 2);
      expect(s.subagentCostUsd).toBeLessThanOrEqual(s.estimatedCostUsd ?? 0);
    }
  });

  const THREE_WEEKS = Array.from({ length: 21 }, (_, i) => new Date(2026, 10, 2 + i, 15, 30));

  it('seeds only firing alerts whose value has crossed their threshold, on any date', () => {
    for (const now of THREE_WEEKS) {
      for (const a of buildDemoData(now).alerts.filter((x) => x.state === 'firing')) {
        expect(a.value).toBeGreaterThanOrEqual(a.threshold);
      }
    }
  });

  it('shows the same today on every date, so a rehearsal matches the live demo', () => {
    const todayShape = (now: Date) =>
      buildDemoData(now)
        .sessions.slice(-6)
        .map((s) => [s.sessionName, s.model, s.toolCallCount, s.estimatedCostUsd]);
    for (const now of THREE_WEEKS) expect(todayShape(now)).toEqual(todayShape(NOW));
  });

  it('keeps scores on the 0-1 scale the dashboard renders as percentages', () => {
    for (const s of buildDemoData(NOW).sessions) {
      const scores = [
        s.efficiencyScore,
        s.toolSelectionMetrics?.score,
        ...Object.values(s.efficiencyScoreComponents ?? {}),
      ];
      for (const v of scores) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('uses whole-millisecond timestamps', () => {
    for (const s of buildDemoData(NOW).sessions) {
      expect(Number.isInteger(s.startTime)).toBe(true);
      for (const e of s.timeline ?? []) expect(Number.isInteger(e.timestamp)).toBe(true);
    }
  });

  it('covers every seeded anti-pattern type and some flagged audit records', () => {
    const { sessions, auditEntries } = buildDemoData(NOW);
    const types = new Set(sessions.flatMap((s) => s.antiPatterns.map((p) => p.type)));
    expect([...types].sort()).toEqual(['over_delegation', 're_reading', 'thrashing']);
    expect(auditEntries.some((e) => e.securityAlert !== undefined)).toBe(true);
  });
});

describe('seedDemoDir', () => {
  it('writes sessions SessionStore reads back, plus audit and alert logs', async () => {
    const { sessionCount } = await seedDemoDir(tmpDir, NOW);
    const store = new SessionStore({ storagePath: tmpDir });
    expect(store.loadAllSessions()).toHaveLength(sessionCount);
    expect(readdirSync(resolve(tmpDir, 'audit')).length).toBeGreaterThan(0);
    expect(readdirSync(resolve(tmpDir, 'weekly_summaries')).length).toBeGreaterThanOrEqual(4);
    expect(
      readFileSync(resolve(tmpDir, 'alerts', 'log.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(3);
  });

  it('converges to the same state when re-run', async () => {
    await seedDemoDir(tmpDir, NOW);
    const first = readdirSync(resolve(tmpDir, 'sessions')).sort();
    await seedDemoDir(tmpDir, NOW);
    expect(readdirSync(resolve(tmpDir, 'sessions')).sort()).toEqual(first);
  });

  it('builds a server env that cannot see the real home, session, or credentials', () => {
    const env = demoEnv(tmpDir, 7799, {
      PATH: '/usr/bin',
      HOME: '/Users/real',
      CLAUDE_JOB_DIR: '/Users/real/.claude/jobs/x',
      NEW_RELIC_LICENSE_KEY: 'secret',
      NR_AI_MODE: 'cloud',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: resolve(tmpDir, 'home'),
      DOTENV_CONFIG_PATH: resolve(tmpDir, '.env'),
      NR_AI_MODE: 'local',
      NEW_RELIC_AI_MCP_STORAGE_PATH: resolve(tmpDir),
      USERPROFILE: resolve(tmpDir, 'home'),
      NR_AI_DASHBOARD_PORT: '7799',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    });
  });

  it('refuses the real storage dir', async () => {
    await expect(seedDemoDir(DEFAULT_STORAGE_PATH, NOW)).rejects.toThrow(/real Preflight storage/);
  });

  it('refuses a dir inside the real storage dir', async () => {
    await expect(seedDemoDir(resolve(DEFAULT_STORAGE_PATH, 'demo'), NOW)).rejects.toThrow(
      /real Preflight storage/,
    );
  });

  it('refuses to wipe a directory it did not create', async () => {
    mkdirSync(tmpDir, { recursive: true });
    await expect(seedDemoDir(tmpDir, NOW)).rejects.toThrow(/not created by `preflight demo`/);
  });
});
