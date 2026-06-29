import { createLogger } from './logger.js';
import type { AiProvider } from './events/types.js';

export type { AiProvider };

const tokenLogger = createLogger('tokens');

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
}

// Internal mutable snapshot — TokenAccumulator mutates fields in-place across
// stream chunks. TokenUsage is readonly for callers; this type is the same
// shape without readonly so field assignments compile (mirrors Bucket in
// metric-aggregator.ts). MutableTokenUsage is assignable to TokenUsage for
// the public finalize() return.
type MutableTokenUsage = { -readonly [K in keyof TokenUsage]: TokenUsage[K] };

/**
 * Coerce a value to a non-negative integer. Returns 0 if the value is not a
 * finite non-negative number. Useful for tolerating provider responses with
 * missing, null, undefined, NaN, Infinity, negative, or float token counts.
 *
 * Floors fractional values (e.g. `safeInt(10.7) === 10`). When truncation
 * actually drops a fractional part, emits a debug-level log so operators can
 * diagnose buggy provider stubs that return non-integer token counts.
 * The log is debug, not warn — token counts are
 * provider-controlled and a single fractional value is not a library bug.
 */
export function safeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const floored = Math.floor(value);
    if (floored !== value) {
      tokenLogger.debug('safeInt truncated fractional value', { value, floored });
    }
    return floored;
  }
  return 0;
}

/**
 * Frozen zero-valued `TokenUsage` template. Use `{ ...EMPTY_USAGE }` (a
 * spread copy) when constructing a fresh mutable accumulator — the spread
 * is intentional: `TokenAccumulator` mutates `latestUsage` in place across
 * stream chunks. The frozen master is shared across
 * call sites so a misuse like `(EMPTY_USAGE as TokenUsage).inputTokens = 5`
 * throws in strict mode rather than silently corrupting future returns.
 */
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
  // Future-proofing: Anthropic currently folds extended-thinking output into
  // output_tokens. If a future SDK exposes a dedicated thinking_tokens field
  // we'll pick it up automatically rather than silently dropping it.
  thinking_tokens?: number;
}

