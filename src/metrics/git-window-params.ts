import { localStartOfDay } from '../lib/date.js';
import type { ScopeRef } from './git-workspace-report.js';

const MS_PER_DAY = 86_400_000;
const MAX_DAYS = 365;

export interface ResolvedWindow {
  readonly since: number;
  readonly until: number;
}

/**
 * `today` (default), `yesterday`, `week` (rolling last 7 days, ending now),
 * `previous_week` (the 7-day period immediately before `week` — a fixed,
 * fully-past window, used as `week`'s week-over-week comparison baseline),
 * or a bare positive integer string meaning "N days back" — same vocabulary
 * and math as `GET /api/cost-per-outcome`'s `?days=` parsing (see that route
 * in api-handler.ts for the exact `localStartOfDay()`-anchored windowing this
 * mirrors), so this tab's "last N days" lines up with the rest of the
 * dashboard. Anything unparseable degrades to `today` rather than erroring.
 */
export function resolveWindowParam(
  raw: string | null | undefined,
  now: number = Date.now(),
): ResolvedWindow {
  const todayStart = localStartOfDay(now);

  if (raw === 'yesterday') {
    return { since: todayStart - MS_PER_DAY, until: todayStart };
  }

  if (raw === 'week') {
    return { since: todayStart - 6 * MS_PER_DAY, until: now };
  }

  if (raw === 'previous_week') {
    return { since: todayStart - 13 * MS_PER_DAY, until: todayStart - 6 * MS_PER_DAY };
  }

  if (raw != null && raw !== 'today') {
    const parsed = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      const days = Math.min(Math.max(parsed, 1), MAX_DAYS);
      return { since: todayStart - (days - 1) * MS_PER_DAY, until: now };
    }
  }

  return { since: todayStart, until: now };
}

/**
 * `all` (default), `repo:<id>`, or `worktree:<id>` — the id portion is
 * URL-decoded. Anything malformed or unrecognized degrades to `{ kind: 'all' }`.
 */
export function resolveScopeParam(raw: string | null | undefined): ScopeRef {
  if (raw == null || raw === 'all') return { kind: 'all' };

  const repoPrefix = 'repo:';
  const worktreePrefix = 'worktree:';

  if (raw.startsWith(repoPrefix)) {
    const id = raw.slice(repoPrefix.length);
    if (id.length === 0) return { kind: 'all' };
    return { kind: 'repo', id: decodeSafely(id) };
  }

  if (raw.startsWith(worktreePrefix)) {
    const id = raw.slice(worktreePrefix.length);
    if (id.length === 0) return { kind: 'all' };
    return { kind: 'worktree', id: decodeSafely(id) };
  }

  return { kind: 'all' };
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
