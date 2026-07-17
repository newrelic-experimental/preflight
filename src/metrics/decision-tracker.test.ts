import { DecisionTracker } from './decision-tracker.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ToolCallRecord } from '../storage/types.js';

const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => stderrSpy.mockClear());

describe('DecisionTracker', () => {
  it('records decisions and returns metrics', () => {
    const tracker = new DecisionTracker();
    tracker.recordDecision({
      turnNumber: 1,
      reasoning: 'Need to read file to understand API',
      chosenAction: 'Read src/api.ts',
      toolName: 'Read',
    });

    const metrics = tracker.getMetrics();
    expect(metrics.totalBranches).toBe(1);
    expect(metrics.successRate).toBeNull(); // no outcomes yet
  });

  it('always reports an explanatory note about the templated reasoning field', () => {
    const tracker = new DecisionTracker();
    const metrics = tracker.getMetrics();
    expect(metrics.note).toBe(
      "reasoning fields are the model's own thinking/text output for that turn when NEW_RELIC_AI_MCP_RECORD_CONTENT is enabled and the underlying model exposes plaintext reasoning -- some models/transports return only an encrypted thinking signature with no plaintext, in which case this falls back to a rule-based label (e.g. 'recovery after X failure'). Branches are only recorded on 3 narrow triggers (failure recovery, AskUserQuestion, 3rd+ same-tool-same-file retry), not on every turn, so totalBranches undercounts ordinary turns.",
    );

    // Recording a real decision must not change the note -- the limitation
    // is architectural, not a function of whether any branch was ever recorded.
    tracker.recordDecision({
      turnNumber: 1,
      reasoning: 'test reasoning',
      chosenAction: 'read file',
      toolName: 'Read',
    });
    const metricsAfter = tracker.getMetrics();
    expect(metricsAfter.note).toBe(metrics.note);
  });

  it('tags branches with outcomes', () => {
    const tracker = new DecisionTracker();
    tracker.recordDecision({
      turnNumber: 1,
      reasoning: 'Fix the bug by editing the handler',
      chosenAction: 'Edit handler.ts',
      toolName: 'Edit',
    });
    tracker.recordOutcome(1, true);

    const metrics = tracker.getMetrics();
    expect(metrics.successRate).toBe(1);
    expect(metrics.failurePoints).toHaveLength(0);
  });

  it('tracks failure points', () => {
    const tracker = new DecisionTracker();
    tracker.recordDecision({
      turnNumber: 1,
      reasoning: 'Try approach A',
      chosenAction: 'Run tests',
      toolName: 'Bash',
    });
    tracker.recordOutcome(1, false);
    tracker.recordDecision({
      turnNumber: 2,
      reasoning: 'Try approach B',
      chosenAction: 'Run tests again',
      toolName: 'Bash',
    });
    tracker.recordOutcome(2, false);
    tracker.recordDecision({
      turnNumber: 3,
      reasoning: 'Try approach C',
      chosenAction: 'Fix the import',
      toolName: 'Edit',
    });
    tracker.recordOutcome(3, true);

    const metrics = tracker.getMetrics();
    expect(metrics.successRate).toBeCloseTo(0.333, 2);
    expect(metrics.failurePoints).toHaveLength(2);
    expect(metrics.longestFailureStreak).toBe(2);
    expect(metrics.firstFailureIndex).toBe(0);
  });

  it('computes longest failure streak', () => {
    const tracker = new DecisionTracker();
    // Success, fail, fail, fail, success
    for (let i = 1; i <= 5; i++) {
      tracker.recordDecision({
        turnNumber: i,
        reasoning: `Turn ${i}`,
        chosenAction: `action ${i}`,
        toolName: 'Bash',
      });
      tracker.recordOutcome(i, i === 1 || i === 5);
    }

    expect(tracker.getMetrics().longestFailureStreak).toBe(3);
  });

  it('marks session outcome on all branches', () => {
    const tracker = new DecisionTracker();
    tracker.recordDecision({ turnNumber: 1, reasoning: 'A', chosenAction: 'a', toolName: 'Read' });
    tracker.recordDecision({ turnNumber: 2, reasoning: 'B', chosenAction: 'b', toolName: 'Edit' });

    tracker.markSessionOutcome(true);

    const branches = tracker.getBranches();
    expect(branches[0].sessionSucceeded).toBe(true);
    expect(branches[1].sessionSucceeded).toBe(true);
  });

  it('getPostMortem returns failure zones', () => {
    const tracker = new DecisionTracker();
    tracker.recordDecision({
      turnNumber: 1,
      reasoning: 'OK',
      chosenAction: 'read',
      toolName: 'Read',
    });
    tracker.recordOutcome(1, true);
    tracker.recordDecision({
      turnNumber: 2,
      reasoning: 'Bad choice',
      chosenAction: 'edit',
      toolName: 'Edit',
    });
    tracker.recordOutcome(2, false);
    tracker.recordDecision({
      turnNumber: 3,
      reasoning: 'Still bad',
      chosenAction: 'edit again',
      toolName: 'Edit',
    });
    tracker.recordOutcome(3, false);
    tracker.recordDecision({
      turnNumber: 4,
      reasoning: 'Recovery',
      chosenAction: 'fix',
      toolName: 'Edit',
    });
    tracker.recordOutcome(4, true);

    const postMortem = tracker.getPostMortem();
    expect(postMortem).toHaveLength(3); // 2 failures + 1 recovery
    expect(postMortem[0].turnNumber).toBe(2);
    expect(postMortem[2].turnNumber).toBe(4);
  });

  it('truncates reasoning to configured max length', () => {
    const tracker = new DecisionTracker({ reasoningMaxLength: 10 });
    tracker.recordDecision({
      turnNumber: 1,
      reasoning: 'This is a very long reasoning string that exceeds the limit',
      chosenAction: 'Also very long action description here',
      toolName: 'Bash',
    });

    const branches = tracker.getBranches();
    expect(branches[0].reasoning).toHaveLength(10);
    expect(branches[0].chosenAction).toHaveLength(10);
  });

  it('caps branches at maxBranches', () => {
    const tracker = new DecisionTracker({ maxBranches: 5 });
    for (let i = 0; i < 10; i++) {
      tracker.recordDecision({
        turnNumber: i,
        reasoning: `R${i}`,
        chosenAction: `A${i}`,
        toolName: 'Bash',
      });
    }

    expect(tracker.getBranches()).toHaveLength(5);
    expect(tracker.getBranches()[0].turnNumber).toBe(5);
  });

  it('reset clears all state', () => {
    const tracker = new DecisionTracker();
    tracker.recordDecision({ turnNumber: 1, reasoning: 'R', chosenAction: 'A', toolName: 'Read' });
    tracker.recordOutcome(1, true);

    tracker.reset('new-session');
    expect(tracker.getMetrics().totalBranches).toBe(0);
    expect(tracker.getBranches()).toHaveLength(0);
  });
});