export interface AnthropicResponse {
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
  // Anthropic currently folds thinking into output_tokens. If a future SDK
  // exposes a dedicated thinking_tokens field, pick it up automatically.
  // safeInt(undefined) === 0 preserves current behavior when absent.
  const thinkingTokens = safeInt(usage.thinking_tokens);

  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens:
      inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheCreationTokens,
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

export interface GeminiResponse {
  usageMetadata?: GeminiUsageMetadata;
}

export function extractGeminiTokens(response: GeminiResponse): TokenUsage {
  if (!response.usageMetadata) return { ...EMPTY_USAGE };

  const meta = response.usageMetadata;
  const inputTokens = safeInt(meta.promptTokenCount);
  const outputTokens = safeInt(meta.candidatesTokenCount);
  const thinkingTokens = safeInt(meta.thoughtsTokenCount);
  const cacheReadTokens = safeInt(meta.cachedContentTokenCount);

  let totalTokens: number;
  if (meta.totalTokenCount !== undefined) {
    const apiTotal = safeInt(meta.totalTokenCount);
    // Gemini's totalTokenCount is authoritative per
    // the API spec and may legitimately diverge from the component sum
    // (e.g. billable-vs-counted distinctions, deduplication). Use the API
    // value, but emit a debug log on divergence so operators can spot drift
    // if the API ever stops reporting totals consistently.
    const componentSum = inputTokens + outputTokens + thinkingTokens + cacheReadTokens;
    if (apiTotal !== componentSum) {
      tokenLogger.debug('Gemini totalTokenCount differs from component sum', {
        apiTotal,
        componentSum,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheReadTokens,
      });
    }
    totalTokens = apiTotal;
  } else {
    totalTokens = inputTokens + outputTokens + thinkingTokens + cacheReadTokens;
  }

  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens: 0, // Gemini does not expose cache creation tokens
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// OpenAI extraction
// ---------------------------------------------------------------------------

interface OpenAIPromptTokensDetails {
  cached_tokens?: number;
}

interface OpenAICompletionTokensDetails {
  reasoning_tokens?: number;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: OpenAIPromptTokensDetails;
  completion_tokens_details?: OpenAICompletionTokensDetails;
}

export interface OpenAIResponse {
  usage?: OpenAIUsage;
}

/**
 * Extract `TokenUsage` from an OpenAI Chat Completions response (or the final
 * stream chunk when `stream_options: { include_usage: true }` is set — the
 * shape is identical).
 *
 * Mapping:
 *   - `prompt_tokens` → `inputTokens`
 *   - `completion_tokens` → `outputTokens`
 *   - `prompt_tokens_details.cached_tokens` → `cacheReadTokens`
 *   - `completion_tokens_details.reasoning_tokens` → `thinkingTokens`
 *
 * `total_tokens` (if present) is authoritative and used as `totalTokens`,
 * matching the Gemini extractor's behavior. OpenAI does not expose
 * cache-creation tokens — they're set to 0.
 */
export function extractOpenAITokens(response: OpenAIResponse): TokenUsage {
  if (!response.usage) return { ...EMPTY_USAGE };

  const usage = response.usage;
  const inputTokens = safeInt(usage.prompt_tokens);
  const outputTokens = safeInt(usage.completion_tokens);
  const cacheReadTokens = safeInt(usage.prompt_tokens_details?.cached_tokens);
  const thinkingTokens = safeInt(usage.completion_tokens_details?.reasoning_tokens);

  let totalTokens: number;
  if (usage.total_tokens !== undefined) {
    totalTokens = safeInt(usage.total_tokens);
  } else {
    // For OpenAI, cacheReadTokens (prompt_tokens_details.cached_tokens)
    // is a SUBSET of inputTokens (prompt_tokens), not an additive field.
    // thinkingTokens (reasoning_tokens) is a SUBSET of outputTokens (completion_tokens).
    // Including either again would double-count when total_tokens is absent.
    totalTokens = inputTokens + outputTokens;
  }

  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Cohere extraction
//
// Targets Cohere's v2 Chat API. The usage object exposes counts under both
// `tokens` (actual counts — what we want for token-rate cost calculation)
// and `billed_units` (counts after Cohere's billing tier adjustments). We
// prefer `tokens` and fall back to `billed_units` when `tokens` is absent.
// Cohere does not expose cache or reasoning fields today.
// ---------------------------------------------------------------------------

interface CohereTokenCounts {
  input_tokens?: number;
  output_tokens?: number;
}

interface CohereUsage {
  tokens?: CohereTokenCounts;
  billed_units?: CohereTokenCounts;
}

export interface CohereResponse {
  usage?: CohereUsage;
  // Embed (`client.embed`) responses surface counts under `meta` rather
  // than `usage`. Same `tokens` / `billed_units` shape inside.
  meta?: CohereUsage;
}

export function extractCohereTokens(response: CohereResponse): TokenUsage {
  const usage = response.usage ?? response.meta;
  if (!usage) return { ...EMPTY_USAGE };

  // Prefer the `tokens` block (actual counts). Fall back to `billed_units`
  // when `tokens` is missing — Cohere has historically populated both, but
  // older / less-common endpoints may surface only one.
  const counts = usage.tokens ?? usage.billed_units ?? {};
  const inputTokens = safeInt(counts.input_tokens);
  const outputTokens = safeInt(counts.output_tokens);

  return {
    inputTokens,
    outputTokens,
    thinkingTokens: 0, // Cohere does not expose reasoning tokens
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Mistral extraction
//
// Mistral La Plateforme's Chat Completions API uses an OpenAI-compatible
// usage shape (`prompt_tokens` / `completion_tokens` / `total_tokens`). The
// type alias below documents the equivalence so a future Mistral-specific
// extension (e.g. cache fields if Mistral adds them) has a place to land
// without conflating with OpenAI's shape.
// ---------------------------------------------------------------------------

interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface MistralResponse {
  usage?: MistralUsage;
}

export function extractMistralTokens(response: MistralResponse): TokenUsage {
  if (!response.usage) return { ...EMPTY_USAGE };

  const usage = response.usage;
  const inputTokens = safeInt(usage.prompt_tokens);
  const outputTokens = safeInt(usage.completion_tokens);

  let totalTokens: number;
  if (usage.total_tokens !== undefined) {
    totalTokens = safeInt(usage.total_tokens);
  } else {
    totalTokens = inputTokens + outputTokens;
  }

  return {
    inputTokens,
    outputTokens,
    thinkingTokens: 0, // Mistral Chat Completions does not expose reasoning tokens
    cacheReadTokens: 0, // Mistral does not expose prompt-cache fields today
    cacheCreationTokens: 0,
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Bedrock extraction
//
// Targets AWS Bedrock's unified Converse / ConverseStream APIs. The legacy
// per-provider InvokeModel response shapes (e.g. `anthropic.claude-*` raw
// payloads) are intentionally NOT handled here — consumers using those
// should run the response body through the underlying provider's extractor
// (`extractAnthropicTokens` for `anthropic.*` Bedrock keys, etc.).
// ---------------------------------------------------------------------------

interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // Canonical AWS SDK field names from @aws-sdk/client-bedrock-runtime
  // TokenUsage interface. Previously mis-named as cacheReadInputTokenCount /
  // cacheWriteInputTokenCount.
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface BedrockResponse {
  usage?: BedrockUsage;
}

export function extractBedrockTokens(response: BedrockResponse): TokenUsage {
  if (!response.usage) return { ...EMPTY_USAGE };

  const usage = response.usage;
  const inputTokens = safeInt(usage.inputTokens);
  const outputTokens = safeInt(usage.outputTokens);
  const cacheReadTokens = safeInt(usage.cacheReadInputTokens);
  const cacheCreationTokens = safeInt(usage.cacheWriteInputTokens);

  let totalTokens: number;
  if (usage.totalTokens !== undefined) {
    totalTokens = safeInt(usage.totalTokens);
  } else {
    totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  }

  return {
    inputTokens,
    outputTokens,
    thinkingTokens: 0, // Bedrock Converse does not surface reasoning tokens distinctly
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Unified stream extraction
// ---------------------------------------------------------------------------

/**
 * Track providers we've already warned about for unsupported streaming token
 * extraction. One-shot per process — a noisy provider
 * shouldn't flood stderr, but the first call is loud enough to be discovered.
 */
const unsupportedProvidersWarned = new Set<AiProvider>();

function warnUnsupportedProviderOnce(provider: AiProvider, source: string): void {
  if (unsupportedProvidersWarned.has(provider)) return;
  unsupportedProvidersWarned.add(provider);
  tokenLogger.warn(
    `${source}: token extraction not implemented for provider "${provider}" — returning zero usage. ` +
      `Cost reports for this provider will be $0 until an extractor is added. ` +
      `Pass usage data manually via createAiResponse if you have it.`,
    { provider },
  );
}

/**
 * Test-only — reset the warn-once set so per-test assertions can re-trigger.
 */
export function __resetUnsupportedProvidersWarned(): void {
  unsupportedProvidersWarned.clear();
}

export function extractStreamTokens(
  // Accepts both non-streaming response shapes and streaming final-chunk
  // shapes (which may nest usage differently). Duck-typed internally.
  finalChunk: unknown,
  provider: AiProvider,
): TokenUsage {
  // Guard against null/non-object for all providers — each extractor begins with
  // `if (!response.usage) return EMPTY_USAGE` but that dereferences response
  // first, throwing TypeError if it is null.
  if (finalChunk == null || typeof finalChunk !== 'object') {
    return { ...EMPTY_USAGE };
  }
  if (provider === 'anthropic') {
    return extractAnthropicTokens(finalChunk as AnthropicResponse);
  }
  if (provider === 'google') {
    return extractGeminiTokens(finalChunk as GeminiResponse);
  }
  if (provider === 'openai') {
    return extractOpenAITokens(finalChunk as OpenAIResponse);
  }
  if (provider === 'bedrock') {
    // Bedrock stream final chunks nest usage under metadata.usage; non-streaming
    // responses have it at the top level. Unwrap before delegating.
    // null/non-object already guarded above.
    const bedrockChunk = finalChunk as BedrockStreamChunk | BedrockResponse;
    if ('metadata' in bedrockChunk) {
      // This is a streaming-shaped chunk (has a metadata key). Keep shape
      // detection separate from usage-presence so a future metadata event type
      // that carries no usage does not fall through to the non-streaming extractor
      // where the top-level usage field is also absent.
      const streamUsage = (bedrockChunk as BedrockStreamChunk).metadata?.usage;
      if (streamUsage) {
        return extractBedrockTokens({ usage: streamUsage });
      }
      tokenLogger.debug('Bedrock streaming chunk has metadata but no usage — returning empty', {
        keys: Object.keys(bedrockChunk),
      });
      return { ...EMPTY_USAGE };
    }
    return extractBedrockTokens(bedrockChunk as BedrockResponse);
  }
  if (provider === 'mistral') {
    return extractMistralTokens(finalChunk as MistralResponse);
  }
  if (provider === 'cohere') {
    // Cohere stream final chunks (message-end) nest usage under delta.usage;
    // non-streaming responses have it at the top level.
    // null/non-object already guarded above.
    const cohereChunk = finalChunk as CohereStreamChunk | CohereResponse;
    const streamUsage = (cohereChunk as CohereStreamChunk).delta?.usage;
    if ('delta' in cohereChunk && streamUsage) {
      return extractCohereTokens({ usage: streamUsage });
    }
    return extractCohereTokens(cohereChunk as CohereResponse);
  }
  // Defensive guard for hypothetical future providers added to AiProvider
  // without a matching extractor branch above.
  warnUnsupportedProviderOnce(provider, 'extractStreamTokens');
  return { ...EMPTY_USAGE };
}

// ---------------------------------------------------------------------------
// TokenAccumulator — streaming token tracker
// ---------------------------------------------------------------------------

interface AnthropicStreamEvent {
  type?: string;
  message?: AnthropicResponse;
  // The `usage` object on a message_delta event carries the FINAL counts,
  // not just output_tokens. Per the Anthropic streaming spec, every field
  // here may be revised on the message_delta relative to message_start.
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    // Extended-thinking field — add when Anthropic surfaces it on streaming
    // events. Present on the non-streaming AnthropicUsage but absent here
    // until confirmed in the streaming spec. Adding it now so addAnthropicChunk
    // can pick it up automatically when the SDK starts emitting it.
    thinking_tokens?: number;
  };
  delta?: { stop_reason?: string };
}

interface GeminiStreamChunk {
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * OpenAI stream chunk shape. With `stream_options: { include_usage: true }`,
 * the LAST chunk carries `usage` (the same shape as the non-streaming
 * response). Earlier chunks have `choices` with token deltas but no `usage`.
 */
interface OpenAIStreamChunk {
  usage?: OpenAIUsage;
}

/**
 * Bedrock ConverseStream event. Per AWS docs, usage and metrics arrive on
 * a `metadata` event near the end of the stream:
 *   `{ metadata: { usage: { inputTokens, outputTokens, ... }, metrics: {...} } }`
 * Earlier events carry `messageStart`, `contentBlockDelta`, etc., none of
 * which include token counts — we no-op those here.
 */
interface BedrockStreamChunk {
  metadata?: {
    usage?: BedrockUsage;
  };
}

/**
 * Mistral stream chunk (OpenAI-compatible). The final chunk carries `usage`;
 * earlier chunks have token deltas in `choices[].delta` and no usage.
 */
interface MistralStreamChunk {
  usage?: MistralUsage;
}

/**
 * Cohere v2 streaming event. The final `message-end` event carries
 * `delta.usage.tokens` with the same shape as the non-streaming response.
 * Earlier event types (`message-start`, `content-delta`, etc.) carry no
 * usage and no-op here.
 */
interface CohereStreamChunk {
  type?: string;
  delta?: {
    usage?: CohereUsage;
  };
}

export class TokenAccumulator {
  private provider: AiProvider;
  private latestUsage: MutableTokenUsage = { ...EMPTY_USAGE };
  private finalized = false;

  constructor(provider: AiProvider) {
    this.provider = provider;
  }

  addChunk(chunk: unknown): void {
    if (this.finalized) return;

    if (this.provider === 'anthropic') {
      this.addAnthropicChunk(chunk as AnthropicStreamEvent);
      return;
    }
    if (this.provider === 'google') {
      this.addGeminiChunk(chunk as GeminiStreamChunk);
      return;
    }
    if (this.provider === 'openai') {
      this.addOpenAIChunk(chunk as OpenAIStreamChunk);
      return;
    }
    if (this.provider === 'bedrock') {
      this.addBedrockChunk(chunk as BedrockStreamChunk);
      return;
    }
    if (this.provider === 'mistral') {
      this.addMistralChunk(chunk as MistralStreamChunk);
      return;
    }
    if (this.provider === 'cohere') {
      this.addCohereChunk(chunk as CohereStreamChunk);
      return;
    }
    // Defensive guard for hypothetical future providers added to AiProvider
    // without a matching extractor branch above.
    warnUnsupportedProviderOnce(this.provider, 'TokenAccumulator');
  }

  finalize(): TokenUsage {
    this.finalized = true;
    return { ...this.latestUsage };
  }

  /**
   * Reset the accumulator so it can be reused for a new stream.
   * Zeroes the latest usage snapshot and clears the
   * `finalized` flag. The provider binding is preserved — to track a
   * different provider, construct a new `TokenAccumulator`.
   *
   * Useful when a streaming operation retries mid-stream (provider-side
   * disconnect, client-side reconnect): instead of allocating a fresh
   * instance for each attempt, the caller can `reset()` the existing one.
   * Without this method `addChunk()` is a no-op after `finalize()` and
   * subsequent `finalize()` calls return the stale snapshot.
   */
  reset(): void {
    this.latestUsage = { ...EMPTY_USAGE };
    this.finalized = false;
  }

  private addAnthropicChunk(event: AnthropicStreamEvent): void {
    // message_start carries the initial usage with input token counts.
    if (event.type === 'message_start' && event.message?.usage) {
      const usage = event.message.usage;
      this.latestUsage.inputTokens = safeInt(usage.input_tokens);
      this.latestUsage.cacheReadTokens = safeInt(usage.cache_read_input_tokens);
      this.latestUsage.cacheCreationTokens = safeInt(usage.cache_creation_input_tokens);
      this.latestUsage.totalTokens =
        this.latestUsage.inputTokens +
        this.latestUsage.outputTokens +
        this.latestUsage.thinkingTokens +
        this.latestUsage.cacheReadTokens +
        this.latestUsage.cacheCreationTokens;
    }

    // message_delta carries the FINAL counts. Per the Anthropic streaming
    // spec it includes input_tokens, output_tokens, cache_read_input_tokens,
    // and cache_creation_input_tokens — all of which may differ from
    // message_start. Only overwrite a field when the delta carries it,
    // so single-event-mocks (older tests, simpler stubs) continue to work.
    if (event.type === 'message_delta' && event.usage) {
      const u = event.usage;
      if (u.output_tokens !== undefined) {
        this.latestUsage.outputTokens = safeInt(u.output_tokens);
      }
      if (u.input_tokens !== undefined) {
        this.latestUsage.inputTokens = safeInt(u.input_tokens);
      }
      if (u.cache_read_input_tokens !== undefined) {
        this.latestUsage.cacheReadTokens = safeInt(u.cache_read_input_tokens);
      }
      if (u.cache_creation_input_tokens !== undefined) {
        this.latestUsage.cacheCreationTokens = safeInt(u.cache_creation_input_tokens);
      }
      // Pick up thinking_tokens when Anthropic starts emitting it on streaming
      // events. Matches the non-streaming path in extractAnthropicTokens.
      if (u.thinking_tokens !== undefined) {
        this.latestUsage.thinkingTokens = safeInt(u.thinking_tokens);
      }
      // Recalculate totalTokens only when a usage update was received.
      // Moving this inside the branch avoids re-computing on every non-usage
      // event (content_block_delta etc.) and is consistent with the Gemini/
      // OpenAI/Bedrock/Cohere accumulators which all update inside their guards.
      this.latestUsage.totalTokens =
        this.latestUsage.inputTokens +
        this.latestUsage.outputTokens +
        this.latestUsage.thinkingTokens +
        this.latestUsage.cacheReadTokens +
        this.latestUsage.cacheCreationTokens;
    }
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

  private addOpenAIChunk(chunk: OpenAIStreamChunk): void {
    // Only the final chunk (when stream_options.include_usage is set) carries
    // `usage`. Earlier chunks are no-ops here. The values are absolute, not
    // deltas, so overwrite rather than accumulate.
    if (chunk.usage) {
      const u = chunk.usage;
      this.latestUsage.inputTokens = safeInt(u.prompt_tokens);
      this.latestUsage.outputTokens = safeInt(u.completion_tokens);
      this.latestUsage.cacheReadTokens = safeInt(u.prompt_tokens_details?.cached_tokens);
      this.latestUsage.thinkingTokens = safeInt(u.completion_tokens_details?.reasoning_tokens);
      this.latestUsage.totalTokens =
        u.total_tokens !== undefined
          ? safeInt(u.total_tokens)
          : // Same subset semantics as extractOpenAITokens — neither
            // cacheReadTokens nor thinkingTokens is additive for OpenAI.
            this.latestUsage.inputTokens + this.latestUsage.outputTokens;
    }
  }

  private addCohereChunk(chunk: CohereStreamChunk): void {
    // Only the `message-end` event carries usage; earlier event types are
    // no-ops here. The values are absolute, not deltas, so overwrite rather
    // than accumulate.
    const usage = chunk.delta?.usage;
    if (usage) {
      const counts = usage.tokens ?? usage.billed_units ?? {};
      this.latestUsage.inputTokens = safeInt(counts.input_tokens);
      this.latestUsage.outputTokens = safeInt(counts.output_tokens);
      this.latestUsage.totalTokens =
        this.latestUsage.inputTokens +
        this.latestUsage.outputTokens +
        this.latestUsage.thinkingTokens +
        this.latestUsage.cacheReadTokens +
        this.latestUsage.cacheCreationTokens;
    }
  }

  private addMistralChunk(chunk: MistralStreamChunk): void {
    // Final chunk carries usage. The values are absolute, not deltas, so
    // overwrite rather than accumulate.
    if (chunk.usage) {
      const u = chunk.usage;
      this.latestUsage.inputTokens = safeInt(u.prompt_tokens);
      this.latestUsage.outputTokens = safeInt(u.completion_tokens);
      this.latestUsage.totalTokens =
        u.total_tokens !== undefined
          ? safeInt(u.total_tokens)
          : this.latestUsage.inputTokens +
            this.latestUsage.outputTokens +
            this.latestUsage.thinkingTokens +
            this.latestUsage.cacheReadTokens +
            this.latestUsage.cacheCreationTokens;
    }
  }

  private addBedrockChunk(chunk: BedrockStreamChunk): void {
    // Bedrock ConverseStream emits the `metadata` event near the end of
    // the stream; earlier events (messageStart, contentBlockDelta,
    // messageStop) carry no usage. The values are absolute, not deltas,
    // so overwrite rather than accumulate.
    const usage = chunk.metadata?.usage;
    if (usage) {
      this.latestUsage.inputTokens = safeInt(usage.inputTokens);
      this.latestUsage.outputTokens = safeInt(usage.outputTokens);
      this.latestUsage.cacheReadTokens = safeInt(usage.cacheReadInputTokens);
      this.latestUsage.cacheCreationTokens = safeInt(usage.cacheWriteInputTokens);
      this.latestUsage.totalTokens =
        usage.totalTokens !== undefined
          ? safeInt(usage.totalTokens)
          : this.latestUsage.inputTokens +
            this.latestUsage.outputTokens +
            this.latestUsage.thinkingTokens +
            this.latestUsage.cacheReadTokens +
            this.latestUsage.cacheCreationTokens;
    }
  }
}
