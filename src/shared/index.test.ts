import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VERSION,
  EVENT_SCHEMA_VERSION,
  createLogger,
  redact,
  safeForLog,
  loadConfig,
  createAiRequest,
  createAiResponse,
  createAiMessage,
  createAiAgentTaskSummary,
  createAiAntiPattern,
  createAiAgentMessage,
  createAiContextReset,
  aiRequestToNrEvent,
  aiResponseToNrEvent,
  aiMessageToNrEvent,
  aiAgentTaskSummaryToNrEvent,
  aiAntiPatternToNrEvent,
  aiAgentMessageToNrEvent,
  aiContextResetToNrEvent,
  extractAnthropicTokens,
  extractGeminiTokens,
  extractOpenAITokens,
  extractBedrockTokens,
  extractMistralTokens,
  extractCohereTokens,
  extractStreamTokens,
  safeInt,
  TokenAccumulator,
  calculateCost,
  resolveModelPricing,
  initPricing,
  loadCustomPricing,
  PricingTable,
  DEFAULT_PRICING_TABLE,
  RequestTimer,
  sendEvents,
  sendMetrics,
  sendLogs,
  OtlpTransport,
  OtlpEventBridge,
  EventBuffer,
  MetricAggregator,
  HarvestScheduler,
  snapshotsToNrMetrics,
  AiErrorClassification,
  classifyError,
  classifyErrorDetailed,
  isRetryable,
  RETRYABLE,
  extractRateLimitHeaders,
  truncateErrorMessage,
} from './index.js';

// Read version from package.json so the assertion stays correct across bumps.
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string;
};

describe('shared package', () => {
  it('exports VERSION matching package.json (§IN2)', () => {
    expect(VERSION).toBe(pkg.version);
  });

  // CODE_REVIEW §6.10 — EVENT_SCHEMA_VERSION must be importable from the
  // package root so consumers can `import { EVENT_SCHEMA_VERSION } from
  // '@newrelic/ai-telemetry'` per the documented public API.
  it('exports EVENT_SCHEMA_VERSION from the package root (§6.10)', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('all top-level value exports are defined (§IN4)', () => {
    // Verifies that no symbol was accidentally removed from the re-export chain.
    // Type-only exports are checked by the TypeScript build.
    const symbols = [
      createLogger,
      redact,
      safeForLog,
      loadConfig,
      createAiRequest,
      createAiResponse,
      createAiMessage,
      createAiAgentTaskSummary,
      createAiAntiPattern,
      createAiAgentMessage,
      createAiContextReset,
      aiRequestToNrEvent,
      aiResponseToNrEvent,
      aiMessageToNrEvent,
      aiAgentTaskSummaryToNrEvent,
      aiAntiPatternToNrEvent,
      aiAgentMessageToNrEvent,
      aiContextResetToNrEvent,
      extractAnthropicTokens,
      extractGeminiTokens,
      extractOpenAITokens,
      extractBedrockTokens,
      extractMistralTokens,
      extractCohereTokens,
      extractStreamTokens,
      safeInt,
      TokenAccumulator,
      calculateCost,
      resolveModelPricing,
      initPricing,
      loadCustomPricing,
      PricingTable,
      DEFAULT_PRICING_TABLE,
      RequestTimer,
      sendEvents,
      sendMetrics,
      sendLogs,
      OtlpTransport,
      OtlpEventBridge,
      EventBuffer,
      MetricAggregator,
      HarvestScheduler,
      snapshotsToNrMetrics,
      AiErrorClassification,
      classifyError,
      classifyErrorDetailed,
      isRetryable,
      RETRYABLE,
      extractRateLimitHeaders,
      truncateErrorMessage,
    ];
    for (const sym of symbols) {
      expect(sym).toBeDefined();
    }
  });
});
