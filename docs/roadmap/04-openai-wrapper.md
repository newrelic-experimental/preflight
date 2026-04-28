# Implementation Plan: OpenAI SDK Wrapper

**Roadmap item:** [02 — OpenAI SDK Wrapper](../../ROADMAP.md#2-openai-sdk-wrapper)
**Effort estimate:** ~1 day
**Prerequisites:** Read `packages/nr-ai-agent/src/wrappers/anthropic.ts` and `packages/shared/src/pricing-data.ts` before starting.

---

## Goal

Add a `wrapOpenAiClient()` function to `nr-ai-agent` that mirrors the existing Anthropic wrapper. It intercepts `openai.chat.completions.create()` for both streaming and non-streaming calls, records token usage, latency, and content (when configured), and emits `AiRequestRecord` objects through the same `RecordHandler` pipeline.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-agent/src/wrappers/anthropic.ts` — the pattern to follow exactly
- `packages/nr-ai-agent/src/types.ts` — `AiRequestRecord`, `WrapperConfig`, `RecordHandler`
- `packages/nr-ai-agent/src/agent.ts` — how `wrapAnthropicClient` is called; `wrapOpenAiClient` will be called the same way
- `packages/shared/src/pricing-data.ts` — where to add OpenAI model prices
- `packages/shared/src/pricing.ts` — `ModelPricing` interface and `calculateCost()`

---

## Step 1 — Add OpenAI pricing to the shared package

Open `packages/shared/src/pricing-data.ts`. Add the following entries to `DEFAULT_PRICING_TABLE` after the Gemini block. These are USD per million tokens (source: OpenAI pricing page, 2025).

```typescript
// ---- OpenAI ----
'gpt-4o': {
  inputPerMTok: 2.5,
  outputPerMTok: 10,
  contextWindow: 128_000,
},
'gpt-4o-mini': {
  inputPerMTok: 0.15,
  outputPerMTok: 0.6,
  contextWindow: 128_000,
},
'gpt-4o-2024-11-20': {
  inputPerMTok: 2.5,
  outputPerMTok: 10,
  contextWindow: 128_000,
},
'gpt-4o-2024-08-06': {
  inputPerMTok: 2.5,
  outputPerMTok: 10,
  contextWindow: 128_000,
},
'gpt-4o-mini-2024-07-18': {
  inputPerMTok: 0.15,
  outputPerMTok: 0.6,
  contextWindow: 128_000,
},
'o1': {
  inputPerMTok: 15,
  outputPerMTok: 60,
  thinkingPerMTok: 60,
  contextWindow: 200_000,
},
'o1-mini': {
  inputPerMTok: 1.1,
  outputPerMTok: 4.4,
  contextWindow: 128_000,
},
'o1-preview': {
  inputPerMTok: 15,
  outputPerMTok: 60,
  contextWindow: 128_000,
},
'o3': {
  inputPerMTok: 10,
  outputPerMTok: 40,
  thinkingPerMTok: 40,
  contextWindow: 200_000,
},
'o3-mini': {
  inputPerMTok: 1.1,
  outputPerMTok: 4.4,
  contextWindow: 200_000,
},
'o4-mini': {
  inputPerMTok: 1.1,
  outputPerMTok: 4.4,
  contextWindow: 200_000,
},
'gpt-4-turbo': {
  inputPerMTok: 10,
  outputPerMTok: 30,
  contextWindow: 128_000,
},
'gpt-3.5-turbo': {
  inputPerMTok: 0.5,
  outputPerMTok: 1.5,
  contextWindow: 16_385,
},
```

---

## Step 2 — Add `openai` as a peer dependency

In `packages/nr-ai-agent/package.json`, add to `"peerDependencies"`:

```json
"openai": ">=4.0.0"
```

And to `"peerDependenciesMeta"` (create this key if it doesn't exist):

```json
"peerDependenciesMeta": {
  "@anthropic-ai/sdk": { "optional": true },
  "@google/genai": { "optional": true },
  "openai": { "optional": true }
}
```

Also add `openai` to `"devDependencies"` for the test environment:

```json
"openai": "^4.0.0"
```

Run `npm install` from the repo root after editing.

---

## Step 3 — Create the wrapper file

Create `packages/nr-ai-agent/src/wrappers/openai.ts`.

### 3a — Imports

```typescript
import type OpenAI from 'openai';
import type { RequestOptions } from 'openai/core';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionCreateParamsBase,
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';
import { randomUUID } from 'node:crypto';
import { RequestTimer } from '@nr-ai-observatory/shared';
import type { RequestTimerMetrics } from '@nr-ai-observatory/shared';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';
```

### 3b — Helper utilities (copy pattern from anthropic.ts)

```typescript
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function redact(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((s, pattern) => s.replace(pattern, '[REDACTED]'), text);
}

function sanitizeToolName(name: unknown): string {
  return String(name ?? '').slice(0, 256).replace(/[\x00-\x1f]/g, '');
}
```

### 3c — OpenAI-specific field extraction

```typescript
function extractSystemPromptLength(
  messages: ChatCompletionCreateParamsBase['messages'],
): number | null {
  const system = messages.find(m => m.role === 'system');
  if (!system) return null;
  return typeof system.content === 'string' ? system.content.length : null;
}

function extractSystemPromptText(
  messages: ChatCompletionCreateParamsBase['messages'],
): string | null {
  const system = messages.find(m => m.role === 'system');
  if (!system) return null;
  return typeof system.content === 'string' ? system.content : null;
}

function extractLastUserMessage(
  messages: ChatCompletionCreateParamsBase['messages'],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      return typeof msg.content === 'string' ? msg.content : null;
    }
  }
  return null;
}

