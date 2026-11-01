import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { computeHistoricalCosts } from './historical-costs.js';
import { SessionStore } from './session-store.js';
import type { FullSessionSummary } from './session-store.js';

// Local-time constructors keep the fixtures correct in any host timezone,
// because the today/yesterday boundary is the host's local midnight.
const local = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime();
const REF_TS = local(15, 12);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// loadAllSessions() keeps a session when the UTC date in its filename is on or
// after the UTC date seven days before refTs, so the window starts at UTC
// midnight of that date rather than at refTs - 7 days.
const WINDOW_START = Date.parse(new Date(REF_TS - 7 * DAY).toISOString().slice(0, 10));

let tmpDir: string;
let store: SessionStore;
let stderrSpy: ReturnType<typeof jest.spyOn>;

function save(sessionId: string, startTime: number, endTime: number, costUsd: number | null): void {
  store.saveSession({
    sessionId,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    estimatedCostUsd: costUsd,
    toolCallCount: 1,
  } as unknown as FullSessionSummary);
}

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(
    tmpdir(),
    `nr-historical-costs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(resolve(tmpDir, 'sessions'), { recursive: true });
  store = new SessionStore({ storagePath: tmpDir });
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeHistoricalCosts', () => {
  it('counts a session from yesterday toward the week only', () => {
    save('yesterday', local(14, 10), local(14, 11), 1);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 1,
    });
  });

  it('counts a session from earlier today toward the day and the week', () => {
    save('today', local(15, 8), local(15, 9), 2);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 2,
    });
  });

  it('pro-rates a session that spans midnight into the day, and counts all of it for the week', () => {
    save('overnight', local(14, 23), local(15, 1), 4);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 4,
    });
  });

  it('counts a session from the first day of the window toward the week', () => {
    save('first-day', WINDOW_START, WINDOW_START + HOUR, 3);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 3,
    });
  });

  it('ignores a session from the day before the window', () => {
    save('day-before', WINDOW_START - HOUR, WINDOW_START, 8);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
    });
  });

  it('excludes the current session so the caller does not double-count it', () => {
    save('current', local(15, 8), local(15, 9), 16);
    save('today', local(15, 10), local(15, 11), 2);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 2,
      priorWeeklyCostUsd: 2,
    });
  });

  it('skips sessions with no cost estimate', () => {
    save('unpriced', local(15, 8), local(15, 9), null);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
    });
  });

  it('sums every kind of session together', () => {
    save('yesterday', local(14, 10), local(14, 11), 1);
    save('today', local(15, 8), local(15, 9), 2);
    save('overnight', local(14, 23), local(15, 1), 4);
    save('old', WINDOW_START - HOUR, WINDOW_START, 8);
    save('current', local(15, 10), local(15, 11), 16);

    expect(computeHistoricalCosts(store, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 4,
      priorWeeklyCostUsd: 7,
    });
  });

  it('falls back to zero when the session store cannot be read', () => {
    const broken = {
      loadAllSessions: () => {
        throw new Error('unreadable');
      },
    };

    expect(computeHistoricalCosts(broken, 'current', REF_TS)).toEqual({
      priorDailyCostUsd: 0,
      priorWeeklyCostUsd: 0,
    });
  });
});
