// The one persisted session the seeded e2e server starts with. Specs assert against these
// values, so they are exported rather than repeated.

export const FIXTURE_SESSION_ID = 'e2e-fixture-session-0001';
export const FIXTURE_SESSION_NAME = 'e2e fixture session';
export const FIXTURE_MODEL = 'claude-sonnet-4-5';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A session summary in the on-disk shape `SessionStore` reads. Started two days ago, so it
 * falls inside History's default 7-day window without ever counting as today — the Today
 * view's empty-state gate reads today's totals, and a run just after midnight would
 * otherwise flip between the two.
 */
export function buildFixtureSession(now: number): Record<string, unknown> {
  const startTime = now - 2 * DAY_MS;
  const durationMs = 20 * 60 * 1000;
  return {
    sessionId: FIXTURE_SESSION_ID,
    sessionName: FIXTURE_SESSION_NAME,
    startTime,
    endTime: startTime + durationMs,
    durationMs,
    model: FIXTURE_MODEL,
    // /api/sessions drops sessions with no tool calls, so this has to be non-zero.
    toolCallCount: 12,
    toolBreakdown: { Read: 6, Edit: 4, Bash: 2 },
    estimatedCostUsd: 0.42,
    tokensInput: 12_000,
    tokensOutput: 3_000,
  };
}
