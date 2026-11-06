import type { Logger } from '../shared/index.js';

const WARN_INTERVAL_MS = 60_000;

interface KeyState {
  lastLoggedMs: number;
  suppressed: number;
}

/**
 * A warning for a failure the caller retries every poll: logged on the first
 * failure, then at most once a minute with the number suppressed since. A
 * success resets it, so the next failure is logged at once. Pass a key, such
 * as a file path, so one healthy source cannot reset another's throttle.
 */
export class ThrottledWarning {
  private readonly states = new Map<string, KeyState>();

  constructor(
    private readonly logger: Logger,
    private readonly message: string,
  ) {}

  warn(err: unknown, key = ''): void {
    const nowMs = Date.now();
    const state = this.states.get(key);
    if (state !== undefined && nowMs - state.lastLoggedMs < WARN_INTERVAL_MS) {
      state.suppressed += 1;
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    this.logger.warn(this.message, {
      error: error.slice(0, 200),
      suppressed: state?.suppressed ?? 0,
    });
    this.states.set(key, { lastLoggedMs: nowMs, suppressed: 0 });
  }

  succeeded(key = ''): void {
    this.states.delete(key);
  }
}
