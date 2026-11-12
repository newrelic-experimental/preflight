import type { AntiPattern } from './anti-patterns.js';
import type { AiCodingTask } from './task-detector.js';

export interface HeldTaskSend {
  readonly task: AiCodingTask;
  readonly patterns: readonly AntiPattern[];
}

// Matches TaskDetector's retained completed tasks, so holding adds references, not task memory.
const MAX_HELD_TASK_SENDS = 100;

/**
 * Tasks scored before an ingest exists. A provisional engine drains every
 * session's buffer, so a held task may hold other sessions' calls. Ingest
 * stamps events with the adopted id, so sending those would misattribute them.
 * A task with no calls or a null session id proves no ownership and is not sent.
 */
export class HeldTaskSends {
  private held: HeldTaskSend[] = [];

  hold(entry: HeldTaskSend): void {
    this.held = [...this.held, entry].slice(-MAX_HELD_TASK_SENDS);
  }

  /** Empties the list, so each held task is sent at most once. */
  takeOwnedBy(sessionId: string): { owned: HeldTaskSend[]; dropped: number } {
    const owned = this.held.filter(
      ({ task }) =>
        task.toolCalls.length > 0 && task.toolCalls.every((call) => call.sessionId === sessionId),
    );
    const dropped = this.held.length - owned.length;
    this.held = [];
    return { owned, dropped };
  }
}
