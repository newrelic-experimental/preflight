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
