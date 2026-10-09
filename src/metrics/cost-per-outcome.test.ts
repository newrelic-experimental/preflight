import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { MetricAggregator } from '../shared/index.js';
import type { AiCodingTask } from './task-detector.js';
import type { ToolCallRecord } from '../storage/types.js';
import {
  CostPerOutcomeAnalyzer,
  classifySessionOutcome,
  attributeSessionCosts,
} from './cost-per-outcome.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeToolCall(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    toolName: 'Read',
    toolUseId: `tu-${Date.now()}`,
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    ...overrides,
  } as ToolCallRecord;
}

function makeTask(overrides?: Partial<AiCodingTask>): AiCodingTask {
  const toolCalls = overrides?.toolCalls ?? [makeToolCall()];
  return {
    taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    startTime: Date.now() - 60_000,
    endTime: Date.now(),
    durationMs: 60_000,
    toolCallCount: toolCalls.length,
    toolCallsByType: {},
    filesRead: [],
    filesModified: [],
    linesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    bashCommandsRun: 0,
    testsRun: 0,
    testsPassed: 0,
    buildRun: 0,
    buildPassed: 0,
    estimatedCostUsd: 0.05,
    tokensUsed: 5000,
    askedUserQuestions: 0,
    subAgentsSpawned: 0,
    toolCalls,
    ...overrides,
  };
}

