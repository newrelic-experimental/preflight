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
