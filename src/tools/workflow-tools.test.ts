import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, NrMcpServer } from '../server.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import { TaskDetector } from '../metrics/task-detector.js';
import { AntiPatternDetector } from '../metrics/anti-patterns.js';
import { EfficiencyScorer } from '../metrics/efficiency-score.js';
import {
  FeedbackCollector,
  handleGetWorkflowTrace,
  handleGetAntiPatterns,
  handleGetEfficiencyScore,
  handleReportFeedback,
} from './workflow-tools.js';
import { handleGetCostBreakdown } from './cost-tools.js';
import type { ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// handleGetCostBreakdown
// ---------------------------------------------------------------------------

describe('handleGetCostBreakdown()', () => {
  it('returns correct structure after 2 tasks with known costs', () => {
    const costTracker = new CostTracker();
    const taskDetector = new TaskDetector({ costTracker });

    // Task 1: start task, report tokens during task, then close
    taskDetector.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/a.ts' }));
    costTracker.recordTokenUsage(
      {
        inputTokens: 10000,
        outputTokens: 2000,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 12000,
      },
      'claude-sonnet-4',
    );
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    // Task 2: start task, report tokens during task, then close
    taskDetector.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/b.ts' }));
    costTracker.recordTokenUsage(
      {
        inputTokens: 5000,
        outputTokens: 1000,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 6000,
      },
      'claude-sonnet-4',
    );
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const result = handleGetCostBreakdown(costTracker, taskDetector);
    const body = JSON.parse(result.content[0].text);

    expect(body.total_usd).toBeGreaterThan(0);
    expect(body.by_model).toHaveProperty('claude-sonnet-4');
    expect(body.by_task).toHaveLength(2);
    expect(body.by_task[0].task_id).toBeDefined();
    expect(body.by_task[0].cost_usd).toBeGreaterThan(0);
    expect(body.by_task[0].tokens_used).toBeGreaterThan(0);
    expect(body.tokens.input).toBe(15000);
    expect(body.tokens.output).toBe(3000);
  });

  it('by_task matches completed tasks from TaskDetector', () => {
    const costTracker = new CostTracker();
    const taskDetector = new TaskDetector({ costTracker });

    taskDetector.recordToolCall(makeRecord({ toolName: 'Read' }));
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    taskDetector.recordToolCall(makeRecord({ toolName: 'Edit' }));
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const result = handleGetCostBreakdown(costTracker, taskDetector);
    const body = JSON.parse(result.content[0].text);

    const completedIds = taskDetector.getCompletedTasks().map((t) => t.taskId);
    const resultIds = body.by_task.map((t: { task_id: string }) => t.task_id);

    expect(resultIds).toEqual(completedIds);
  });

  it('returns zero totals when no cost data exists', () => {
    const costTracker = new CostTracker();

    const result = handleGetCostBreakdown(costTracker);
    const body = JSON.parse(result.content[0].text);

    expect(body.total_usd).toBe(0);
    expect(body.by_model).toEqual({});
    expect(body.by_task).toEqual([]);
    expect(body.tokens.input).toBe(0);
  });

  it('includes cache_read and cache_creation token counts in the response', () => {
    const costTracker = new CostTracker();

    costTracker.recordTokenUsage(
      {
        inputTokens: 1000,
        outputTokens: 500,
        thinkingTokens: 0,
        cacheReadTokens: 200,
        cacheCreationTokens: 300,
        totalTokens: 2000,
      },
      'claude-sonnet-4',
    );

    const result = handleGetCostBreakdown(costTracker);
    const body = JSON.parse(result.content[0].text);

    expect(body.tokens.cache_read).toBe(200);
    expect(body.tokens.cache_creation).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// handleGetWorkflowTrace
// ---------------------------------------------------------------------------

describe('handleGetWorkflowTrace()', () => {
  it('returns tool calls in correct sequence for the specified task', () => {
    const taskDetector = new TaskDetector();

    taskDetector.recordToolCall(
      makeRecord({ toolName: 'Read', filePath: '/a.ts', durationMs: 32 }),
    );
    taskDetector.recordToolCall(
      makeRecord({ toolName: 'Edit', filePath: '/a.ts', durationMs: 18 }),
    );
    taskDetector.recordToolCall(
      makeRecord({ toolName: 'Bash', command: 'npm test', durationMs: 4800, exitCode: 0 }),
    );
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const taskId = taskDetector.getCompletedTasks()[0].taskId;
    const result = handleGetWorkflowTrace(taskDetector, undefined, undefined, taskId);
    const body = JSON.parse(result.content[0].text);

    expect(body.task_id).toBe(taskId);
    expect(body.tool_calls).toHaveLength(4);
    expect(body.tool_calls[0]).toEqual(
      expect.objectContaining({
        seq: 1,
        tool: 'Read',
        target: '/a.ts',
        duration_ms: 32,
        success: true,
      }),
    );
    expect(body.tool_calls[1]).toEqual(
      expect.objectContaining({ seq: 2, tool: 'Edit', target: '/a.ts' }),
    );
    expect(body.tool_calls[2]).toEqual(
      expect.objectContaining({ seq: 3, tool: 'Bash', target: 'npm test', exit_code: 0 }),
    );
    expect(body.tool_calls[3]).toEqual(
      expect.objectContaining({ seq: 4, tool: 'AskUserQuestion' }),
    );
  });

  it('with no task_id returns the most recent task', () => {
    const taskDetector = new TaskDetector();

    // Task 1
    taskDetector.recordToolCall(makeRecord({ toolName: 'Read' }));
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    // Task 2
    taskDetector.recordToolCall(makeRecord({ toolName: 'Edit' }));
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const completed = taskDetector.getCompletedTasks();
    const result = handleGetWorkflowTrace(taskDetector);
    const body = JSON.parse(result.content[0].text);

    expect(body.task_id).toBe(completed[1].taskId);
    expect(body.tool_calls).toHaveLength(2);
    expect(body.tool_calls[0].tool).toBe('Edit');
  });

  it('includes anti_patterns when AntiPatternDetector is provided', () => {
    const taskDetector = new TaskDetector();
    const antiPatterns = new AntiPatternDetector();

    // Create a task with re-reading pattern
    for (let i = 0; i < 5; i++) {
      taskDetector.recordToolCall(makeRecord({ toolName: 'Read', filePath: '/same.ts' }));
    }
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const result = handleGetWorkflowTrace(taskDetector, antiPatterns);
    const body = JSON.parse(result.content[0].text);

    expect(body.anti_patterns.length).toBeGreaterThan(0);
    expect(body.anti_patterns[0].type).toBe('re_reading');
  });

  it('includes efficiency_score when EfficiencyScorer is provided', () => {
    const taskDetector = new TaskDetector();
    const scorer = new EfficiencyScorer();

    taskDetector.recordToolCall(makeRecord({ toolName: 'Read' }));
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const result = handleGetWorkflowTrace(taskDetector, undefined, scorer);
    const body = JSON.parse(result.content[0].text);

    expect(typeof body.efficiency_score).toBe('number');
    expect(body.efficiency_score).toBeGreaterThanOrEqual(0);
    expect(body.efficiency_score).toBeLessThanOrEqual(1);
  });

  it('returns error when no matching task found', () => {
    const taskDetector = new TaskDetector();

    const result = handleGetWorkflowTrace(taskDetector, undefined, undefined, 'nonexistent');
    const body = JSON.parse(result.content[0].text);

    expect(body.error).toBe('No matching task found');
  });
});

// ---------------------------------------------------------------------------
// handleGetAntiPatterns
// ---------------------------------------------------------------------------

describe('handleGetAntiPatterns()', () => {
  it('returns detected patterns from the most recent task', () => {
    const taskDetector = new TaskDetector();
    const antiPatterns = new AntiPatternDetector();

    // Thrashing pattern
    for (let i = 0; i < 3; i++) {
      taskDetector.recordToolCall(makeRecord({ toolName: 'Edit', filePath: '/auth.ts' }));
      taskDetector.recordToolCall(
        makeRecord({ toolName: 'Bash', isTestCommand: true, success: false }),
      );
    }
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const result = handleGetAntiPatterns(taskDetector, antiPatterns);
    const body = JSON.parse(result.content[0].text);

    expect(body.length).toBeGreaterThan(0);
    const thrashing = body.find((p: { type: string }) => p.type === 'thrashing');
    expect(thrashing).toBeDefined();
    expect(thrashing.file).toBe('/auth.ts');
    expect(thrashing.iterations).toBe(3);
    expect(thrashing.suggestion).toBeDefined();
  });

  it('includes bash_category on stuck_loop patterns', () => {
    const taskDetector = new TaskDetector();
    const antiPatterns = new AntiPatternDetector();

    for (let i = 0; i < 4; i++) {
      taskDetector.recordToolCall(
        makeRecord({
          toolName: 'Bash',
          command: 'npm test',
          bashCategory: 'test-runner',
        } as Partial<ToolCallRecord>),
      );
    }
    taskDetector.recordToolCall(makeRecord({ toolName: 'AskUserQuestion' }));

    const result = handleGetAntiPatterns(taskDetector, antiPatterns);
    const body = JSON.parse(result.content[0].text);

    const stuck = body.find((p: { type: string }) => p.type === 'stuck_loop');
    expect(stuck).toBeDefined();
    expect(stuck.bash_category).toBe('test-runner');
  });

  it('returns empty array when no tasks exist', () => {
    const taskDetector = new TaskDetector();
    const antiPatterns = new AntiPatternDetector();

    const result = handleGetAntiPatterns(taskDetector, antiPatterns);
    const body = JSON.parse(result.content[0].text);

    expect(body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleGetEfficiencyScore
// ---------------------------------------------------------------------------

describe('handleGetEfficiencyScore()', () => {
  it('returns latest score and session average', () => {
    const scorer = new EfficiencyScorer();

    scorer.computeScore({
      taskId: 't1',
      startTime: 1000,
      endTime: 61000,
      durationMs: 60000,
      toolCallCount: 10,
      toolCallsByType: {},
      filesRead: [],
      filesModified: [],
      linesChanged: 50,
      linesAdded: 50,
      linesRemoved: 0,
      bashCommandsRun: 1,
      testsRun: 4,
      testsPassed: 4,
      buildRun: 0,
      buildPassed: 0,
      estimatedCostUsd: null,
      tokensUsed: 0,
      askedUserQuestions: 0,
      subAgentsSpawned: 0,
      toolCalls: [],
    });
    scorer.computeScore({
      taskId: 't2',
      startTime: 1000,
      endTime: 61000,
      durationMs: 60000,
      toolCallCount: 10,
      toolCallsByType: {},
      filesRead: [],
      filesModified: [],
      linesChanged: 30,
      linesAdded: 30,
      linesRemoved: 0,
      bashCommandsRun: 1,
      testsRun: 4,
      testsPassed: 2,
      buildRun: 0,
      buildPassed: 0,
      estimatedCostUsd: null,
      tokensUsed: 0,
      askedUserQuestions: 0,
      subAgentsSpawned: 0,
      toolCalls: [],
    });

    const result = handleGetEfficiencyScore(scorer);
    const body = JSON.parse(result.content[0].text);

    expect(body.latest).not.toBeNull();
    expect(body.latest.task_id).toBe('t2');
    expect(body.latest.score).toBeGreaterThan(0);
    expect(body.latest.components).toHaveProperty('speed');
    expect(body.latest.components).toHaveProperty('correctness');
    expect(body.latest.components).toHaveProperty('autonomy');
    expect(body.latest.components).toHaveProperty('firstAttemptQuality');

    expect(body.session_average).not.toBeNull();
    expect(body.session_average.tasks_scored).toBe(2);
  });

  it('returns null when no tasks have been scored and no taskDetector provided', () => {
    const scorer = new EfficiencyScorer();

    const result = handleGetEfficiencyScore(scorer);
    const body = JSON.parse(result.content[0].text);

    expect(body.latest).toBeNull();
    expect(body.session_average).toBeNull();
  });

  it('computes scores on demand from active task via taskDetector', () => {
    const scorer = new EfficiencyScorer();
    const detector = new TaskDetector();
    const antiPatterns = new AntiPatternDetector();

    // Record tool calls to create an active task
    detector.recordToolCall(makeRecord({ toolName: 'Read', timestamp: 1000 }));
    detector.recordToolCall(makeRecord({ toolName: 'Edit', timestamp: 2000 }));
    detector.recordToolCall(makeRecord({ toolName: 'Bash', timestamp: 3000 }));

    // No completed tasks yet — but there IS an active task
    expect(detector.getCompletedTasks()).toHaveLength(0);

    const result = handleGetEfficiencyScore(scorer, detector, antiPatterns);
    const body = JSON.parse(result.content[0].text);

    expect(body.latest).not.toBeNull();
    expect(body.latest.score).toBeGreaterThanOrEqual(0);
    expect(body.session_average).not.toBeNull();
    expect(body.session_average.tasks_scored).toBe(1);
  });

  it('does not double-score already-scored tasks', () => {
    const scorer = new EfficiencyScorer();
    const detector = new TaskDetector();
    const antiPatterns = new AntiPatternDetector();

    detector.recordToolCall(makeRecord({ toolName: 'Read', timestamp: 1000 }));

    // First call scores the active task
    handleGetEfficiencyScore(scorer, detector, antiPatterns);
    expect(scorer.getScores()).toHaveLength(1);

    // Second call should not add a duplicate
    handleGetEfficiencyScore(scorer, detector, antiPatterns);
    expect(scorer.getScores()).toHaveLength(1);
  });

  it('latest reflects the active task after updateScore, not a later-inserted completed task (B-05)', () => {
    const scorer = new EfficiencyScorer();

    // Score active task first (inserted at index 0), endTime = 1000
    scorer.computeScore({
      taskId: 'active',
      startTime: 0,
      endTime: 1000,
      durationMs: 1000,
      toolCallCount: 5,
      toolCallsByType: {},
      filesRead: [],
      filesModified: [],
      linesChanged: 10,
      linesAdded: 10,
      linesRemoved: 0,
      bashCommandsRun: 0,
      testsRun: 0,
      testsPassed: 0,
      buildRun: 0,
      buildPassed: 0,
      estimatedCostUsd: null,
      tokensUsed: 0,
      askedUserQuestions: 0,
      subAgentsSpawned: 0,
      toolCalls: [],
    });

    // Score a completed task second (inserted at index 1), endTime = 500 (earlier)
    scorer.computeScore({
      taskId: 'completed',
      startTime: 0,
      endTime: 500,
      durationMs: 500,
      toolCallCount: 3,
      toolCallsByType: {},
      filesRead: [],
      filesModified: [],
      linesChanged: 5,
      linesAdded: 5,
      linesRemoved: 0,
      bashCommandsRun: 0,
      testsRun: 0,
      testsPassed: 0,
      buildRun: 0,
      buildPassed: 0,
      estimatedCostUsd: null,
      tokensUsed: 0,
      askedUserQuestions: 0,
      subAgentsSpawned: 0,
      toolCalls: [],
    });

    // Update the active task with a newer timestamp (endTime = 2000, more recent than both)
    scorer.updateScore({
      taskId: 'active',
      startTime: 0,
      endTime: 2000,
      durationMs: 2000,
      toolCallCount: 8,
      toolCallsByType: {},
      filesRead: [],
      filesModified: [],
      linesChanged: 20,
      linesAdded: 20,
      linesRemoved: 0,
      bashCommandsRun: 1,
      testsRun: 1,
      testsPassed: 1,
      buildRun: 0,
      buildPassed: 0,
      estimatedCostUsd: null,
      tokensUsed: 0,
      askedUserQuestions: 0,
      subAgentsSpawned: 0,
      toolCalls: [],
    });

    // scores array is [active(ts=2000, idx=0), completed(ts=500, idx=1)]
    // scores[last] would return 'completed' (wrong); reduce by timestamp returns 'active' (correct)
    const result = handleGetEfficiencyScore(scorer);
    const body = JSON.parse(result.content[0].text);

    expect(body.latest).not.toBeNull();
    expect(body.latest.task_id).toBe('active');
    expect(body.latest.timestamp).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// handleReportFeedback
// ---------------------------------------------------------------------------

describe('handleReportFeedback()', () => {
  it('records feedback with quality: good', () => {
    const collector = new FeedbackCollector();

    const result = handleReportFeedback(collector, {
      quality: 'good',
      notes: 'Fast work',
      task_id: 'task-1',
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.recorded).toBe(true);
    expect(body.quality).toBe('good');
    expect(body.task_id).toBe('task-1');
    expect(body.timestamp).toBeGreaterThan(0);

    const records = collector.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].quality).toBe('good');
    expect(records[0].notes).toBe('Fast work');
    expect(records[0].taskId).toBe('task-1');
  });

  it('records feedback without optional fields', () => {
    const collector = new FeedbackCollector();

    const result = handleReportFeedback(collector, { quality: 'neutral' });
    const body = JSON.parse(result.content[0].text);

    expect(body.recorded).toBe(true);
    expect(body.quality).toBe('neutral');
    expect(body.task_id).toBeNull();
  });

  it('rejects invalid quality values', () => {
    const collector = new FeedbackCollector();

    const result = handleReportFeedback(collector, { quality: 'excellent' as 'good' });
    const body = JSON.parse(result.content[0].text);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(body.error).toContain('Invalid quality value');
    expect(body.error).toContain('excellent');
    expect(collector.getRecords()).toHaveLength(0);
  });

  it('accepts all valid quality values', () => {
    const collector = new FeedbackCollector();

    for (const quality of ['good', 'bad', 'neutral'] as const) {
      const result = handleReportFeedback(collector, { quality });
      const body = JSON.parse(result.content[0].text);
      expect(body.recorded).toBe(true);
      expect(body.quality).toBe(quality);
    }

    expect(collector.getRecords()).toHaveLength(3);
  });

  // unbounded free-text inputs
  it('truncates notes longer than 1024 chars', () => {
    const collector = new FeedbackCollector();
    const longNotes = 'x'.repeat(2000);
    handleReportFeedback(collector, { quality: 'good', notes: longNotes });
    const records = collector.getRecords();
    expect(records[0].notes?.length).toBe(1024);
  });

  it('passes notes shorter than 1024 chars unchanged', () => {
    const collector = new FeedbackCollector();
    const notes = 'short note';
    handleReportFeedback(collector, { quality: 'good', notes });
    expect(collector.getRecords()[0].notes).toBe('short note');
  });
});

// ---------------------------------------------------------------------------
// FeedbackCollector.emitMetrics
// ---------------------------------------------------------------------------

describe('FeedbackCollector.emitMetrics()', () => {
  it('records ai.feedback.count with quality attribute', () => {
    const collector = new FeedbackCollector();
    collector.record({ quality: 'good' });
    collector.record({ quality: 'bad' });

    const recorded: Array<{ name: string; value: number; attrs: Record<string, string | number> }> =
      [];
    const aggregator = {
      record(name: string, value: number, attrs: Record<string, string | number> = {}) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as import('../shared/index.js').MetricAggregator;

    collector.emitMetrics(aggregator);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual({
      name: 'ai.feedback.count',
      value: 1,
      attrs: { quality: 'good' },
    });
    expect(recorded[1]).toEqual({ name: 'ai.feedback.count', value: 1, attrs: { quality: 'bad' } });
  });
});

// ---------------------------------------------------------------------------
// MCP protocol integration — all Phase 2 tools
// ---------------------------------------------------------------------------

describe('MCP protocol integration — Phase 2 tools', () => {
  let server: NrMcpServer;
  let client: Client;
  let costTracker: CostTracker;
  let taskDetector: TaskDetector;
  let antiPatterns: AntiPatternDetector;
  let scorer: EfficiencyScorer;
  let feedback: FeedbackCollector;

  beforeEach(async () => {
    jest.useRealTimers(); // MCP transport needs real timers

    costTracker = new CostTracker();
    taskDetector = new TaskDetector({ costTracker });
    antiPatterns = new AntiPatternDetector();
    scorer = new EfficiencyScorer();
    feedback = new FeedbackCollector();

    server = createServer({
      name: 'phase2-mcp',
      version: '0.0.1',
      costTracker,
      taskDetector,
      antiPatternDetector: antiPatterns,
      efficiencyScorer: scorer,
      feedbackCollector: feedback,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    taskDetector.dispose();
    await client.close();
    await server.close();
  });

  it('tools/list includes all Phase 2 tools with correct schemas', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain('nr_observe_report_tokens');
    expect(names).toContain('nr_observe_get_cost_breakdown');
    expect(names).toContain('nr_observe_get_workflow_trace');
    expect(names).toContain('nr_observe_get_anti_patterns');
    expect(names).toContain('nr_observe_get_efficiency_score');
    expect(names).toContain('nr_observe_report_feedback');

    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('calling tools when no data exists returns empty/zero results', async () => {
    const costResult = await client.callTool({
      name: 'nr_observe_get_cost_breakdown',
      arguments: {},
    });
    const costBody = JSON.parse((costResult.content as Array<{ text: string }>)[0].text);
    expect(costBody.total_usd).toBe(0);
    expect(costBody.by_task).toEqual([]);

    const antiResult = await client.callTool({
      name: 'nr_observe_get_anti_patterns',
      arguments: {},
    });
    const antiBody = JSON.parse((antiResult.content as Array<{ text: string }>)[0].text);
    expect(antiBody).toEqual([]);

    const effResult = await client.callTool({
      name: 'nr_observe_get_efficiency_score',
      arguments: {},
    });
    const effBody = JSON.parse((effResult.content as Array<{ text: string }>)[0].text);
    expect(effBody.latest).toBeNull();
    expect(effBody.session_average).toBeNull();
  });

  it('nr_observe_report_feedback via MCP returns confirmation', async () => {
    const result = await client.callTool({
      name: 'nr_observe_report_feedback',
      arguments: { quality: 'good', notes: 'Great job!' },
    });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    expect(body.recorded).toBe(true);
    expect(body.quality).toBe('good');
  });
});
