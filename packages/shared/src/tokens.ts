export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

function safeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

const EMPTY_USAGE: Readonly<TokenUsage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
});

// ---------------------------------------------------------------------------
// Anthropic extraction
// ---------------------------------------------------------------------------

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  usage?: AnthropicUsage;
  content?: { type?: string }[];
}

export function extractAnthropicTokens(response: AnthropicResponse): TokenUsage {
  if (!response.usage) return { ...EMPTY_USAGE };

  const usage = response.usage;
  const inputTokens = safeInt(usage.input_tokens);
  const outputTokens = safeInt(usage.output_tokens);
  const cacheReadTokens = safeInt(usage.cache_read_input_tokens);
  const cacheCreationTokens = safeInt(usage.cache_creation_input_tokens);
  // Anthropic does not expose a separate thinking token count in the usage
  // object; thinking output is included in output_tokens. If a future SDK
  // version adds a dedicated field, extract it here.
  const thinkingTokens = 0;

  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheCreationTokens,
  };
}

// ---------------------------------------------------------------------------
// Gemini extraction
// ---------------------------------------------------------------------------

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  usageMetadata?: GeminiUsageMetadata;
}

export function extractGeminiTokens(response: GeminiResponse): TokenUsage {
  if (!response.usageMetadata) return { ...EMPTY_USAGE };

  const meta = response.usageMetadata;
  const inputTokens = safeInt(meta.promptTokenCount);
  const outputTokens = safeInt(meta.candidatesTokenCount);
  const thinkingTokens = safeInt(meta.thoughtsTokenCount);
  const cacheReadTokens = safeInt(meta.cachedContentTokenCount);

  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens: 0, // Gemini does not expose cache creation tokens
    totalTokens:
      meta.totalTokenCount !== undefined
        ? safeInt(meta.totalTokenCount)
        : inputTokens + outputTokens + thinkingTokens + cacheReadTokens,
  };
}

// ---------------------------------------------------------------------------
// Unified stream extraction
// ---------------------------------------------------------------------------

export type AiProvider = 'anthropic' | 'google' | 'openai';

export function extractStreamTokens(
  finalChunk: AnthropicResponse | GeminiResponse,
  provider: AiProvider,
): TokenUsage {
  if (provider === 'anthropic') {
    return extractAnthropicTokens(finalChunk as AnthropicResponse);
  }
  return extractGeminiTokens(finalChunk as GeminiResponse);
}

// ---------------------------------------------------------------------------
// TokenAccumulator — streaming token tracker
// ---------------------------------------------------------------------------

interface AnthropicStreamEvent {
  type?: string;
  message?: AnthropicResponse;
  usage?: { output_tokens?: number };
  delta?: { stop_reason?: string };
}

interface GeminiStreamChunk {
  usageMetadata?: GeminiUsageMetadata;
}

export class TokenAccumulator {
  private provider: AiProvider;
  private latestUsage: TokenUsage = { ...EMPTY_USAGE };
  private finalized = false;

  constructor(provider: AiProvider) {
    this.provider = provider;
  }

  addChunk(chunk: unknown): void {
    if (this.finalized) return;

    if (this.provider === 'anthropic') {
      this.addAnthropicChunk(chunk as AnthropicStreamEvent);
    } else {
      this.addGeminiChunk(chunk as GeminiStreamChunk);
    }
  }

  finalize(): TokenUsage {
    this.finalized = true;
    return { ...this.latestUsage };
  }

  private addAnthropicChunk(event: AnthropicStreamEvent): void {
    // message_start carries the initial usage with input token counts
    if (event.type === 'message_start' && event.message?.usage) {
      const usage = event.message.usage;
      this.latestUsage.inputTokens = safeInt(usage.input_tokens);
      this.latestUsage.cacheReadTokens = safeInt(usage.cache_read_input_tokens);
      this.latestUsage.cacheCreationTokens = safeInt(usage.cache_creation_input_tokens);
    }

    // message_delta carries the final output token count
    if (event.type === 'message_delta' && event.usage) {
      this.latestUsage.outputTokens = safeInt(event.usage.output_tokens);
    }

    this.latestUsage.totalTokens =
      this.latestUsage.inputTokens +
      this.latestUsage.outputTokens +
      this.latestUsage.thinkingTokens +
      this.latestUsage.cacheReadTokens +
      this.latestUsage.cacheCreationTokens;
  }

  private addGeminiChunk(chunk: GeminiStreamChunk): void {
    // Each Gemini chunk may carry usageMetadata; the last one is authoritative
    if (chunk.usageMetadata) {
      const meta = chunk.usageMetadata;
      this.latestUsage.inputTokens = safeInt(meta.promptTokenCount);
      this.latestUsage.outputTokens = safeInt(meta.candidatesTokenCount);
      this.latestUsage.thinkingTokens = safeInt(meta.thoughtsTokenCount);
      this.latestUsage.cacheReadTokens = safeInt(meta.cachedContentTokenCount);
      this.latestUsage.totalTokens =
        meta.totalTokenCount !== undefined
          ? safeInt(meta.totalTokenCount)
          : this.latestUsage.inputTokens +
            this.latestUsage.outputTokens +
            this.latestUsage.thinkingTokens +
            this.latestUsage.cacheReadTokens +
            this.latestUsage.cacheCreationTokens;
    }
  }
}
