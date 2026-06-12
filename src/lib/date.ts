/**
 * Shared local-day helpers used by both the dashboard server and the React UI.
 *
 * Both surfaces previously implemented their own "is today" / "start of today"
 * logic — the server via `new Date(); setHours(0,0,0,0)` and the client via a
 * private `isToday(ts)` helper in Today.tsx. When server and client clocks
 * diverged (containerized server in UTC, browser in user-local), the two
 * sides drew the day boundary at different moments and visible inconsistencies
 * appeared (chart shows session active, sidebar filter drops it, etc.).
 *
 * These helpers operate in the host process's local timezone — same as the
 * previous inline implementations. Both sides should call them so any future
 * tz/DST handling change lands in one place.
 */

/**
 * Epoch ms at local midnight of the day containing `refTs`.
 * Defaults to `Date.now()` when `refTs` is omitted.
 */
export function localStartOfDay(refTs?: number): number {
  const d = refTs == null ? new Date() : new Date(refTs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * True iff `ts` and `refTs` (or now) fall on the same local-time calendar day.
 * Uses Y/M/D comparison so DST transitions don't introduce off-by-one bugs
 * (a "day" can be 23 h or 25 h on DST boundaries; raw ts-range arithmetic
 * gets that wrong, Y/M/D comparison doesn't).
 */
export function isSameLocalDay(ts: number, refTs?: number): boolean {
  const a = new Date(ts);
  const b = refTs == null ? new Date() : new Date(refTs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Local-time YYYY-MM-DD key for `ts` (or now). Used as a Map key for per-day
 * cost buckets. Must agree with localStartOfDay/isSameLocalDay so server-side
 * bucketing and client-side filters draw the day boundary at the same instant.
 */
export function localDateKey(ts?: number): string {
  const d = ts == null ? new Date() : new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * How much of `session.estimatedCostUsd` was spent during today's local day,
 * given the session's start, end, and timeline. Fixes the cross-midnight bug
 * where whole-session cost was attributed to the day a session started.
 *
 * Strategy:
 *  - Session entirely before today's local day: return 0.
 *  - Session entirely after today's local day: return 0.
 *  - Session entirely within today: return total cost.
 *  - Session straddling midnight: pro-rate by tool-call count when a timeline
 *    is available (better correlated with cost than wall time, which can
 *    include long idle stretches), else by elapsed-time overlap.
 */
export function todayPortionOfSessionCost(
  session: {
    startTime: number;
    endTime: number;
    estimatedCostUsd: number | null;
    timeline?: ReadonlyArray<{ timestamp: number }>;
  },
  refTs?: number,
): number {
  const cost = session.estimatedCostUsd;
  if (cost == null || cost <= 0) return 0;

  const dayStart = localStartOfDay(refTs);
  const dayEnd = dayStart + 86_400_000;

  if (session.endTime < dayStart) return 0;
  if (session.startTime >= dayEnd) return 0;

  const entirelyToday = session.startTime >= dayStart && session.endTime < dayEnd;
  if (entirelyToday) return cost;

  if (session.timeline && session.timeline.length > 0) {
    const total = session.timeline.length;
    const todayCount = session.timeline.filter(
      (t) => t.timestamp >= dayStart && t.timestamp < dayEnd,
    ).length;
    if (total > 0) return cost * (todayCount / total);
  }

  const overlapMs = Math.min(session.endTime, dayEnd) - Math.max(session.startTime, dayStart);
  const totalMs = Math.max(1, session.endTime - session.startTime);
  return cost * (overlapMs / totalMs);
}
