import { describe, it, expect } from '@jest/globals';

import type { ToolCallRecord } from '../storage/types.js';
import { SkillActivationTracker } from './skill-activation-tracker.js';

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'r1',
    sessionId: 's1',
    toolName: 'Read',
    toolUseId: 'u1',
    timestamp: 1000,
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

describe('SkillActivationTracker', () => {
  it('skill call opens and stamps itself', () => {
    const t = new SkillActivationTracker();
    const stamp = t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'eslint',
        toolUseId: 'u1',
      }),
    );

    expect(stamp).not.toBeNull();
    expect(stamp!.name).toBe('eslint');
    expect(stamp!.source).toBe('tool');
    expect(stamp!.runId).toBeDefined();
  });

  it('following read inherits same runId', () => {
    const t = new SkillActivationTracker();
    const skillStamp = t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'eslint',
        toolUseId: 'u1',
      }),
    );

    const readStamp = t.recordToolCall(
      makeRecord({
        toolName: 'Read',
        toolUseId: 'u2',
      }),
    );

    expect(readStamp).not.toBeNull();
    expect(readStamp!.runId).toBe(skillStamp!.runId);
    expect(readStamp!.name).toBe('eslint');
  });

  it('second skill call replaces with new runId', () => {
    const t = new SkillActivationTracker();
    const stamp1 = t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'eslint',
        toolUseId: 'u1',
      }),
    );

    const stamp2 = t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'prettier',
        toolUseId: 'u2',
      }),
    );

    expect(stamp2!.name).toBe('prettier');
    expect(stamp2!.runId).not.toBe(stamp1!.runId);
  });

  it('prompt without slash clears all runs', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'eslint',
        toolUseId: 'u1',
      }),
    );

    t.recordPrompt('s1', null);

    const stamp = t.recordToolCall(
      makeRecord({
        toolName: 'Read',
        toolUseId: 'u2',
      }),
    );

    expect(stamp).toBeNull();
  });

  it('slash prompt opens source slash', () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', 'lint');

    const stamp = t.recordToolCall(
      makeRecord({
        toolName: 'Read',
        toolUseId: 'u1',
      }),
    );

    expect(stamp).not.toBeNull();
    expect(stamp!.name).toBe('lint');
    expect(stamp!.source).toBe('slash');
  });

  it('subagent skill call is scoped to that agentId', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'main-skill',
        agentId: undefined,
        toolUseId: 'u1',
      }),
    );

    t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'subagent-skill',
        agentId: 'agent-1',
        toolUseId: 'u2',
      }),
    );

    const readInMain = t.recordToolCall(
      makeRecord({
        toolName: 'Read',
        agentId: undefined,
        toolUseId: 'u3',
      }),
    );

    const readInSubagent = t.recordToolCall(
      makeRecord({
        toolName: 'Read',
        agentId: 'agent-1',
        toolUseId: 'u4',
      }),
    );

    expect(readInMain!.name).toBe('main-skill');
    expect(readInSubagent!.name).toBe('subagent-skill');
  });

  it('subagent with no own run inherits main run', () => {
    const t = new SkillActivationTracker();
    const mainStamp = t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'main-skill',
        agentId: undefined,
        toolUseId: 'u1',
      }),
    );

    const readInSubagent = t.recordToolCall(
      makeRecord({
        toolName: 'Read',
        agentId: 'agent-1',
        toolUseId: 'u2',
      }),
    );

    expect(readInSubagent!.name).toBe('main-skill');
    expect(readInSubagent!.runId).toBe(mainStamp!.runId);
  });

  it('sessions are isolated', () => {
    const t = new SkillActivationTracker();
    const stamp1 = t.recordToolCall(
      makeRecord({
        sessionId: 's1',
        toolName: 'Skill',
        skillName: 'skill1',
        toolUseId: 'u1',
      }),
    );

    const stamp2 = t.recordToolCall(
      makeRecord({
        sessionId: 's2',
        toolName: 'Skill',
        skillName: 'skill2',
        toolUseId: 'u2',
      }),
    );

    const readInS1 = t.recordToolCall(
      makeRecord({
        sessionId: 's1',
        toolName: 'Read',
        toolUseId: 'u3',
      }),
    );

    const readInS2 = t.recordToolCall(
      makeRecord({
        sessionId: 's2',
        toolName: 'Read',
        toolUseId: 'u4',
      }),
    );

    expect(readInS1!.runId).toBe(stamp1!.runId);
    expect(readInS2!.runId).toBe(stamp2!.runId);
  });

  it('skill call with no/empty skillName opens nothing', () => {
    const t = new SkillActivationTracker();
    const stamp = t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: '',
        toolUseId: 'u1',
      }),
    );

    expect(stamp).toBeNull();

    const stamp2 = t.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: undefined,
        toolUseId: 'u2',
      }),
    );

    expect(stamp2).toBeNull();
  });

  it('a skill opened inside another run records that run as its parent', () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', 'poteto-mode');
    const outer = t.recordToolCall(makeRecord({ toolName: 'Read', toolUseId: 'u1' }));
    const inner = t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'unslop', toolUseId: 'u2' }),
    );
    const after = t.recordToolCall(makeRecord({ toolName: 'Edit', toolUseId: 'u3' }));

    expect(inner!.parentRunId).toBe(outer!.runId);
    expect(after).toEqual(inner);
  });

  it('a subagent skill records the inherited main run as its parent', () => {
    const t = new SkillActivationTracker();
    const main = t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'main-skill' }));
    const sub = t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'sub-skill', agentId: 'agent-1' }),
    );

    expect(sub!.parentRunId).toBe(main!.runId);
  });

  it('runs opened with nothing open have no parent', () => {
    const t = new SkillActivationTracker();
    const toolRun = t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'a' }));
    t.recordPrompt('s1', 'b');
    const slashRun = t.recordToolCall(makeRecord({ toolName: 'Read' }));

    expect(toolRun!.parentRunId).toBeUndefined();
    expect(slashRun!.parentRunId).toBeUndefined();
  });

  it('reset clears everything', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(
      makeRecord({
        sessionId: 's1',
        toolName: 'Skill',
        skillName: 'skill1',
        toolUseId: 'u1',
      }),
    );

    t.reset();

    const stamp = t.recordToolCall(
      makeRecord({
        sessionId: 's1',
        toolName: 'Read',
        toolUseId: 'u2',
      }),
    );

    expect(stamp).toBeNull();
  });
});
