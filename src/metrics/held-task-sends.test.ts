import { describe, expect, it } from '@jest/globals';

import type { ToolCallRecord } from '../storage/types.js';
import { HeldTaskSends, type HeldTaskSend } from './held-task-sends.js';
import type { AiCodingTask } from './task-detector.js';

const ADOPTED = 'adopted-session';

function makeHeld(taskId: string, sessionIds: ReadonlyArray<string | null>): HeldTaskSend {
  const toolCalls = sessionIds.map((sessionId) => ({ sessionId }) as ToolCallRecord);
  return { task: { taskId, toolCalls } as AiCodingTask, patterns: [] };
}

describe('HeldTaskSends.takeOwnedBy', () => {
  const owned = (...held: HeldTaskSend[]) => {
    const list = new HeldTaskSends();
    for (const entry of held) list.hold(entry);
    return list.takeOwnedBy(ADOPTED).owned.map(({ task }) => task.taskId);
  };

  it('keeps a task whose every tool call is from the adopted session', () => {
    expect(owned(makeHeld('own', [ADOPTED, ADOPTED]))).toEqual(['own']);
  });

  it("drops a task built from another session's records", () => {
    expect(owned(makeHeld('other', ['other-session']))).toEqual([]);
  });

  it('drops a task that mixes sessions', () => {
    expect(owned(makeHeld('mixed', [ADOPTED, 'other-session']))).toEqual([]);
  });

  it('drops a task with a null session id on any call', () => {
    expect(owned(makeHeld('unknown', [ADOPTED, null]))).toEqual([]);
  });

  it('drops a task with no tool calls', () => {
    expect(owned(makeHeld('empty', []))).toEqual([]);
  });

  it('counts the dropped tasks', () => {
    const list = new HeldTaskSends();
    list.hold(makeHeld('own', [ADOPTED]));
    list.hold(makeHeld('other', ['other-session']));

    expect(list.takeOwnedBy(ADOPTED).dropped).toBe(1);
  });

  it('empties the list, so a second adoption sends nothing', () => {
    const list = new HeldTaskSends();
    list.hold(makeHeld('own', [ADOPTED]));

    expect(list.takeOwnedBy(ADOPTED).owned).toHaveLength(1);
    expect(list.takeOwnedBy(ADOPTED)).toEqual({ owned: [], dropped: 0 });
  });
});

describe('HeldTaskSends.hold', () => {
  it('evicts the oldest entries past the bound', () => {
    const list = new HeldTaskSends();
    for (let i = 0; i < 150; i++) list.hold(makeHeld(`t${i}`, [ADOPTED]));

    const { owned } = list.takeOwnedBy(ADOPTED);
    expect(owned).toHaveLength(100);
    expect(owned[0]?.task.taskId).toBe('t50');
    expect(owned[99]?.task.taskId).toBe('t149');
  });
});