describe('CostPerOutcomeAnalyzer', () => {
  // -------------------------------------------------------------------------
  // 1. bug_fix: test fail → edit → test pass
  // -------------------------------------------------------------------------

  it('classifies bug_fix when test fails then passes after edit', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/src/utils.ts'],
      testsRun: 2,
      testsPassed: 1,
      toolCalls: [
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: false,
        } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/src/utils.ts' } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: true,
        } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('bug_fix');
  });

  it('classifies bug_fix when Write (not Edit) is used to fix failing tests', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/src/utils.ts'],
      testsRun: 2,
      testsPassed: 1,
      toolCalls: [
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: false,
        } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Write', filePath: '/src/utils.ts' } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: true,
        } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('bug_fix');
  });

  it('classifies bug_fix for fail → edit → fail → edit → pass sequence', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/src/utils.ts'],
      toolCalls: [
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: false,
        } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/src/utils.ts' } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: false,
        } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/src/utils.ts' } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: true,
        } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('bug_fix');
  });

  // -------------------------------------------------------------------------
  // 2. feature: Write creating new files
  // -------------------------------------------------------------------------

  it('classifies feature when Write tool creates new files', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/src/new-feature.ts', '/src/new-feature.test.ts', '/src/types.ts'],
      toolCalls: [
        makeToolCall({
          toolName: 'Write',
          filePath: '/src/new-feature.ts',
        } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Write',
          filePath: '/src/new-feature.test.ts',
        } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Write', filePath: '/src/types.ts' } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('feature');
  });

  // -------------------------------------------------------------------------
  // 3. refactor: edits to existing files, all tests pass
  // -------------------------------------------------------------------------

  it('classifies refactor when existing files are edited without test regressions', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/src/utils.ts', '/src/helpers.ts'],
      testsRun: 3,
      testsPassed: 3,
      toolCalls: [
        makeToolCall({ toolName: 'Read', filePath: '/src/utils.ts' } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/src/utils.ts' } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/src/helpers.ts' } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: true,
        } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('refactor');
  });

  // -------------------------------------------------------------------------
  // 4. investigation: mostly Read/Grep/Glob calls
  // -------------------------------------------------------------------------

  it('classifies investigation when >80% of tool calls are read/search', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: [],
      toolCallCount: 10,
      toolCalls: [
        makeToolCall({ toolName: 'Read' }),
        makeToolCall({ toolName: 'Read' }),
        makeToolCall({ toolName: 'Grep' }),
        makeToolCall({ toolName: 'Grep' }),
        makeToolCall({ toolName: 'Glob' }),
        makeToolCall({ toolName: 'Read' }),
        makeToolCall({ toolName: 'Read' }),
        makeToolCall({ toolName: 'Grep' }),
        makeToolCall({ toolName: 'Read' }),
        makeToolCall({ toolName: 'Bash' }),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('investigation');
  });

  // -------------------------------------------------------------------------
  // 5. configuration: only config file edits
  // -------------------------------------------------------------------------

  it('classifies configuration when only config files are modified', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/config/app.yaml', '/package.json'],
      toolCalls: [
        makeToolCall({ toolName: 'Edit', filePath: '/config/app.yaml' } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/package.json' } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('configuration');
  });

  // -------------------------------------------------------------------------
  // 6. documentation: only .md file edits
  // -------------------------------------------------------------------------

  it('classifies documentation when only .md files are modified', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/README.md', '/docs/guide.md'],
      toolCalls: [
        makeToolCall({ toolName: 'Edit', filePath: '/README.md' } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/docs/guide.md' } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('documentation');
  });

  // -------------------------------------------------------------------------
  // 7. failed_attempt: tests failed and never passed
  // -------------------------------------------------------------------------

  it('classifies failed_attempt when tests fail and never recover', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const task = makeTask({
      filesModified: ['/src/broken.ts'],
      testsRun: 2,
      testsPassed: 0,
      toolCalls: [
        makeToolCall({ toolName: 'Edit', filePath: '/src/broken.ts' } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: false,
        } as Partial<ToolCallRecord>),
        makeToolCall({ toolName: 'Edit', filePath: '/src/broken.ts' } as Partial<ToolCallRecord>),
        makeToolCall({
          toolName: 'Bash',
          isTestCommand: true,
          success: false,
        } as Partial<ToolCallRecord>),
      ],
    });

    expect(analyzer.classifyOutcome(task)).toBe('failed_attempt');
  });

  // -------------------------------------------------------------------------
  // 8. attributeCosts: correct averages and wasteRatio
  // -------------------------------------------------------------------------

  it('attributeCosts computes correct averages and wasteRatio', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const tasks: AiCodingTask[] = [];

    // 3 bug_fix tasks @ $2 each
    for (let i = 0; i < 3; i++) {
      tasks.push(
        makeTask({
          estimatedCostUsd: 2,
          toolCalls: [
            makeToolCall({
              toolName: 'Bash',
              isTestCommand: true,
              success: false,
            } as Partial<ToolCallRecord>),
            makeToolCall({ toolName: 'Edit' }),
            makeToolCall({
              toolName: 'Bash',
              isTestCommand: true,
              success: true,
            } as Partial<ToolCallRecord>),
          ],
        }),
      );
    }

    // 4 feature tasks @ $5 each
    for (let i = 0; i < 4; i++) {
      tasks.push(
        makeTask({
          estimatedCostUsd: 5,
          toolCalls: [
            makeToolCall({
              toolName: 'Write',
              filePath: `/src/feat-${i}.ts`,
            } as Partial<ToolCallRecord>),
          ],
        }),
      );
    }

    // 3 failed_attempt tasks @ $3 each
    for (let i = 0; i < 3; i++) {
      tasks.push(
        makeTask({
          estimatedCostUsd: 3,
          toolCalls: [
            makeToolCall({
              toolName: 'Bash',
              isTestCommand: true,
              success: false,
            } as Partial<ToolCallRecord>),
          ],
        }),
      );
    }

    const attribution = analyzer.attributeCosts(tasks);

    expect(attribution.totalTasks).toBe(10);
    // Total: 3*2 + 4*5 + 3*3 = 6 + 20 + 9 = 35
    expect(attribution.totalCost).toBe(35);
    expect(attribution.costPerBugFix).toBe(2);
    expect(attribution.costPerFeature).toBe(5);
    expect(attribution.costPerFailedAttempt).toBe(3);
    // wasteRatio = 9/35 ≈ 0.2571
    expect(attribution.wasteRatio).toBeCloseTo(9 / 35, 3);
  });

  // -------------------------------------------------------------------------
  // 9. estimateROI: correct calculation
  // -------------------------------------------------------------------------

  it('estimateROI computes correct hours saved and ROI', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    // 5 bug fixes at $2 each = $10 total AI cost
    const tasks: AiCodingTask[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(
        makeTask({
          estimatedCostUsd: 2,
          toolCalls: [
            makeToolCall({
              toolName: 'Bash',
              isTestCommand: true,
              success: false,
            } as Partial<ToolCallRecord>),
            makeToolCall({ toolName: 'Edit' }),
            makeToolCall({
              toolName: 'Bash',
              isTestCommand: true,
              success: true,
            } as Partial<ToolCallRecord>),
          ],
        }),
      );
    }

    const attribution = analyzer.attributeCosts(tasks);
    // hourlyRate = $50
    const roi = analyzer.estimateROI(attribution, 50);

    // 5 bug fixes × 2 hours each = 10 hours saved
    expect(roi.estimatedHoursSaved).toBe(10);
    // 10 hours × $50/hr = $500 value
    expect(roi.estimatedValueUsd).toBe(500);
    // totalAiCost = 5 × $2 = $10
    expect(roi.totalAiCost).toBe(10);
    // ROI = $500 - $10 = $490
    expect(roi.roi).toBe(490);

    expect(roi.byOutcome['bug_fix']).toBeDefined();
    expect(roi.byOutcome['bug_fix']!.count).toBe(5);
    expect(roi.byOutcome['bug_fix']!.hoursSaved).toBe(10);
    expect(roi.byOutcome['bug_fix']!.valueUsd).toBe(500);
  });

  // -------------------------------------------------------------------------
  // 10. wasteRatio zero: no failed attempts
  // -------------------------------------------------------------------------

  it('wasteRatio is 0 when there are no failed attempts', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const tasks = [
      makeTask({
        estimatedCostUsd: 5,
        toolCalls: [
          makeToolCall({ toolName: 'Write', filePath: '/src/feat.ts' } as Partial<ToolCallRecord>),
        ],
      }),
      makeTask({
        estimatedCostUsd: 3,
        filesModified: ['/src/utils.ts'],
        toolCalls: [
          makeToolCall({ toolName: 'Edit', filePath: '/src/utils.ts' } as Partial<ToolCallRecord>),
        ],
      }),
    ];

    const attribution = analyzer.attributeCosts(tasks);

    expect(attribution.wasteRatio).toBe(0);
    expect(attribution.costPerFailedAttempt).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. outcomeDistribution: correct counts and sums
  // -------------------------------------------------------------------------

  it('outcomeDistribution correctly counts and sums per category', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const tasks = [
      // 2 features
      makeTask({
        estimatedCostUsd: 4,
        toolCalls: [
          makeToolCall({ toolName: 'Write', filePath: '/a.ts' } as Partial<ToolCallRecord>),
        ],
      }),
      makeTask({
        estimatedCostUsd: 6,
        toolCalls: [
          makeToolCall({ toolName: 'Write', filePath: '/b.ts' } as Partial<ToolCallRecord>),
        ],
      }),
      // 1 documentation
      makeTask({
        estimatedCostUsd: 1,
        filesModified: ['/README.md'],
        toolCalls: [
          makeToolCall({ toolName: 'Edit', filePath: '/README.md' } as Partial<ToolCallRecord>),
        ],
      }),
    ];

    const attribution = analyzer.attributeCosts(tasks);
    const dist = attribution.outcomeDistribution;

    expect(dist['feature']).toBeDefined();
    expect(dist['feature']!.count).toBe(2);
    expect(dist['feature']!.totalCost).toBe(10);
    expect(dist['feature']!.avgCost).toBe(5);

    expect(dist['documentation']).toBeDefined();
    expect(dist['documentation']!.count).toBe(1);
    expect(dist['documentation']!.totalCost).toBe(1);
    expect(dist['documentation']!.avgCost).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 12. emitMetrics: mock aggregator receives correct events
  // -------------------------------------------------------------------------

  it('emitMetrics emits ai.task.outcome and ai.cost_per_outcome events', () => {
    const analyzer = new CostPerOutcomeAnalyzer();

    const tasks = [
      makeTask({
        estimatedCostUsd: 3,
        toolCalls: [
          makeToolCall({
            toolName: 'Bash',
            isTestCommand: true,
            success: false,
          } as Partial<ToolCallRecord>),
          makeToolCall({ toolName: 'Edit' }),
          makeToolCall({
            toolName: 'Bash',
            isTestCommand: true,
            success: true,
          } as Partial<ToolCallRecord>),
        ],
      }),
      makeTask({
        estimatedCostUsd: 5,
        toolCalls: [
          makeToolCall({ toolName: 'Write', filePath: '/src/new.ts' } as Partial<ToolCallRecord>),
        ],
      }),
    ];

    const recorded: Array<{
      name: string;
      value: number;
      attrs?: Record<string, string | number>;
    }> = [];
    const aggregator = {
      record(name: string, value: number, attrs?: Record<string, string | number>) {
        recorded.push({ name, value, attrs });
      },
    } as unknown as MetricAggregator;

    analyzer.emitMetrics(aggregator, tasks, 'alice');

    // Should have 2 ai.task.outcome events (one per task)
    const outcomeEvents = recorded.filter((r) => r.name === 'ai.task.outcome');
    expect(outcomeEvents).toHaveLength(2);

    const bugFixEvent = outcomeEvents.find((r) => r.attrs?.outcome === 'bug_fix');
    expect(bugFixEvent).toBeDefined();
    expect(bugFixEvent!.attrs?.developer).toBe('alice');
    expect(bugFixEvent!.attrs?.costUsd).toBe(3);

    const featureEvent = outcomeEvents.find((r) => r.attrs?.outcome === 'feature');
    expect(featureEvent).toBeDefined();
    expect(featureEvent!.attrs?.developer).toBe('alice');
    expect(featureEvent!.attrs?.costUsd).toBe(5);

    // Should have 2 ai.cost_per_outcome events (one per category)
    const costEvents = recorded.filter((r) => r.name === 'ai.cost_per_outcome');
    expect(costEvents).toHaveLength(2);

    for (const evt of costEvents) {
      expect(evt.attrs?.developer).toBe('alice');
      expect(evt.attrs?.outcome).toBeTruthy();
    }
  });
});