describe('DecisionTracker.recordToolCall triggers', () => {
  function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
      id: 'id-1',
      sessionId: 'session-1',
      toolName: 'Read',
      toolUseId: 'tool_1',
      timestamp: Date.now(),
      durationMs: 10,
      success: true,
      ...overrides,
    };
  }

  it('records an ask_user branch when AskUserQuestion is called', () => {
    const tracker = new DecisionTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'AskUserQuestion', toolUseId: 'tool_1' }));

    const branches = tracker.getBranches();
    expect(branches).toHaveLength(1);
    expect(branches[0].chosenAction).toBe('ask_user');
    expect(branches[0].reasoning).toBe('delegating to user');
  });

  it('records a retry branch on the 3rd same-tool-same-file call, with the count in the reasoning', () => {
    const tracker = new DecisionTracker();
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', filePath: 'src/a.ts', toolUseId: 'tool_1' }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', filePath: 'src/a.ts', toolUseId: 'tool_2' }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', filePath: 'src/a.ts', toolUseId: 'tool_3' }),
    );

    const branches = tracker.getBranches();
    const retryBranch = branches.find((b) => b.chosenAction === 'retry');
    expect(retryBranch).toBeDefined();
    expect(retryBranch?.reasoning).toBe('retrying Read on src/a.ts (3 attempts)');
  });
});

describe('DecisionTracker transcript reasoning extraction (recordContent)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'nr-decision-tracker-test-'));
    transcriptPath = resolve(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function assistantLine(
    messageId: string,
    block: Record<string, unknown>,
  ): Record<string, unknown> {
    return { type: 'assistant', message: { id: messageId, content: [block] } };
  }

  function writeTranscript(lines: Record<string, unknown>[]): void {
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
      id: 'id-1',
      sessionId: 'session-1',
      toolName: 'Read',
      toolUseId: 'tool_1',
      timestamp: Date.now(),
      durationMs: 10,
      success: true,
      ...overrides,
    };
  }

  it('uses the extracted transcript reasoning for the recovery branch when recordContent is enabled', () => {
    writeTranscript([
      assistantLine('msg_1', {
        type: 'thinking',
        thinking: 'Retrying with Read since Bash failed.',
      }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_2', name: 'Read', input: {} }),
    ]);

    const tracker = new DecisionTracker({ recordContent: true });
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', success: false, toolUseId: 'tool_1' }));
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', success: true, toolUseId: 'tool_2', transcriptPath }),
    );

    const branches = tracker.getBranches();
    expect(branches[0]?.reasoning).toBe('Retrying with Read since Bash failed.');
  });

  it('falls back to the template reasoning when recordContent is enabled but extraction finds no match', () => {
    writeTranscript([
      assistantLine('msg_1', { type: 'thinking', thinking: 'Unrelated reasoning.' }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_other', name: 'Read', input: {} }),
    ]);

    const tracker = new DecisionTracker({ recordContent: true });
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', success: false, toolUseId: 'tool_1' }));
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', success: true, toolUseId: 'tool_2', transcriptPath }),
    );

    const branches = tracker.getBranches();
    expect(branches[0]?.reasoning).toBe('recovery after Bash failure');
  });

  it('never attempts transcript extraction when recordContent is disabled (default)', () => {
    writeTranscript([
      assistantLine('msg_1', { type: 'thinking', thinking: 'This should never be read.' }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_2', name: 'Read', input: {} }),
    ]);

    const tracker = new DecisionTracker();
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', success: false, toolUseId: 'tool_1' }));
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', success: true, toolUseId: 'tool_2', transcriptPath }),
    );

    const branches = tracker.getBranches();
    expect(branches[0]?.reasoning).toBe('recovery after Bash failure');
  });
});
