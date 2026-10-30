import type { Logger } from '../shared/index.js';

const WARN_INTERVAL_MS = 60_000;

/**
 * A warning for a failure the caller retries every poll: logged on the first
 * failure, then at most once a minute with the number suppressed since. A
 * success resets it, so the next failure is logged at once.
 */
export class ThrottledWarning {
  private lastLoggedMs: number | null = null;
  private suppressed = 0;

  constructor(
    private readonly logger: Logger,
    private readonly message: string,
  ) {}

  warn(err: unknown): void {
    const nowMs = Date.now();
    if (this.lastLoggedMs !== null && nowMs - this.lastLoggedMs < WARN_INTERVAL_MS) {
      this.suppressed += 1;
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    this.logger.warn(this.message, { error: error.slice(0, 200), suppressed: this.suppressed });
    this.lastLoggedMs = nowMs;
    this.suppressed = 0;
  }

  succeeded(): void {
    this.lastLoggedMs = null;
    this.suppressed = 0;
  }
}
