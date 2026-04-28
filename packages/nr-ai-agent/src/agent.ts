import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenAI } from '@google/genai';
import type OpenAI from 'openai';
import {
  loadConfig,
  createLogger,
  initPricing,
  HarvestScheduler,
  sendEvents,
  sendMetrics,
  createAiRequest,
  createAiResponse,
  aiRequestToNrEvent,
  aiResponseToNrEvent,
} from '@nr-ai-observatory/shared';
import type { AgentConfig } from '@nr-ai-observatory/shared';
import { wrapAnthropicClient as wrapAnthropic } from './wrappers/anthropic.js';
import { wrapGeminiClient as wrapGemini } from './wrappers/gemini.js';
import { wrapOpenAiClient as wrapOpenAI } from './wrappers/openai.js';
import type {
  WrapperConfig,
  RecordHandler,
  EmbeddingRecordHandler,
  AiRequestRecord,
  AiEmbeddingRecord,
} from './types.js';

const logger = createLogger('agent');

const DEFAULT_REDACTION_PATTERNS: readonly RegExp[] = [
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)\b[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g,
  /-----BEGIN[\s\S]{0,65536}?-----END[^\n]{0,256}-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIzaSy[0-9A-Za-z_-]{33}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[a-z]-[0-9A-Za-z-]+/g,
];

export interface AgentStats {
  enabled: boolean;
  eventsBuffered: number;
  eventsSent: number;
  eventsDropped: number;
  uptimeMs: number;
}

let initPromise: Promise<NrAiAgent> | null = null;

export async function init(options?: Partial<AgentConfig>): Promise<NrAiAgent> {
  if (!initPromise) {
    const p = Promise.resolve().then(() => {
      const config = loadConfig(options);
      return new NrAiAgent(config);
    });
    // Reset on failure so callers can retry after a config error
    p.catch(() => {
      if (initPromise === p) initPromise = null;
    });
    initPromise = p;
  }
  return initPromise;
}

export class NrAiAgent {
  private readonly config: Readonly<AgentConfig>;
  private readonly scheduler: HarvestScheduler | null;
  private readonly wrapperConfig: WrapperConfig;
  private readonly startedAt: number;

  constructor(config: Readonly<AgentConfig>) {
    this.config = config;
    this.startedAt = Date.now();

    this.wrapperConfig = {
      enabled: config.enabled,
      recordContent: config.recordContent,
      highSecurity: config.highSecurity,
      contentMaxLength: config.contentMaxLength,
      redactionPatterns: DEFAULT_REDACTION_PATTERNS,
    };

    if (!config.enabled) {
      this.scheduler = null;
      logger.info('Agent initialized in no-op mode (enabled=false)');
      return;
    }

    if (!config.accountId) {
      throw new Error(
        'Missing required configuration: NEW_RELIC_ACCOUNT_ID. ' +
          'Set the NEW_RELIC_ACCOUNT_ID environment variable or pass accountId in options.',
      );
    }

    initPricing(config.customPricingFile);

    this.scheduler = new HarvestScheduler({
      licenseKey: config.licenseKey,
      transportOptions: {
        accountId: config.accountId,
        collectorHost: config.collectorHost,
      },
      sendEventsFn: sendEvents,
      sendMetricsFn: sendMetrics,
    });

    this.scheduler.start();
    logger.info('Agent initialized', { appName: config.appName });
  }

  wrapAnthropicClient(client: Anthropic): Anthropic {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    return wrapAnthropic(client, this.wrapperConfig, onRecord);
  }

  wrapOpenAiClient(client: OpenAI): OpenAI {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    return wrapOpenAI(client, this.wrapperConfig, onRecord);
  }

  wrapGeminiClient(client: GoogleGenAI): GoogleGenAI {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    const onEmbeddingRecord: EmbeddingRecordHandler = (record) => {
      this.ingestEmbeddingRecord(record);
    };

    return wrapGemini(client, this.wrapperConfig, onRecord, onEmbeddingRecord);
  }

  async shutdown(): Promise<void> {
    if (this.scheduler) {
      await this.scheduler.stop();
    }
    initPromise = null;
    logger.info('Agent shut down');
  }

  getStats(): AgentStats {
    return {
      enabled: this.config.enabled,
      eventsBuffered: 0,
      eventsSent: 0,
      eventsDropped: 0,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  private ingestRequestRecord(record: AiRequestRecord): void {
    if (!this.scheduler) return;

    const appName = this.config.appName;

    const request = createAiRequest({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.requestModel,
      requestMethod: resolveRequestMethod(record),
      maxTokens: record.maxTokens,
      temperature: record.temperature,
      topP: record.topP,
      systemPromptLength: record.systemPromptLength,
      messageCount: record.messageCount,
      toolCount: record.toolCount,
      toolNames: record.toolNames,
      thinkingEnabled: record.thinkingEnabled,
      thinkingBudgetTokens: record.thinkingBudgetTokens,
      streamingEnabled: record.streaming,
      appName,
    });

    const response = createAiResponse({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.model,
      durationMs: record.durationMs,
      timeToFirstTokenMs: record.timeToFirstTokenMs,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      thinkingTokens: record.thinkingTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      stopReason: record.stopReason,
      contentBlockTypes: record.contentBlockTypes,
      error: record.error,
      appName,
    });

    this.scheduler.addEvent(aiRequestToNrEvent(request));
    this.scheduler.addEvent(aiResponseToNrEvent(response));

    this.scheduler.recordMetric('ai.request.duration', record.durationMs, {
      provider: record.provider,
      model: record.model,
    });

    if (record.totalTokens > 0) {
      this.scheduler.recordMetric('ai.tokens.total', record.totalTokens, {
        provider: record.provider,
        model: record.model,
      });
    }

    if (record.error) {
      this.scheduler.recordMetric('ai.error', 1, {
        provider: record.provider,
        model: record.model,
        errorType: record.error.type,
      });
    }
  }

  private ingestEmbeddingRecord(record: AiEmbeddingRecord): void {
    if (!this.scheduler) return;

    const appName = this.config.appName;

    const request = createAiRequest({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.requestModel,
      requestMethod: 'models.embedContent',
      messageCount: 1,
      streamingEnabled: false,
      appName,
    });

    const response = createAiResponse({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.model || record.requestModel,
      durationMs: record.durationMs,
      inputTokens: record.inputTokens,
      outputTokens: 0,
      error: record.error,
      appName,
    });

    this.scheduler.addEvent(aiRequestToNrEvent(request));
    this.scheduler.addEvent(aiResponseToNrEvent(response));

    this.scheduler.recordMetric('ai.embedding.duration', record.durationMs, {
      provider: record.provider,
      model: record.requestModel,
    });
  }
}

function resolveRequestMethod(
  record: AiRequestRecord,
): 'messages.create' | 'messages.stream' | 'models.generateContent' | 'models.generateContentStream' | 'chat.completions.create' {
  if (record.provider === 'anthropic') {
    return record.streaming ? 'messages.stream' : 'messages.create';
  }
  if (record.provider === 'openai') {
    return 'chat.completions.create';
  }
  return record.streaming ? 'models.generateContentStream' : 'models.generateContent';
}