function extractToolInfo(
  tools: ChatCompletionCreateParamsBase['tools'] | undefined,
): { count: number; names: string[] } {
  if (!tools || tools.length === 0) return { count: 0, names: [] };
  const names = tools.map(t => sanitizeToolName(t.function.name));
  return { count: tools.length, names };
}

function extractResponseText(choice: ChatCompletion['choices'][0]): string | null {
  return choice.message.content ?? null;
}

function mapStopReason(finishReason: ChatCompletion['choices'][0]['finish_reason'] | null): string | null {
  if (!finishReason) return null;
  // Normalize OpenAI finish reasons to the shared vocabulary used by the Anthropic wrapper
  const map: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'content_filter',
    function_call: 'tool_use',
  };
  return map[finishReason] ?? finishReason;
}
```

### 3d — Base record builder

```typescript
function buildBaseRecord(
  params: ChatCompletionCreateParamsBase,
  config: WrapperConfig,
): Omit<
  AiRequestRecord,
  | 'durationMs'
  | 'timeToFirstTokenMs'
  | 'inputTokens'
  | 'outputTokens'
  | 'thinkingTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'totalTokens'
  | 'stopReason'
  | 'contentBlockTypes'
  | 'responseText'
  | 'error'
> {
  const toolInfo = extractToolInfo(params.tools);
  const shouldCapture = config.recordContent && !config.highSecurity;
  const rawSystemPrompt = extractSystemPromptText(params.messages);
  const rawUserMessage = extractLastUserMessage(params.messages);

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    provider: 'openai',
    model: '',
    requestModel: params.model,
    requestMethod: '',
    streaming: false,
    maxTokens: params.max_tokens ?? null,
    temperature: typeof params.temperature === 'number' ? params.temperature : null,
    topP: typeof params.top_p === 'number' ? params.top_p : null,
    topK: null, // OpenAI does not have top_k
    messageCount: params.messages.length,
    toolCount: toolInfo.count,
    toolNames: toolInfo.names,
    thinkingEnabled: false, // OpenAI reasoning is internal; not directly configurable
    thinkingBudgetTokens: null,
    systemPromptLength: extractSystemPromptLength(params.messages),
    systemPrompt:
      shouldCapture && rawSystemPrompt !== null
        ? truncate(rawSystemPrompt, config.contentMaxLength)
        : null,
    lastUserMessage:
      shouldCapture && rawUserMessage !== null
        ? truncate(rawUserMessage, config.contentMaxLength)
        : null,
  };
}
```

### 3e — Non-streaming finalizer

```typescript
function finalizeRecord(
  base: ReturnType<typeof buildBaseRecord>,
  response: ChatCompletion,
  metrics: RequestTimerMetrics,
  config: WrapperConfig,
): AiRequestRecord {
  const shouldCapture = config.recordContent && !config.highSecurity;
  const usage = response.usage;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  // o1/o3 expose reasoning_tokens in completion_tokens_details
  const thinkingTokens = (usage as { completion_tokens_details?: { reasoning_tokens?: number } })
    ?.completion_tokens_details?.reasoning_tokens ?? 0;

  const firstChoice = response.choices[0];
  const rawResponseText = firstChoice ? extractResponseText(firstChoice) : null;

  return {
    ...base,
    model: response.model,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: metrics.timeToFirstTokenMs,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens: 0, // OpenAI does not expose cache read tokens in the same way
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens,
    stopReason: firstChoice ? mapStopReason(firstChoice.finish_reason) : null,
    contentBlockTypes: firstChoice?.message.tool_calls?.length ? ['text', 'tool_use'] : ['text'],
    responseText:
      shouldCapture && rawResponseText !== null
        ? truncate(rawResponseText, config.contentMaxLength)
        : null,
    error: null,
  };
}
```

### 3f — Error record builder

```typescript
function buildErrorRecord(
  base: ReturnType<typeof buildBaseRecord>,
  err: unknown,
  timer: RequestTimer,
  config: WrapperConfig,
): AiRequestRecord {
  timer.stop();
  const metrics = timer.getMetrics();
  const error = err as { status?: number; code?: string; message?: string };
  const rawMessage = error.message ?? (err instanceof Error ? err.message : String(err));
  return {
    ...base,
    model: base.requestModel,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: null,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    stopReason: null,
    contentBlockTypes: [],
    responseText: null,
    error: {
      type: error.code ?? (err instanceof Error ? err.constructor.name : 'Unknown'),
      message: truncate(redact(rawMessage, config.redactionPatterns), 1024),
      statusCode: error.status ?? null,
    },
  };
}
```

### 3g — Non-streaming `create` wrapper

```typescript
function wrapCreate(
  original: OpenAI['chat']['completions']['create'],
  config: WrapperConfig,
  onRecord: RecordHandler,
): OpenAI['chat']['completions']['create'] {
  return function wrappedCreate(
    this: OpenAI['chat']['completions'],
    body: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming | ChatCompletionCreateParamsBase,
    options?: RequestOptions,
  ): ReturnType<OpenAI['chat']['completions']['create']> {
    if ('stream' in body && body.stream === true) {
      const base = buildBaseRecord(body, config);
      base.requestMethod = 'chat.completions.create';
      base.streaming = true;
      const timer = new RequestTimer();
      timer.start();

      const promise = original.call(
        this,
        body as ChatCompletionCreateParamsStreaming,
        options,
      ) as Promise<Stream<ChatCompletionChunk>>;

      return promise.then(stream =>
        wrapStreamIterator(stream, base, timer, config, onRecord),
      ) as ReturnType<OpenAI['chat']['completions']['create']>;
    }

    // Non-streaming
    const base = buildBaseRecord(body, config);
    base.requestMethod = 'chat.completions.create';
    base.streaming = false;
    const timer = new RequestTimer();
    timer.start();

    const promise = original.call(
      this,
      body as ChatCompletionCreateParamsNonStreaming,
      options,
    ) as Promise<ChatCompletion>;

    return promise.then(
      response => {
        timer.stop();
        const record = finalizeRecord(base, response, timer.getMetrics(), config);
        onRecord(record);
        return response;
      },
      err => {
        const record = buildErrorRecord(base, err, timer, config);
        onRecord(record);
        throw err;
      },
    ) as ReturnType<OpenAI['chat']['completions']['create']>;
  } as OpenAI['chat']['completions']['create'];
}
```

### 3h — Streaming wrapper

The OpenAI SDK streaming response is a `Stream<ChatCompletionChunk>`. Wrap its async iterator to accumulate token counts from the final `usage` chunk.

```typescript
function wrapStreamIterator(
  stream: Stream<ChatCompletionChunk>,
  base: ReturnType<typeof buildBaseRecord>,
  timer: RequestTimer,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Stream<ChatCompletionChunk> {
  let lastChunk: ChatCompletionChunk | null = null;
  let accumulatedContent = '';

  const originalIterator = stream[Symbol.asyncIterator].bind(stream);

  const wrappedIterator = async function* (): AsyncGenerator<ChatCompletionChunk> {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
        // First text delta marks TTFT
        const delta = chunk.choices[0]?.delta?.content;
        if (delta && typeof delta === 'string' && delta.length > 0) {
          timer.markFirstToken();
          accumulatedContent += delta;
        }
        lastChunk = chunk;
        yield chunk;
      }

      // Stream complete — build record from final chunk usage
      timer.stop();
      const usage = lastChunk?.usage;
      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const thinkingTokens = (usage as { completion_tokens_details?: { reasoning_tokens?: number } })
        ?.completion_tokens_details?.reasoning_tokens ?? 0;
      const finishReason = lastChunk?.choices[0]?.finish_reason ?? null;
      const shouldCapture = config.recordContent && !config.highSecurity;

      const record: AiRequestRecord = {
        ...base,
        model: lastChunk?.model ?? base.requestModel,
        durationMs: timer.getMetrics().durationMs,
        timeToFirstTokenMs: timer.getMetrics().timeToFirstTokenMs,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: inputTokens + outputTokens,
        stopReason: mapStopReason(finishReason),
        contentBlockTypes: ['text'],
        responseText:
          shouldCapture && accumulatedContent.length > 0
            ? truncate(accumulatedContent, config.contentMaxLength)
            : null,
        error: null,
      };
      onRecord(record);
    } catch (err) {
      const record = buildErrorRecord(base, err, timer, config);
      onRecord(record);
      throw err;
    }
  };

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) return wrappedIterator;
      return Reflect.get(target, prop, receiver);
    },
  });
}
```

> **Note on streaming usage:** The OpenAI SDK only emits `usage` on the final chunk if `stream_options: { include_usage: true }` is passed by the caller. The wrapper should work without it (tokens will be 0), but the `wrapOpenAiClient` function should document this expectation.

### 3i — Public export function

```typescript
/**
 * Wrap an OpenAI client to intercept chat.completions.create calls and
 * emit AiRequestRecord objects for every request.
 *
 * Note: to get accurate token counts in streaming mode, pass
 * `stream_options: { include_usage: true }` in the request body.
 *
 * @param client The OpenAI client instance to wrap.
 * @param config Wrapper configuration (enabled, recordContent, etc.).
 * @param onRecord Callback invoked with each completed AiRequestRecord.
 * @returns The same client instance with intercepted methods.
 */
