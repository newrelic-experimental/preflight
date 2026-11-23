import { describe, it, expect } from '@jest/globals';

import type { SkillStamp, ToolCallRecord } from '../storage/types.js';
import { SkillActivationTracker } from './skill-activation-tracker.js';
import type { SkillRunOpenContext } from './skill-activation-tracker.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from './task-detector.js';

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

  it('prompt without slash closes the main run', () => {
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

  it('closes the main run after an idle gap and stamps later calls with nothing', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));
    t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'other', sessionId: 's2', timestamp: 1000 }),
    );

    t.recordToolCall(makeRecord({ sessionId: 's2', toolUseId: 'u4', timestamp: 20_000 }));

    const later = 1100 + DEFAULT_IDLE_TIMEOUT_MS + 1;
    expect(t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: later }))).toBeNull();
    expect(
      t.recordToolCall(makeRecord({ sessionId: 's2', toolUseId: 'u3', timestamp: later }))?.name,
    ).toBe('other');
  });

  it('keeps the run open for a gap at or under the idle timeout', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));

    const stamp = t.recordToolCall(
      makeRecord({ toolUseId: 'u2', timestamp: 1100 + DEFAULT_IDLE_TIMEOUT_MS }),
    );

    expect(stamp?.name).toBe('eslint');
  });

  it('measures the gap from the latest record of any agent, not only the main agent', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));
    t.recordToolCall(makeRecord({ agentId: 'a1', toolUseId: 'u2', timestamp: 25_000 }));

    const stamp = t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 50_000 }));

    expect(stamp?.name).toBe('eslint');
  });

  it('keeps a subagent pinned to its run across an idle gap on the main agent', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));
    t.recordToolCall(makeRecord({ agentId: 'a1', toolUseId: 'u2', timestamp: 1500 }));

    const later = 1600 + DEFAULT_IDLE_TIMEOUT_MS + 1;
    expect(t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: later }))).toBeNull();
    expect(
      t.recordToolCall(makeRecord({ agentId: 'a1', toolUseId: 'u4', timestamp: later }))?.name,
    ).toBe('eslint');
  });

  it('never closes on a gap once the session has had a prompt', () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', null);
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));

    const stamp = t.recordToolCall(
      makeRecord({ toolUseId: 'u2', timestamp: 1000 + DEFAULT_IDLE_TIMEOUT_MS * 20 }),
    );

    expect(stamp?.name).toBe('eslint');
  });

  it('returns a reset session to gap mode', () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', null);
    t.reset();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));

    const stamp = t.recordToolCall(
      makeRecord({ toolUseId: 'u2', timestamp: 1100 + DEFAULT_IDLE_TIMEOUT_MS + 1 }),
    );

    expect(stamp).toBeNull();
  });

  it('measures the gap from the end of a long call, not its start', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));
    t.recordToolCall(
      makeRecord({ toolName: 'Bash', toolUseId: 'u2', timestamp: 2000, durationMs: 120_000 }),
    );

    const stamp = t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 127_000 }));

    expect(stamp?.name).toBe('eslint');
  });

  it('keeps the main run open when a subagent call ends the gap', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));
    t.recordToolCall(makeRecord({ agentId: 'a1', toolUseId: 'u2', timestamp: 1500 }));

    const later = 1600 + DEFAULT_IDLE_TIMEOUT_MS + 1;
    t.recordToolCall(makeRecord({ agentId: 'a1', toolUseId: 'u3', timestamp: later }));

    expect(t.openRun('s1')?.name).toBe('eslint');
  });

  it('ignores a late record with an older timestamp when measuring the gap', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u2', timestamp: 26_000 }));
    t.recordToolCall(makeRecord({ toolUseId: 'u3', timestamp: 5000 }));

    const stamp = t.recordToolCall(makeRecord({ toolUseId: 'u4', timestamp: 40_000 }));

    expect(stamp?.name).toBe('eslint');
  });

  it('returns an evicted prompted session to gap mode when it reappears', () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', null);
    for (let i = 0; i < 60; i++) t.recordToolCall(makeRecord({ sessionId: `other-${i}` }));
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', timestamp: 1000 }));

    const stamp = t.recordToolCall(
      makeRecord({ toolUseId: 'u2', timestamp: 1100 + DEFAULT_IDLE_TIMEOUT_MS + 1 }),
    );

    expect(stamp).toBeNull();
  });

  it('does not count the wait for a prompt to produce its first tool call as an idle gap', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ timestamp: 1000 }));
    t.recordPrompt('s1', 'lint');

    const stamp = t.recordToolCall(
      makeRecord({ toolUseId: 'u2', timestamp: 1000 + DEFAULT_IDLE_TIMEOUT_MS * 2 }),
    );

    expect(stamp?.name).toBe('lint');
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

  it('a subagent keeps the run open when it first appeared after main moves on', () => {
    const t = new SkillActivationTracker();
    const spawning = t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'a' }));
    t.recordToolCall(makeRecord({ toolName: 'Read', agentId: 'bg-1' }));

    t.recordPrompt('s1', 'simplify');
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'b' }));
    const later = t.recordToolCall(makeRecord({ toolName: 'Bash', agentId: 'bg-1' }));

    expect(later!.runId).toBe(spawning!.runId);
  });

  it('a subagent that appeared outside any run stays unattributed', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', agentId: 'bg-1' }));
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'a' }));

    expect(t.recordToolCall(makeRecord({ toolName: 'Bash', agentId: 'bg-1' }))).toBeNull();
  });

  it('a failed or interrupted Skill call opens no run', () => {
    const t = new SkillActivationTracker();
    const stamp = t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'code-review', success: false }),
    );

    expect(stamp).toBeNull();
    expect(t.recordToolCall(makeRecord({ toolName: 'Read' }))).toBeNull();
  });

  it('a Skill call naming the slash skill already open continues that run', () => {
    const t = new SkillActivationTracker();
    const slash = t.recordPrompt('s1', 'code-review');

    const stamp = t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'code-review', toolUseId: 'u2' }),
    );

    expect(stamp).toEqual(slash);
    expect(stamp!.parentRunId).toBeUndefined();
  });

  it('a Skill call naming a different skill after a slash run still opens a child run', () => {
    const t = new SkillActivationTracker();
    const slash = t.recordPrompt('s1', 'code-review');

    const stamp = t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'unslop', toolUseId: 'u2' }),
    );

    expect(stamp).toMatchObject({ name: 'unslop', source: 'tool', parentRunId: slash!.runId });
  });

  it('a repeated tool-source Skill call of the same skill still opens a new run', () => {
    const t = new SkillActivationTracker();
    const first = t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'lint' }));
    const second = t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'lint', toolUseId: 'u2' }),
    );

    expect(second!.runId).not.toBe(first!.runId);
  });

  it('caps the subagents remembered per session and keeps the main run', () => {
    const t = new SkillActivationTracker();
    const main = t.recordPrompt('s1', 'big-skill');
    for (let i = 0; i < 300; i++) {
      t.recordToolCall(makeRecord({ agentId: `agent-${i}`, toolUseId: `u${i}` }));
    }

    expect(t.recordToolCall(makeRecord({ toolUseId: 'main-call' }))).toEqual(main);
    expect(t.getMetrics('s1').openRuns).toEqual([main]);
  });

  it('recordPrompt returns the slash run it opens', () => {
    const t = new SkillActivationTracker();

    expect(t.recordPrompt('s1', 'simplify')).toMatchObject({ name: 'simplify', source: 'slash' });
    expect(t.recordPrompt('s1', null)).toBeNull();
  });

  it('getMetrics lists each open run once, scoped by session when asked', () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', 'a');
    t.recordToolCall(makeRecord({ toolName: 'Read', agentId: 'sub-1' }));
    t.recordPrompt('s2', 'b');

    expect(
      t
        .getMetrics()
        .openRuns.map((r) => r.name)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(t.getMetrics('s1').openRuns.map((r) => r.name)).toEqual(['a']);
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

function makeTrackerWithOpenLog(): {
  tracker: SkillActivationTracker;
  opened: Array<{ stamp: SkillStamp; ctx: SkillRunOpenContext }>;
} {
  const opened: Array<{ stamp: SkillStamp; ctx: SkillRunOpenContext }> = [];
  const tracker = new SkillActivationTracker({
    onRunOpened: (stamp, ctx) => {
      opened.push({ stamp, ctx });
    },
  });
  return { tracker, opened };
}

describe('SkillActivationTracker.openRun', () => {
  it('returns the slash run until the next prompt closes it', () => {
    const t = new SkillActivationTracker();
    const run = t.recordPrompt('s1', 'review');

    expect(t.openRun('s1')).toEqual(run);
    expect(t.openRun('s2')).toBeNull();

    t.recordPrompt('s1', null);
    expect(t.openRun('s1')).toBeNull();
  });

  it('returns a tool-opened run to later replies in the session', () => {
    const t = new SkillActivationTracker();
    const run = t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint' }));

    expect(t.openRun('s1')).toEqual(run);
  });

  it('ignores a run a subagent opened', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'eslint', agentId: 'agent-1' }));

    expect(t.openRun('s1')).toBeNull();
  });
});

