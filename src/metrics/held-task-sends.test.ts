import { describe, expect, it } from '@jest/globals';

import type { ToolCallRecord } from '../storage/types.js';
import { heldTaskSendsOwnedBy, holdTaskSend, type HeldTaskSend } from './held-task-sends.js';
import type { AiCodingTask } from './task-detector.js';

const ADOPTED = 'adopted-session';

function makeHeld(taskId: string, sessionIds: ReadonlyArray<string | null>): HeldTaskSend {
  const toolCalls = sessionIds.map((sessionId) => ({ sessionId }) as ToolCallRecord);
  return { task: { taskId, toolCalls } as AiCodingTask, patterns: [] };
}

describe('heldTaskSendsOwnedBy', () => {
  const owned = (held: HeldTaskSend[]) =>
    heldTaskSendsOwnedBy(held, ADOPTED).map(({ task }) => task.taskId);

  it('keeps a task whose every tool call is from the adopted session', () => {
    expect(owned([makeHeld('own', [ADOPTED, ADOPTED])])).toEqual(['own']);
  });

  it("drops a task built from another session's records", () => {
    expect(owned([makeHeld('other', ['other-session'])])).toEqual([]);
  });

  it('drops a task that mixes sessions', () => {
    expect(owned([makeHeld('mixed', [ADOPTED, 'other-session'])])).toEqual([]);
  });

  it('drops a task with a null session id on any call', () => {
    expect(owned([makeHeld('unknown', [ADOPTED, null])])).toEqual([]);
  });

  it('drops a task with no tool calls', () => {
    expect(owned([makeHeld('empty', [])])).toEqual([]);
  });
});

describe('holdTaskSend', () => {
  it('evicts the oldest entries past the bound', () => {
    let held: HeldTaskSend[] = [];
    for (let i = 0; i < 150; i++) held = holdTaskSend(held, makeHeld(`t${i}`, [ADOPTED]));

    expect(held).toHaveLength(100);
    expect(held[0]?.task.taskId).toBe('t50');
    expect(held[99]?.task.taskId).toBe('t149');
  });
});