describe('classifySessionOutcome', () => {
  it('returns failed_attempt when test command ran but did not pass (non-zero exit)', () => {
    // testRunCount/testPassCount track Bash test command runs, not individual test cases.
    // testRunCount > 0 && testPassCount === 0 means the test command exited non-zero.
    const r = classifySessionOutcome({
      testRunCount: 3,
      testPassCount: 0,
      filesModified: ['src/foo.ts'],
      toolBreakdown: { Edit: 1 },
      toolCallCount: 5,
    });
    expect(r).toBe('failed_attempt');
  });

  it('returns bug_fix when tests pass and files modified', () => {
    const r = classifySessionOutcome({
      testRunCount: 3,
      testPassCount: 2,
      filesModified: ['src/foo.ts'],
      toolBreakdown: { Edit: 2 },
      toolCallCount: 8,
    });
    expect(r).toBe('bug_fix');
  });

  it('returns feature when Write tool used', () => {
    const r = classifySessionOutcome({
      testRunCount: 0,
      testPassCount: 0,
      filesModified: ['src/new.ts'],
      toolBreakdown: { Write: 1, Edit: 1 },
      toolCallCount: 4,
    });
    expect(r).toBe('feature');
  });

  it('returns documentation when only .md modified', () => {
    const r = classifySessionOutcome({
      testRunCount: 0,
      testPassCount: 0,
      filesModified: ['README.md', 'docs/guide.md'],
      toolBreakdown: { Edit: 2 },
      toolCallCount: 3,
    });
    expect(r).toBe('documentation');
  });

  it('returns configuration when only config files modified', () => {
    const r = classifySessionOutcome({
      testRunCount: 0,
      testPassCount: 0,
      filesModified: ['package.json', '.eslintrc.yaml'],
      toolBreakdown: { Edit: 2 },
      toolCallCount: 3,
    });
    expect(r).toBe('configuration');
  });

  it('returns refactor when files modified, no tests, mixed extensions', () => {
    const r = classifySessionOutcome({
      testRunCount: 0,
      testPassCount: 0,
      filesModified: ['src/a.ts', 'README.md'],
      toolBreakdown: { Edit: 2 },
      toolCallCount: 4,
    });
    expect(r).toBe('refactor');
  });

  it('returns investigation when 80%+ read tools and no edits', () => {
    const r = classifySessionOutcome({
      testRunCount: 0,
      testPassCount: 0,
      filesModified: [],
      toolBreakdown: { Read: 8, Grep: 2 },
      toolCallCount: 10,
    });
    expect(r).toBe('investigation');
  });

  it('returns feature as default when nothing else fits', () => {
    const r = classifySessionOutcome({
      testRunCount: 0,
      testPassCount: 0,
      filesModified: [],
      toolBreakdown: { Bash: 1 },
      toolCallCount: 1,
    });
    expect(r).toBe('feature');
  });
});

