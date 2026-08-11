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
 * These helpers operate in the host process's own local timezone by default —
 * same as the previous inline implementations. Each also accepts an optional
 * trailing IANA `tz` (e.g. `"America/New_York"`); when given, Y/M/D is
 * computed in that zone instead of the host's. Callers that need "today" to
 * mean the *browser's* today (rather than the server process's) thread the
 * browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` through to
 * these functions.
 */

// Intl.DateTimeFormat construction is measurably more expensive than
// formatToParts() itself, and the `history` branch of the activity-heatmap
// route calls into these helpers a few times per day boundary across up to
// 52 weeks in a single request on a single-threaded server. Today, the only
// caller that ever passes a `tz` (the activity-heatmap route) validates it
// against Intl.DateTimeFormat first — but these helpers themselves don't
// enforce that, so the cache key can't just be the raw `tz` string: distinct
// spellings of the same zone ('Asia/Kolkata', 'asia/kolkata', '+0530', ...)
// all construct successfully and would otherwise become distinct,
// never-evicted Map entries. Resolving each input to Intl's canonical zone
// name before touching the cache collapses those spelling variants onto one
// key, so the cache only grows with the number of *distinct* zones/offsets
// actually seen — not with every raw string a caller happens to send.
function canonicalTz(tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
}

const ymdFormatterCache = new Map<string, Intl.DateTimeFormat>();
function ymdFormatterFor(tz: string): Intl.DateTimeFormat {
  const canonical = canonicalTz(tz);
  let formatter = ymdFormatterCache.get(canonical);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: canonical,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    ymdFormatterCache.set(canonical, formatter);
  }
  return formatter;
}

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();
function offsetFormatterFor(tz: string): Intl.DateTimeFormat {
  const canonical = canonicalTz(tz);
  let formatter = offsetFormatterCache.get(canonical);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: canonical,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    offsetFormatterCache.set(canonical, formatter);
  }
  return formatter;
}

/**
 * Y/M/D as observed in `tz` for the instant `ts`.
 */
function zonedYMD(ts: number, tz: string): { year: number; month: number; day: number } {
  const parts = ymdFormatterFor(tz).formatToParts(ts);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return { year, month, day };
}

/**
 * `tz`'s UTC offset in ms (positive east of UTC) at the instant `ts`. Derived
 * by reading `tz`'s wall-clock Y/M/D/H/M/S at `ts` and re-interpreting those
 * same numbers as UTC — the gap between the two is the offset. This varies by
 * date for zones that observe DST, so it must be read near the instant in
 * question rather than assumed fixed.
 */
function zonedOffsetMs(ts: number, tz: string): number {
  const parts = offsetFormatterFor(tz).formatToParts(ts);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  // Some ICU configurations render midnight as hour "24" under hour12: false.
  const hour = values.hour === 24 ? 0 : values.hour;
  const wallClockAsUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    hour,
    values.minute,
    values.second,
  );
  return wallClockAsUtc - ts;
}

/**
 * Epoch ms of local midnight for Y/M/D in `tz`. A first guess treats Y/M/D as
 * if they were UTC, then that guess is corrected by `tz`'s actual offset at
 * (approximately) that instant. Because the correction itself can move the
 * candidate instant across a DST transition — landing on a moment where the
 * offset is different from the one used to compute it — the offset is read
 * again at the corrected instant and, if it changed, a second correction is
 * computed using that re-read offset.
 *
 * The second correction is only trustworthy if it actually lands back on the
 * target Y/M/D — re-reading the offset can itself land on the far side of
 * *another* transition (this happens for zones that spring forward at or
 * near midnight, e.g. America/Havana, America/Santiago, Atlantic/Azores: the
 * re-read offset belongs to the transition that skipped local midnight
 * entirely, and blindly applying it walks the candidate back onto the
 * *previous* day instead of forward onto the first real instant of the
 * target day). So the second correction is validated against the target
 * Y/M/D before being trusted, falling back to the first correction — the
 * earliest instant whose wall-clock date is on or after the target — when it
 * isn't.
 */
function zonedStartOfDayMs(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const offset = zonedOffsetMs(guess, tz);
  const firstCorrection = guess - offset;
  const offsetAtFirstCorrection = zonedOffsetMs(firstCorrection, tz);
  if (offsetAtFirstCorrection === offset) return firstCorrection;
  const secondCorrection = guess - offsetAtFirstCorrection;
  const secondCorrectionYmd = zonedYMD(secondCorrection, tz);
  const secondCorrectionMatchesTarget =
    secondCorrectionYmd.year === year &&
    secondCorrectionYmd.month === month &&
    secondCorrectionYmd.day === day;
  return secondCorrectionMatchesTarget ? secondCorrection : firstCorrection;
}

/**
 * Epoch ms at local midnight of the day containing `refTs`.
 * Defaults to `Date.now()` when `refTs` is omitted.
 * Computed in the host's own local timezone unless `tz` (an IANA timezone
 * name) is given, in which case midnight is computed in that zone instead.
 */
export function localStartOfDay(refTs?: number, tz?: string): number {
  if (tz) {
    const ts = refTs == null ? Date.now() : refTs;
    const { year, month, day } = zonedYMD(ts, tz);
    return zonedStartOfDayMs(year, month, day, tz);
  }
  const d = refTs == null ? new Date() : new Date(refTs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * True iff `ts` and `refTs` (or now) fall on the same calendar day.
 * Uses Y/M/D comparison so DST transitions don't introduce off-by-one bugs
 * (a "day" can be 23 h or 25 h on DST boundaries; raw ts-range arithmetic
 * gets that wrong, Y/M/D comparison doesn't).
 * Compares Y/M/D in the host's own local timezone unless `tz` (an IANA
 * timezone name) is given, in which case both `ts` and `refTs` are compared
 * as observed in that same zone.
 */
export function isSameLocalDay(ts: number, refTs?: number, tz?: string): boolean {
  if (tz) {
    const a = zonedYMD(ts, tz);
    const b = zonedYMD(refTs == null ? Date.now() : refTs, tz);
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }
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
 * Computed in the host's own local timezone unless `tz` (an IANA timezone
 * name) is given, in which case the key reflects Y/M/D in that zone instead.
 */
export function localDateKey(ts?: number, tz?: string): string {
  if (tz) {
    const { year, month, day } = zonedYMD(ts == null ? Date.now() : ts, tz);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = ts == null ? new Date() : new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * What fraction of a session's activity fell within today's local day, given
 * its start, end, and timeline. Shared by every "how much of this session's
 * X counts toward today" calculation (currently cost, via
 * `todayPortionOfSessionCost`) so each new per-session metric that needs the
 * same cross-midnight pro-rating doesn't reimplement it.
 *
 * Strategy:
 *  - Session entirely before today's local day: return 0.
 *  - Session entirely after today's local day: return 0.
 *  - Session entirely within today: return 1.
 *  - Session straddling midnight: pro-rate by tool-call count when a timeline
 *    is available (better correlated with per-event metrics than wall time,
 *    which can include long idle stretches), else by elapsed-time overlap.
 */
export function todayPortionRatio(
  session: {
    startTime: number;
    endTime: number;
    timeline?: ReadonlyArray<{ timestamp: number }>;
  },
  refTs?: number,
): number {
  const dayStart = localStartOfDay(refTs);
  const dayEnd = dayStart + 86_400_000;

  if (session.endTime < dayStart) return 0;
  if (session.startTime >= dayEnd) return 0;

  const entirelyToday = session.startTime >= dayStart && session.endTime < dayEnd;
  if (entirelyToday) return 1;

  if (session.timeline && session.timeline.length > 0) {
    const total = session.timeline.length;
    const todayCount = session.timeline.filter(
      (t) => t.timestamp >= dayStart && t.timestamp < dayEnd,
    ).length;
    if (total > 0) return todayCount / total;
  }

  const overlapMs = Math.min(session.endTime, dayEnd) - Math.max(session.startTime, dayStart);
  const totalMs = Math.max(1, session.endTime - session.startTime);
  return overlapMs / totalMs;
}

/**
 * How much of `session.estimatedCostUsd` was spent during today's local day.
 * Fixes the cross-midnight bug where whole-session cost was attributed to the
 * day a session started. See `todayPortionRatio` for the pro-rating strategy.
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
  return cost * todayPortionRatio(session, refTs);
}