describe('SkillActivationTracker.recordToolStart', () => {
  it('stamps a call recorded after a later prompt with the run open when it started', () => {
    const t = new SkillActivationTracker();
    const review = t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'review' }));
    t.recordToolStart('s1', 'bash-1', 1000);
    t.recordPrompt('s1', 'simplify');

    expect(t.recordToolCall(makeRecord({ toolName: 'Bash', toolUseId: 'bash-1' }))).toEqual(review);
    expect(t.recordToolCall(makeRecord({ toolName: 'Bash', toolUseId: 'bash-2' }))?.name).toBe(
      'simplify',
    );
  });

  it('leaves a call that started outside any run unattributed', () => {
    const t = new SkillActivationTracker();
    t.recordToolStart('s1', 'bash-1', 1000);
    t.recordPrompt('s1', 'simplify');

    expect(t.recordToolCall(makeRecord({ toolName: 'Bash', toolUseId: 'bash-1' }))).toBeNull();
  });

  it("does not lend one session's start to another session's call", () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', 'review');
    t.recordToolStart('s1', 'bash-1', 1000);
    const simplify = t.recordPrompt('s2', 'simplify');

    expect(
      t.recordToolCall(makeRecord({ sessionId: 's2', toolName: 'Bash', toolUseId: 'bash-1' })),
    ).toEqual(simplify);
  });

  it('does not keep a run open for a call that started after an idle gap', () => {
    const t = new SkillActivationTracker();
    t.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'review' }));
    const later = 1100 + DEFAULT_IDLE_TIMEOUT_MS + 1;
    t.recordToolStart('s1', 'bash-1', later);
    t.recordToolStart('s1', 'bash-2', later);

    expect(
      t.recordToolCall(makeRecord({ toolName: 'Bash', toolUseId: 'bash-1', timestamp: later })),
    ).toBeNull();
    expect(
      t.recordToolCall(makeRecord({ toolName: 'Bash', toolUseId: 'bash-2', timestamp: later })),
    ).toBeNull();
  });

  it('keeps a subagent call on the run the subagent opened', () => {
    const t = new SkillActivationTracker();
    t.recordPrompt('s1', 'review');
    const lint = t.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'lint', agentId: 'agent-1' }),
    );
    t.recordToolStart('s1', 'read-1', 1000);

    expect(t.recordToolCall(makeRecord({ toolUseId: 'read-1', agentId: 'agent-1' }))).toEqual(lint);
  });
});