describe('attributeSessionCosts', () => {
  it('aggregates session costs by classified outcome', () => {
    const sessions = [
      {
        testRunCount: 2,
        testPassCount: 0,
        filesModified: ['src/a.ts'],
        toolBreakdown: { Edit: 1 },
        toolCallCount: 5,
        estimatedCostUsd: 0.5,
      },
      {
        testRunCount: 3,
        testPassCount: 2,
        filesModified: ['src/b.ts'],
        toolBreakdown: { Edit: 2 },
        toolCallCount: 8,
        estimatedCostUsd: 1.0,
      },
      {
        testRunCount: 0,
        testPassCount: 0,
        filesModified: ['README.md'],
        toolBreakdown: { Edit: 1 },
        toolCallCount: 3,
        estimatedCostUsd: 0.2,
      },
    ];
    const result = attributeSessionCosts(sessions);
    expect(result.totalTasks).toBe(3);
    expect(result.outcomeDistribution.failed_attempt.count).toBe(1);
    expect(result.outcomeDistribution.bug_fix.count).toBe(1);
    expect(result.outcomeDistribution.documentation.count).toBe(1);
    expect(result.totalCost).toBeCloseTo(1.7, 4);
    // wasteRatio = 0.5 / 1.7 ≈ 0.2941
    expect(result.wasteRatio).toBeCloseTo(0.2941, 3);
  });

  it('does not count sessions with no tool calls and no cost as feature work', () => {
    const idle = {
      testRunCount: 0,
      testPassCount: 0,
      filesModified: [] as string[],
      toolBreakdown: {},
      toolCallCount: 0,
      estimatedCostUsd: 0,
    };
    const result = attributeSessionCosts([
      idle,
      idle,
      {
        ...idle,
        filesModified: ['src/x.ts'],
        toolBreakdown: { Write: 1 },
        toolCallCount: 1,
        estimatedCostUsd: 0.1,
      },
    ]);
    expect(result.totalTasks).toBe(1);
    expect(result.outcomeDistribution.feature.count).toBe(1);
  });

  it('handles null estimatedCostUsd as zero', () => {
    const result = attributeSessionCosts([
      {
        testRunCount: 0,
        testPassCount: 0,
        filesModified: ['src/x.ts'],
        toolBreakdown: { Write: 1 },
        toolCallCount: 1,
        estimatedCostUsd: null,
      },
    ]);
    expect(result.totalCost).toBe(0);
    expect(result.outcomeDistribution.feature.count).toBe(1);
    expect(result.outcomeDistribution.feature.totalCost).toBe(0);
  });
});
