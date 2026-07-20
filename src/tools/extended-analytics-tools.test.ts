import { RetryDetector } from '../metrics/retry-detector.js';
import { ContextCompositionTracker } from '../metrics/context-composition-tracker.js';
import { LatencyDecompositionTracker } from '../metrics/latency-decomposition.js';
import { DecisionTracker } from '../metrics/decision-tracker.js';
import { InstructionDriftTracker } from '../metrics/instruction-drift-tracker.js';
import { ToolSelectionScorer } from '../metrics/tool-selection-scorer.js';
import { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import { ApiFailureTracker } from '../metrics/api-failure-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import {
  handleGetRetryAlerts,
  handleGetContextComposition,
  handleGetLatencyDecomposition,
  handleGetDecisionTree,
  handleGetInstructionDrift,
  handleGetToolSelectionScore,
  handleGetQualityProxy,
  handleGetApiFailures,
  registerExtendedAnalyticsTools,
} from './extended-analytics-tools.js';

jest.spyOn(console, 'error').mockImplementation(() => undefined);

describe('extended-analytics-tools handlers', () => {
  it('handleGetRetryAlerts returns metrics JSON', () => {
    const detector = new RetryDetector();
    const result = handleGetRetryAlerts(detector);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.alerts).toEqual([]);
    expect(parsed.totalAlertsEmitted).toBe(0);
  });

  it('handleGetContextComposition returns metrics JSON', () => {
    const tracker = new ContextCompositionTracker();
    const result = handleGetContextComposition(tracker);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.turnCount).toBe(0);
    expect(parsed.currentFillPercent).toBe(0);
    expect(parsed.note).toBe(
      "system_prompt and injected_file_content are always 0 in currentBreakdown/history -- the model API's usage response only reports aggregate input/cache-read/cache-creation token counts, with no breakdown by content category, so these two categories can't be separated from conversation_history/tool_results. fillPercent and dominanceAlerts are unaffected and reflect real totals.",
    );
  });

  it('handleGetLatencyDecomposition returns metrics JSON', () => {
    const tracker = new LatencyDecompositionTracker();
    const result = handleGetLatencyDecomposition(tracker);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.turnCount).toBe(0);
    expect(parsed.llmApi).toBeNull();
  });

  it('handleGetDecisionTree returns metrics and supports post-mortem mode', () => {
    const tracker = new DecisionTracker();
    tracker.recordDecision({
      turnNumber: 1,
      reasoning: 'test reasoning',
      chosenAction: 'read file',
      toolName: 'Read',
    });
    tracker.recordOutcome(1, false);

    const metricsResult = handleGetDecisionTree(tracker, false);
    const metrics = JSON.parse(metricsResult.content[0].text);
    expect(metrics.totalBranches).toBe(1);
    expect(metrics.longestFailureStreak).toBe(1);
    expect(metrics.note).toBe(
      "reasoning fields are the model's own thinking/text output for that turn when NEW_RELIC_AI_MCP_RECORD_CONTENT is enabled and the underlying model exposes plaintext reasoning -- some models/transports return only an encrypted thinking signature with no plaintext, in which case this falls back to a rule-based label (e.g. 'recovery after X failure'). Branches are only recorded on 3 narrow triggers (failure recovery, AskUserQuestion, 3rd+ same-tool-same-file retry), not on every turn, so totalBranches undercounts ordinary turns.",
    );

    const pmResult = handleGetDecisionTree(tracker, true);
    const pm = JSON.parse(pmResult.content[0].text);
    expect(pm.postMortem).toHaveLength(1);
    expect(pm.note).toBe(metrics.note);
  });

  it('handleGetInstructionDrift returns metrics JSON', () => {
    const tracker = new InstructionDriftTracker();
    const result = handleGetInstructionDrift(tracker);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.currentPromptHash).toBeNull();
    expect(parsed.uniquePromptVariants).toBe(0);
  });

  it('handleGetToolSelectionScore returns score JSON', () => {
    const scorer = new ToolSelectionScorer();
    const result = handleGetToolSelectionScore(scorer, []);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.score).toBe(1);
    expect(parsed.totalCalls).toBe(0);
  });

  it('handleGetQualityProxy returns metrics JSON', () => {
    const tracker = new QualityProxyTracker();
    const result = handleGetQualityProxy(tracker);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalSignals).toBe(0);
    expect(parsed.degradationDetected).toBe(false);
  });

  it('handleGetApiFailures returns metrics JSON', () => {
    const tracker = new ApiFailureTracker();
    const result = handleGetApiFailures(tracker);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalFailures).toBe(0);
    expect(parsed.totalTokensLost).toBe(0);
  });
});

