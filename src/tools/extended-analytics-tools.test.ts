import { RetryDetector } from '../metrics/retry-detector.js';
import { ContextCompositionTracker } from '../metrics/context-composition-tracker.js';
import { LatencyDecompositionTracker } from '../metrics/latency-decomposition.js';
import { DecisionTracker } from '../metrics/decision-tracker.js';
import { InstructionDriftTracker } from '../metrics/instruction-drift-tracker.js';
import { ToolSelectionScorer } from '../metrics/tool-selection-scorer.js';
import { QualityProxyTracker } from '../metrics/quality-proxy-tracker.js';
import { ApiFailureTracker } from '../metrics/api-failure-tracker.js';
import {
  handleGetRetryAlerts,
  handleGetContextComposition,
  handleGetLatencyDecomposition,
  handleGetDecisionTree,
  handleGetInstructionDrift,
  handleGetToolSelectionScore,
  handleGetQualityProxy,
  handleGetApiFailures,
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
      "reasoning fields above are rule-based labels (e.g. 'recovery after X failure', 'retrying Y on Z'), not extracted model chain-of-thought -- recordToolCall() has no access to actual reasoning text. Branches are only recorded on 3 narrow triggers (failure recovery, AskUserQuestion, 3rd+ same-tool-same-file retry), not on every turn, so totalBranches undercounts ordinary turns.",
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
