import { DecisionTracker } from './decision-tracker.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
    tracker.recordDecision({ turnNumber: 1, reasoning: 'Try approach A', chosenAction: 'Run tests', toolName: 'Bash' });
    tracker.recordOutcome(1, false);
    tracker.recordDecision({ turnNumber: 2, reasoning: 'Try approach B', chosenAction: 'Run tests again', toolName: 'Bash' });
    tracker.recordOutcome(2, false);
    tracker.recordDecision({ turnNumber: 3, reasoning: 'Try approach C', chosenAction: 'Fix the import', toolName: 'Edit' });
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
      tracker.recordDecision({ turnNumber: i, reasoning: `Turn ${i}`, chosenAction: `action ${i}`, toolName: 'Bash' });
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
    tracker.recordDecision({ turnNumber: 1, reasoning: 'OK', chosenAction: 'read', toolName: 'Read' });
    tracker.recordOutcome(1, true);
    tracker.recordDecision({ turnNumber: 2, reasoning: 'Bad choice', chosenAction: 'edit', toolName: 'Edit' });
    tracker.recordOutcome(2, false);
    tracker.recordDecision({ turnNumber: 3, reasoning: 'Still bad', chosenAction: 'edit again', toolName: 'Edit' });
    tracker.recordOutcome(3, false);
    tracker.recordDecision({ turnNumber: 4, reasoning: 'Recovery', chosenAction: 'fix', toolName: 'Edit' });
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
      tracker.recordDecision({ turnNumber: i, reasoning: `R${i}`, chosenAction: `A${i}`, toolName: 'Bash' });
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
