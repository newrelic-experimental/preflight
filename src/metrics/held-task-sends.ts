import type { AntiPattern } from './anti-patterns.js';
import type { AiCodingTask } from './task-detector.js';

export interface HeldTaskSend {
  readonly task: AiCodingTask;
  readonly patterns: readonly AntiPattern[];
}

// Matches TaskDetector's retained completed tasks, so holding adds references, not task memory.
const MAX_HELD_TASK_SENDS = 100;

export function holdTaskSend(held: readonly HeldTaskSend[], entry: HeldTaskSend): HeldTaskSend[] {
  return [...held, entry].slice(-MAX_HELD_TASK_SENDS);
}

/**
 * A provisional engine drains every session's buffer, so a held task may hold
 * other sessions' calls. Ingest stamps events with the adopted id, so sending
 * those would misattribute them. A task with no calls or a null session id
 * proves no ownership and is not sent.
 */
export function heldTaskSendsOwnedBy(
  held: readonly HeldTaskSend[],
  sessionId: string,
): HeldTaskSend[] {
  return held.filter(
    ({ task }) =>
      task.toolCalls.length > 0 && task.toolCalls.every((call) => call.sessionId === sessionId),
  );
}