export function wrapOpenAiClient(
  client: OpenAI,
  config: WrapperConfig,
  onRecord: RecordHandler,
): OpenAI {
  if (!config.enabled) return client;

  const originalCreate = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = wrapCreate(originalCreate, config, onRecord);

  return client;
}
```

---

## Step 4 — Export from `nr-ai-agent`

In `packages/nr-ai-agent/src/agent.ts`, add `wrapOpenAiClient` to the re-exports section (look for where `wrapAnthropicClient` and `wrapGeminiClient` are exported).

In `packages/nr-ai-agent/package.json`, the `exports` field should already be `"."`. No change needed if `agent.ts` is the main entry.

---

## Step 5 — Write tests

Create `packages/nr-ai-agent/src/wrappers/openai.test.ts`.

### Test structure

Follow the exact same structure as `packages/nr-ai-agent/src/wrappers/anthropic.test.ts` (read that file before writing tests). Key cases to cover:

#### Non-streaming happy path
- Call `wrapOpenAiClient(client, config, onRecord)`
- Mock `client.chat.completions.create` to return a `ChatCompletion` with `usage: { prompt_tokens: 100, completion_tokens: 50 }`
- Assert `onRecord` was called once
- Assert `record.provider === 'openai'`
- Assert `record.inputTokens === 100`, `record.outputTokens === 50`
- Assert `record.durationMs > 0`
- Assert `record.error === null`

#### Streaming happy path
- Mock `client.chat.completions.create` to return an async iterable of `ChatCompletionChunk`s
- Include a final chunk with `usage: { prompt_tokens: 80, completion_tokens: 30 }`
- Assert `onRecord` called once after iteration completes
- Assert token counts match the usage chunk

#### Error path
- Mock `client.chat.completions.create` to reject with `{ status: 429, message: 'Rate limit' }`
- Assert `onRecord` called with `record.error.statusCode === 429`
- Assert the original error is re-thrown

#### Content capture disabled
- Set `config.recordContent = false`
- Assert `record.systemPrompt === null` and `record.lastUserMessage === null` and `record.responseText === null`

#### `config.enabled = false`
- Assert `wrapOpenAiClient` returns the client unchanged (no interception)

#### `highSecurity = true`
- Assert content fields are null even when `recordContent = true`

#### Reasoning tokens (o1/o3)
- Return a response with `completion_tokens_details: { reasoning_tokens: 200 }`
- Assert `record.thinkingTokens === 200`

#### `mapStopReason`
- Assert `'stop'` → `'end_turn'`
- Assert `'length'` → `'max_tokens'`
- Assert `'tool_calls'` → `'tool_use'`
- Assert `null` → `null`

---

## Step 6 — Pricing data test

In `packages/shared/src/pricing-data.test.ts` (or the equivalent test for pricing), add assertions that all new OpenAI model IDs are present in `DEFAULT_PRICING_TABLE` and have positive `inputPerMTok` and `outputPerMTok` values.

```typescript
const EXPECTED_OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
  'o3',
  'o3-mini',
  'o4-mini',
];

