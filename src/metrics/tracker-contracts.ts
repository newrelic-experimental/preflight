/**
 * Implemented by session-scoped trackers that must clear their state when a
 * session boundary is crossed. Not currently invoked by any production
 * dispatch loop (`reset()` has no production call sites as of 2026-07) —
 * this exists so a future session-boundary dispatcher can type-check across
 * trackers without special-casing each one. See CLAUDE.md's "Metric Tracker
 * Pattern" section for the families of tracker shapes this does and doesn't
 * cover.
 */
export interface Resettable {
  reset(sessionId: string): void;
}

/**
 * Where a seed's totals come from. `alreadySaved` totals are in a session file
 * another writer saved (a previous process, another live one, or this
 * process's rollup save), so they stay out of `getOwnMetrics()`. `drainedHere`
 * totals are work this process drained that no file holds yet, so they count
 * as its own.
 */
export type SeedOrigin = 'alreadySaved' | 'drainedHere';