describe('SkillActivationTracker onRunOpened', () => {
  it('fires again for a run reopened after an idle gap closed the last one', () => {
    const opened: SkillStamp[] = [];
    const closed: Array<{ stamp: SkillStamp; timestamp: number }> = [];
    const tracker = new SkillActivationTracker({
      onRunOpened: (stamp) => opened.push(stamp),
      onRunIdleClosed: (stamp, timestamp) => closed.push({ stamp, timestamp }),
    });
    const first = tracker.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'lint', timestamp: 1000 }),
    );
    const later = 1100 + DEFAULT_IDLE_TIMEOUT_MS + 1;
    const second = tracker.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'lint', toolUseId: 'u2', timestamp: later }),
    );

    expect(opened).toEqual([first, second]);
    expect(second?.runId).not.toBe(first?.runId);
    expect(second).not.toHaveProperty('parentRunId');
    expect(closed).toEqual([{ stamp: first, timestamp: later }]);
  });

  it('reports no idle close for a gap with no run open', () => {
    const closed: SkillStamp[] = [];
    const tracker = new SkillActivationTracker({ onRunIdleClosed: (stamp) => closed.push(stamp) });
    tracker.recordToolCall(makeRecord({ timestamp: 1000 }));
    tracker.recordToolCall(
      makeRecord({ toolUseId: 'u2', timestamp: 1100 + DEFAULT_IDLE_TIMEOUT_MS + 1 }),
    );

    expect(closed).toHaveLength(0);
  });

  it('fires once for a Skill tool run with the stamp it returned and the record context', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    const stamp = tracker.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'lint', timestamp: 1500 }),
    );
    tracker.recordToolCall(makeRecord({ toolName: 'Read', toolUseId: 'u2', timestamp: 1600 }));

    expect(opened).toHaveLength(1);
    expect(opened[0]!.stamp).toEqual(stamp);
    expect(opened[0]!.stamp).toMatchObject({ name: 'lint', source: 'tool' });
    expect(opened[0]!.ctx).toEqual({ sessionId: 's1', timestamp: 1500 });
  });

  it('passes the platform of the record that opened a Skill run', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    tracker.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'lint', platform: 'opencode' }),
    );

    expect(opened[0]!.ctx.platform).toBe('opencode');
  });

  it('fires once for a slash run and passes the prompt timestamp', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    tracker.recordPrompt('s1', 'simplify', 2000);
    tracker.recordToolCall(makeRecord({ toolName: 'Read' }));

    expect(opened).toHaveLength(1);
    expect(opened[0]!.stamp).toMatchObject({ name: 'simplify', source: 'slash' });
    expect(opened[0]!.ctx).toEqual({ sessionId: 's1', timestamp: 2000 });
  });

  it('does not fire for a prompt that opens no run', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    tracker.recordPrompt('s1', null, 2000);

    expect(opened).toHaveLength(0);
  });

  it('does not fire when a Skill call repeats the slash run already open', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    tracker.recordPrompt('s1', 'code-review', 2000);
    tracker.recordToolCall(
      makeRecord({ toolName: 'Skill', skillName: 'code-review', toolUseId: 'u2' }),
    );

    expect(opened).toHaveLength(1);
    expect(opened[0]!.stamp).toMatchObject({ name: 'code-review', source: 'slash' });
  });

  it('does not fire when a subagent pins the main run it first appeared under', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    tracker.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'main-skill' }));
    tracker.recordToolCall(makeRecord({ toolName: 'Read', agentId: 'bg-1', toolUseId: 'u2' }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', agentId: 'bg-1', toolUseId: 'u3' }));

    expect(opened).toHaveLength(1);
    expect(opened[0]!.stamp).toMatchObject({ name: 'main-skill', source: 'tool' });
  });

  it('fires for a subagent Skill call that opens its own run', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    tracker.recordToolCall(makeRecord({ toolName: 'Skill', skillName: 'main-skill' }));
    tracker.recordToolCall(
      makeRecord({
        toolName: 'Skill',
        skillName: 'sub-skill',
        agentId: 'agent-1',
        toolUseId: 'u2',
      }),
    );

    expect(opened).toHaveLength(2);
    expect(opened[1]!.stamp).toMatchObject({ name: 'sub-skill', source: 'tool' });
  });

  it('passes a null session and an undefined timestamp when neither was given', () => {
    const { tracker, opened } = makeTrackerWithOpenLog();
    tracker.recordPrompt(undefined, 'lint');

    expect(opened).toHaveLength(1);
    expect(opened[0]!.ctx).toEqual({ sessionId: null, timestamp: undefined });
  });
});