describe('OpenAI pricing entries', () => {
  for (const model of EXPECTED_OPENAI_MODELS) {
    it(`has pricing for ${model}`, () => {
      expect(DEFAULT_PRICING_TABLE[model]).toBeDefined();
      expect(DEFAULT_PRICING_TABLE[model].inputPerMTok).toBeGreaterThan(0);
      expect(DEFAULT_PRICING_TABLE[model].outputPerMTok).toBeGreaterThan(0);
    });
  }
});
```

---

## Acceptance criteria

- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — all new and existing tests green
- [ ] `wrapOpenAiClient()` is exported from `nr-ai-agent`
- [ ] Non-streaming and streaming paths both call `onRecord` exactly once per request
- [ ] Error path calls `onRecord` and re-throws
- [ ] Token counts from `usage` are correctly mapped to `AiRequestRecord` fields
- [ ] `thinkingTokens` is populated from `completion_tokens_details.reasoning_tokens` for o1/o3
- [ ] `record.provider === 'openai'` for all records
- [ ] `stopReason` is normalized to the shared vocabulary
- [ ] `highSecurity = true` forces all content fields to null
- [ ] All new OpenAI models appear in `DEFAULT_PRICING_TABLE`
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-agent/src/wrappers/openai.ts
packages/nr-ai-agent/src/wrappers/openai.test.ts
```

Files to **modify**:

```
packages/shared/src/pricing-data.ts      — add OpenAI model entries
packages/nr-ai-agent/src/agent.ts        — export wrapOpenAiClient
packages/nr-ai-agent/package.json        — add openai peer + dev dependency
```
