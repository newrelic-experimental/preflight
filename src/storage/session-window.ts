import { localEndOfDay } from '../lib/date.js';
import type { FullSessionSummary, LoadSessionsOptions } from './session-store.js';

const DAY_MS = 86_400_000;

/** A half-open span of wall-clock time, `[startMs, endMs)`. */
export interface ActivityWindow {
  readonly startMs: number;
  readonly endMs: number;
}

type WindowSource = Pick<
  FullSessionSummary,
  | 'startTime'
  | 'endTime'
  | 'durationMs'
  | 'toolCallCount'
  | 'estimatedCostUsd'
  | 'costByDayUsd'
  | 'timeline'
>;

/** The part of one session's activity that falls inside a window. */
export interface WindowShare {
  /** Share of the session's cost in the window, in [0, 1]. Scales any total kept without a day split. */
  readonly weight: number;
  readonly costUsd: number;
  readonly toolCalls: number;
}

export interface WindowedSession {
  readonly session: FullSessionSummary;
  readonly share: WindowShare;
}

// The deserializer maps a missing endTime to 0. Treat that, or an end before
// the start, as unknown rather than as an end before the window.
export function lastActivityMs(s: WindowSource): number {
  return s.endTime >= s.startTime ? s.endTime : s.startTime + (s.durationMs ?? 0);
}

function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function dayStartOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Splits a session's cost and tool calls at the window's edges. Cost comes
 * from the per-day map, and a day the window cuts is split by its tool calls,
 * or by elapsed time when it has none. A session without the map splits its
 * whole cost the same way.
 */
export function windowShare(s: WindowSource, w: ActivityWindow): WindowShare {
  const start = s.startTime;
  const last = lastActivityMs(s);
  const lifetimeUsd = Math.max(0, s.estimatedCostUsd ?? 0);
  if (start >= w.startMs && last < w.endMs) {
    return { weight: 1, costUsd: lifetimeUsd, toolCalls: s.toolCallCount };
  }

  const timeline = s.timeline ?? [];
  const inWindow = (ts: number): boolean => ts >= w.startMs && ts < w.endMs;
  const shareIn = (from: number, to: number): number => {
    let calls = 0;
    let callsIn = 0;
    for (const t of timeline) {
      if (t.timestamp < from || t.timestamp >= to) continue;
      calls++;
      if (inWindow(t.timestamp)) callsIn++;
    }
    if (calls > 0) return callsIn / calls;
    const active = overlapMs(start, last, from, to);
    return active > 0
      ? overlapMs(start, last, Math.max(from, w.startMs), Math.min(to, w.endMs)) / active
      : 0;
  };

  const costUsd =
    s.costByDayUsd === undefined
      ? lifetimeUsd * shareIn(-Infinity, Infinity)
      : Object.entries(s.costByDayUsd).reduce((sum, [day, usd]) => {
          const dayStart = dayStartOfKey(day);
          return sum + usd * shareIn(dayStart, localEndOfDay(dayStart));
        }, 0);
  const weight =
    lifetimeUsd > 0 ? Math.min(1, costUsd / lifetimeUsd) : shareIn(-Infinity, Infinity);
  const toolCalls =
    timeline.length > 0
      ? timeline.filter((t) => inWindow(t.timestamp)).length
      : s.toolCallCount * weight;
  return { weight, costUsd, toolCalls };
}

/**
 * The sessions with activity in the window, each with its in-window share. A
 * session counts when it started in the window or has cost or calls inside it.
 */
export function windowedSessions(
  sessions: readonly FullSessionSummary[],
  w: ActivityWindow,
): WindowedSession[] {
  return sessions.flatMap((session) => {
    const share = windowShare(session, w);
    const startedIn = session.startTime >= w.startMs && session.startTime < w.endMs;
    return startedIn || share.costUsd > 0 || share.toolCalls > 0 ? [{ session, share }] : [];
  });
}

/**
 * Loads the sessions with activity in the window. A resumed session keeps its
 * start-date filename, so a file is read when that date is in the window or
 * when it was written after the window opened.
 */
export function loadSessionsActiveIn(
  loadAllSessions: (options: LoadSessionsOptions) => readonly FullSessionSummary[],
  w: ActivityWindow,
): WindowedSession[] {
  // Filename dates are UTC, so reach back a day to cover any local offset.
  const sessions = loadAllSessions({
    since: new Date(w.startMs - DAY_MS),
    includeModifiedSince: new Date(w.startMs),
  });
  return windowedSessions(sessions, w);
}