describe('registerExtendedAnalyticsTools()', () => {
  it('lists no tools and returns explanatory errors when no deps are provided', async () => {
    const { tools, handlers } = registerExtendedAnalyticsTools({});
    expect(tools).toEqual([]);
    expect(Object.keys(handlers).sort()).toEqual([
      'nr_observe_get_api_failures',
      'nr_observe_get_context_composition',
      'nr_observe_get_decision_tree',
      'nr_observe_get_instruction_drift',
      'nr_observe_get_latency_decomposition',
      'nr_observe_get_quality_proxy',
      'nr_observe_get_retry_alerts',
      'nr_observe_get_tool_selection_score',
    ]);
    const result = await handlers.nr_observe_get_retry_alerts!(undefined);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: 'RetryDetector not available',
    });
  });

  it('requires both ToolSelectionScorer and toolCallBuffer for nr_observe_get_tool_selection_score', async () => {
    const { tools, handlers } = registerExtendedAnalyticsTools({
      toolSelectionScorer: new ToolSelectionScorer(),
    });
    expect(tools.map((t: { name: string }) => t.name)).not.toContain(
      'nr_observe_get_tool_selection_score',
    );
    const result = await handlers.nr_observe_get_tool_selection_score!(undefined);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: 'ToolSelectionScorer or toolCallBuffer not available',
    });
  });

  it('nr_observe_get_latency_decomposition stays unlisted today (index.ts never wires a real tracker) and explains why when dispatched directly', async () => {
    const { tools, handlers } = registerExtendedAnalyticsTools({});
    expect(tools.map((t: { name: string }) => t.name)).not.toContain(
      'nr_observe_get_latency_decomposition',
    );
    const result = await handlers.nr_observe_get_latency_decomposition!(undefined);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.error).toBe('nr_observe_get_latency_decomposition is not currently functional');
    expect(body.note).toContain('This tool is intentionally not registered in tools/list.');
  });

  it('would list nr_observe_get_latency_decomposition and dispatch to the real handler if a tracker were ever wired up', async () => {
    // Availability tracks the real dependency (not a hardcoded `false`) so
    // this reactivates automatically if `index.ts` ever stops hardcoding the
    // tracker to `undefined` — see the comment above the ToolSpec.
    const { tools, handlers } = registerExtendedAnalyticsTools({
      latencyDecompositionTracker: new LatencyDecompositionTracker(),
    });
    expect(tools.map((t: { name: string }) => t.name)).toContain(
      'nr_observe_get_latency_decomposition',
    );
    const result = await handlers.nr_observe_get_latency_decomposition!(undefined);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).turnCount).toBe(0);
  });

  it('lists every other tool once its backing tracker is present', () => {
    const toolCallBuffer = { getRecords: (): readonly ToolCallRecord[] => [] };
    const { tools } = registerExtendedAnalyticsTools({
      retryDetector: new RetryDetector(),
      contextCompositionTracker: new ContextCompositionTracker(),
      decisionTracker: new DecisionTracker(),
      instructionDriftTracker: new InstructionDriftTracker(),
      toolSelectionScorer: new ToolSelectionScorer(),
      toolCallBuffer,
      qualityProxyTracker: new QualityProxyTracker(),
      apiFailureTracker: new ApiFailureTracker(),
    });
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'nr_observe_get_api_failures',
      'nr_observe_get_context_composition',
      'nr_observe_get_decision_tree',
      'nr_observe_get_instruction_drift',
      'nr_observe_get_quality_proxy',
      'nr_observe_get_retry_alerts',
      'nr_observe_get_tool_selection_score',
    ]);
  });
});
