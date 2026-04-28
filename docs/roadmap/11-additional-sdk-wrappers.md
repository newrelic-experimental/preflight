# Implementation Plan: Additional SDK Wrappers

**Roadmap item:** [09 — Additional SDK Wrappers](../../ROADMAP.md#9-additional-sdk-wrappers)
**Effort estimate:** ~2 days (all three wrappers)
**Prerequisites:** Read the following files before starting.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-agent/src/wrappers/anthropic.ts` — the primary wrapper template
- `packages/nr-ai-agent/src/wrappers/openai.ts` — the OpenAI wrapper (from plan 02); Bedrock and Mistral follow similar patterns
- `packages/nr-ai-agent/src/types.ts` — `AiRequestRecord`, `WrapperConfig`, `RecordHandler`
- `packages/nr-ai-agent/src/agent.ts` — how wrappers are exported
- `packages/shared/src/pricing-data.ts` — where to add new model prices

---

## Goal

Three new wrappers for `nr-ai-agent`:

1. **BedrockWrapper** — AWS SDK `@aws-sdk/client-bedrock-runtime`, wrapping `InvokeModelCommand` and `InvokeModelWithResponseStreamCommand`
2. **MistralWrapper** — `@mistralai/mistralai` SDK, wrapping `client.chat.complete` and streaming
3. **CohereWrapper** — `cohere-ai` SDK, wrapping `client.chat` and `client.chatStream`

Each wrapper follows the same pattern: intercept calls, record latency and token counts, emit `AiRequestRecord` via `RecordHandler`.

---

## Wrapper 1: AWS Bedrock

### Step 1a — Add Bedrock model pricing

Open `packages/shared/src/pricing-data.ts`. Add after the OpenAI block:

```typescript
// ---- AWS Bedrock (Converse API pricing for on-demand) ----
// Claude models via Bedrock cross-region inference
'anthropic.claude-3-5-sonnet-20241022-v2:0': {
  inputPerMTok: 3,
  outputPerMTok: 15,
  contextWindow: 200_000,
},
'anthropic.claude-3-5-haiku-20241022-v1:0': {
  inputPerMTok: 0.8,
  outputPerMTok: 4,
  contextWindow: 200_000,
},
'anthropic.claude-3-opus-20240229-v1:0': {
  inputPerMTok: 15,
  outputPerMTok: 75,
  contextWindow: 200_000,
},
// Meta Llama via Bedrock
'meta.llama3-70b-instruct-v1:0': {
  inputPerMTok: 0.99,
  outputPerMTok: 0.99,
  contextWindow: 128_000,
},
'meta.llama3-8b-instruct-v1:0': {
  inputPerMTok: 0.3,
  outputPerMTok: 0.6,
  contextWindow: 128_000,
},
// Mistral via Bedrock
'mistral.mistral-large-2402-v1:0': {
  inputPerMTok: 4,
  outputPerMTok: 12,
  contextWindow: 32_000,
},
'mistral.mistral-small-2402-v1:0': {
  inputPerMTok: 1,
  outputPerMTok: 3,
  contextWindow: 32_000,
},
// Amazon Nova
'amazon.nova-pro-v1:0': {
  inputPerMTok: 0.8,
  outputPerMTok: 3.2,
  contextWindow: 300_000,
},
'amazon.nova-lite-v1:0': {
  inputPerMTok: 0.06,
  outputPerMTok: 0.24,
  contextWindow: 300_000,
},
'amazon.nova-micro-v1:0': {
  inputPerMTok: 0.035,
  outputPerMTok: 0.14,
  contextWindow: 128_000,
},
```

### Step 1b — Add Bedrock as peer + dev dependency

In `packages/nr-ai-agent/package.json`:

```json
"peerDependencies": {
  "@anthropic-ai/sdk": { "optional": true },
  "@google/genai": { "optional": true },
  "openai": { "optional": true },
  "@aws-sdk/client-bedrock-runtime": { "optional": true }
},
"devDependencies": {
  "@aws-sdk/client-bedrock-runtime": "^3.0.0"
}
```

### Step 1c — Create `packages/nr-ai-agent/src/wrappers/bedrock.ts`

The AWS Bedrock SDK requires a `BedrockRuntimeClient` and two commands:
- `InvokeModelCommand` — non-streaming, sends JSON body, receives JSON response
- `InvokeModelWithResponseStreamCommand` — streaming, receives `AsyncIterable<InvokeModelWithResponseStreamCommandOutput>`

The request/response body format depends on the model. For Claude models it matches the Anthropic format; for others it varies. This wrapper uses the **Converse API** (`ConverseCommand` and `ConverseStreamCommand`), which provides a unified interface across all Bedrock models.

```typescript
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
  ContentBlock,
  Message,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { RequestTimer } from '@nr-ai-observatory/shared';
import type { RequestTimerMetrics } from '@nr-ai-observatory/shared';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';
```

#### Key differences from the Anthropic wrapper

1. **Provider is `'bedrock'`**, not `'anthropic'`.
2. **Model ID** is in `input.modelId` (e.g. `'anthropic.claude-3-5-sonnet-20241022-v2:0'`).
3. **Messages format**: Converse API uses `{ role, content: ContentBlock[] }`.
4. **Token counts**: `response.usage.inputTokens` and `response.usage.outputTokens`.
5. **Stop reason**: `response.stopReason` (values: `'end_turn'`, `'max_tokens'`, `'stop_sequence'`, `'tool_use'`).
6. **Streaming**: The stream delivers `ConverseStreamOutput` events. Token usage comes in the `'metadata'` event at the end.

#### `extractSystemPromptLength()`

```typescript
function extractSystemPromptLength(input: ConverseCommandInput): number | null {
  if (!input.system || input.system.length === 0) return null;
  return input.system.reduce((sum, block) => {
    return sum + ('text' in block && typeof block.text === 'string' ? block.text.length : 0);
  }, 0);
}
```

#### `extractLastUserMessage()`

```typescript
function extractLastUserMessage(messages: Message[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.content) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') return block.text;
      }
    }
  }
  return null;
}
```

#### `buildBaseRecord()`

Same shape as in the Anthropic wrapper. Key fields:
- `provider: 'bedrock'`
- `requestModel: input.modelId ?? ''`
- `topK: null` (Converse API does not expose this)
- `thinkingEnabled: false` (Bedrock Converse does not expose thinking config)

#### `wrapConverse()`

Wraps the `client.send(new ConverseCommand(...))` call pattern. Since `BedrockRuntimeClient.send()` is a generic method, the wrapper replaces it by monkey-patching or by returning a new object with the intercepted `send()`. The recommended approach:

```typescript
export function wrapBedrockClient(
  client: BedrockRuntimeClient,
  config: WrapperConfig,
  onRecord: RecordHandler,
): BedrockRuntimeClient {
  if (!config.enabled) return client;

  const originalSend = client.send.bind(client);

  (client as { send: unknown }).send = async function wrappedSend(
    command: unknown,
    ...args: unknown[]
  ) {
    if (command instanceof ConverseCommand) {
      return await interceptConverse(command, originalSend, config, onRecord, args);
    }
    if (command instanceof ConverseStreamCommand) {
      return await interceptConverseStream(command, originalSend, config, onRecord, args);
    }
    // Pass through all other commands unmodified
    return (originalSend as Function)(command, ...args);
  };

  return client;
}
```

#### `interceptConverse()`

```typescript
async function interceptConverse(
  command: ConverseCommand,
  originalSend: Function,
  config: WrapperConfig,
  onRecord: RecordHandler,
  extraArgs: unknown[],
): Promise<ConverseCommandOutput> {
  const input = command.input;
  const base = buildBaseRecord(input, config, 'converse');
  const timer = new RequestTimer();
  timer.start();

  try {
    const response = await originalSend(command, ...extraArgs) as ConverseCommandOutput;
    timer.stop();
    const record = finalizeRecord(base, response, timer.getMetrics(), config);
    onRecord(record);
    return response;
  } catch (err) {
    const record = buildErrorRecord(base, err, timer, config);
    onRecord(record);
    throw err;
  }
}
```

#### `finalizeRecord()` for Converse

```typescript
function finalizeRecord(
  base: ReturnType<typeof buildBaseRecord>,
  response: ConverseCommandOutput,
  metrics: RequestTimerMetrics,
  config: WrapperConfig,
): AiRequestRecord {
  const usage = response.usage;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const shouldCapture = config.recordContent && !config.highSecurity;

  const responseText = extractResponseText(response.output?.message?.content);

  return {
    ...base,
    model: base.requestModel,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: null, // not available in non-streaming
    inputTokens,
    outputTokens,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens,
    stopReason: response.stopReason ?? null,
    contentBlockTypes: extractContentBlockTypes(response.output?.message?.content),
    responseText: shouldCapture && responseText ? truncate(responseText, config.contentMaxLength) : null,
    error: null,
  };
}
```

#### Streaming (`interceptConverseStream`)

The `ConverseStreamCommand` response is an async iterable of `ConverseStreamOutput` events. Token counts arrive in the `metadata` event at the end.

```typescript
async function interceptConverseStream(
  command: ConverseStreamCommand,
  originalSend: Function,
  config: WrapperConfig,
  onRecord: RecordHandler,
  extraArgs: unknown[],
): Promise<unknown> {
  const input = command.input as ConverseStreamCommandInput;
  const base = buildBaseRecord(input, config, 'converse-stream');
  const timer = new RequestTimer();
  timer.start();

  const response = await originalSend(command, ...extraArgs);
  const originalStream = response.stream as AsyncIterable<ConverseStreamOutput>;

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  let accumulatedText = '';
  const shouldCapture = config.recordContent && !config.highSecurity;

  async function* wrappedStream(): AsyncGenerator<ConverseStreamOutput> {
    try {
      for await (const event of originalStream) {
        if (event.contentBlockDelta?.delta && 'text' in event.contentBlockDelta.delta) {
          const text = event.contentBlockDelta.delta.text ?? '';
          if (text) {
            timer.markFirstToken();
            if (shouldCapture) accumulatedText += text;
          }
        }
        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? 0;
          outputTokens = event.metadata.usage.outputTokens ?? 0;
        }
        if (event.messageStop) {
          stopReason = event.messageStop.stopReason ?? null;
        }
        yield event;
      }

      timer.stop();
      const record: AiRequestRecord = {
        ...base,
        model: base.requestModel,
        durationMs: timer.getMetrics().durationMs,
        timeToFirstTokenMs: timer.getMetrics().timeToFirstTokenMs,
        inputTokens,
        outputTokens,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: inputTokens + outputTokens,
        stopReason,
        contentBlockTypes: ['text'],
        responseText: shouldCapture && accumulatedText ? truncate(accumulatedText, config.contentMaxLength) : null,
        error: null,
      };
      onRecord(record);
    } catch (err) {
      const record = buildErrorRecord(base, err, timer, config);
      onRecord(record);
      throw err;
    }
  }

  return { ...response, stream: wrappedStream() };
}
```

#### Tests (`bedrock.test.ts`)

Key cases (mock `BedrockRuntimeClient.send`):
- Non-streaming `ConverseCommand` → `onRecord` called with `provider === 'bedrock'`, correct token counts
- Streaming `ConverseStreamCommand` → `onRecord` called after iteration, token counts from metadata event
- Non-Converse command (e.g. `ListFoundationModelsCommand`) → passed through without interception
- Error path → `onRecord` called with `record.error` set, error re-thrown
- `config.enabled = false` → client returned unmodified, no interception

---

## Wrapper 2: Mistral

### Step 2a — Add Mistral pricing

In `packages/shared/src/pricing-data.ts`:

```typescript
// ---- Mistral ----
'mistral-large-latest': {
  inputPerMTok: 2,
  outputPerMTok: 6,
  contextWindow: 131_000,
},
'mistral-small-latest': {
  inputPerMTok: 0.1,
  outputPerMTok: 0.3,
  contextWindow: 131_000,
},
'mistral-nemo': {
  inputPerMTok: 0.15,
  outputPerMTok: 0.15,
  contextWindow: 131_000,
},
'open-mistral-7b': {
  inputPerMTok: 0.25,
  outputPerMTok: 0.25,
  contextWindow: 32_000,
},
'open-mixtral-8x7b': {
  inputPerMTok: 0.7,
  outputPerMTok: 0.7,
  contextWindow: 32_000,
},
'codestral-latest': {
  inputPerMTok: 0.2,
  outputPerMTok: 0.6,
  contextWindow: 256_000,
},
```

### Step 2b — Add peer + dev dependency

```json
"@mistralai/mistralai": ">=1.0.0"
```

### Step 2c — Create `packages/nr-ai-agent/src/wrappers/mistral.ts`

The Mistral SDK provides `client.chat.complete({ model, messages })` (non-streaming) and `client.chat.stream({ model, messages })` (streaming, returns an async iterable).

#### Key differences from OpenAI

1. **Provider is `'mistral'`**.
2. **SDK import**: `import type { Mistral } from '@mistralai/mistralai';`
3. **Non-streaming**: `client.chat.complete()` returns a `ChatCompletionResponse`
   - `response.usage.promptTokens`, `response.usage.completionTokens`
   - `response.choices[0].finishReason` (values: `'stop'`, `'length'`, `'tool_calls'`)
4. **Streaming**: `client.chat.stream()` returns `AsyncIterable<CompletionEvent>`
   - `event.data.choices[0].delta.content` for text
   - Final `event.data.usage` chunk for token counts (only present on last chunk)

#### Public export

```typescript
export function wrapMistralClient(
  client: Mistral,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Mistral {
  if (!config.enabled) return client;

  const originalComplete = client.chat.complete.bind(client.chat);
  const originalStream = client.chat.stream.bind(client.chat);

  client.chat.complete = wrapComplete(originalComplete, config, onRecord);
  client.chat.stream = wrapStream(originalStream, config, onRecord);

  return client;
}
```

The `wrapComplete` and `wrapStream` functions follow the exact same pattern as the OpenAI wrapper. Key mapping:
- `response.usage.promptTokens` → `inputTokens`
- `response.usage.completionTokens` → `outputTokens`
- `response.choices[0].finishReason` → `stopReason` (map `'stop'` → `'end_turn'`, `'length'` → `'max_tokens'`)

#### Tests (`mistral.test.ts`)

Same cases as `openai.test.ts`:
- Non-streaming happy path with `usage.promptTokens` and `usage.completionTokens`
- Streaming with usage on final chunk
- Error path
- Content capture disabled
- `enabled = false`
- `highSecurity = true`

---

## Wrapper 3: Cohere

### Step 3a — Add Cohere pricing

```typescript
// ---- Cohere ----
'command-r-plus': {
  inputPerMTok: 2.5,
  outputPerMTok: 10,
  contextWindow: 128_000,
},
'command-r': {
  inputPerMTok: 0.15,
  outputPerMTok: 0.6,
  contextWindow: 128_000,
},
'command': {
  inputPerMTok: 0.5,
  outputPerMTok: 1.5,
  contextWindow: 4_000,
},
'command-light': {
  inputPerMTok: 0.3,
  outputPerMTok: 0.6,
  contextWindow: 4_000,
},
```

### Step 3b — Add peer + dev dependency

```json
"cohere-ai": ">=7.0.0"
```

### Step 3c — Create `packages/nr-ai-agent/src/wrappers/cohere.ts`

The Cohere SDK provides `client.chat({ model, message, chatHistory })` (non-streaming) and `client.chatStream({ model, message, chatHistory })` (streaming).

#### Key differences

1. **Provider is `'cohere'`**.
2. **SDK import**: `import type { CohereClient } from 'cohere-ai';`
3. **Non-streaming**: `client.chat()` returns a `NonStreamedChatResponse`
   - `response.meta?.tokens?.inputTokens`, `response.meta?.tokens?.outputTokens`
   - `response.finishReason` (values: `'COMPLETE'`, `'MAX_TOKENS'`, `'ERROR'`, `'ERROR_TOXIC'`, `'USER_CANCEL'`, `'STOP_SEQUENCE'`)
4. **Streaming**: `client.chatStream()` returns a `ChatStream` (async iterable)
   - `event.eventType === 'text-generation'` for text chunks (`event.text`)
   - `event.eventType === 'stream-end'` for final response with `event.response.meta.tokens`
5. **Message format**: Cohere uses a flat `message` string for the user turn, plus `chatHistory` for context.

#### `extractLastUserMessage()`

```typescript
function extractLastUserMessage(input: { message: string }): string {
  return input.message;
}
```

#### `extractSystemPromptLength()`

```typescript
function extractSystemPromptLength(input: { preamble?: string }): number | null {
  return input.preamble ? input.preamble.length : null;
}
```

#### `mapStopReason()`

```typescript
function mapStopReason(finishReason: string | undefined): string | null {
  if (!finishReason) return null;
  const map: Record<string, string> = {
    COMPLETE: 'end_turn',
    MAX_TOKENS: 'max_tokens',
    STOP_SEQUENCE: 'end_turn',
    ERROR: 'error',
    ERROR_TOXIC: 'content_filter',
  };
  return map[finishReason] ?? finishReason.toLowerCase();
}
```

#### Public export

```typescript
export function wrapCohereClient(
  client: CohereClient,
  config: WrapperConfig,
  onRecord: RecordHandler,
): CohereClient {
  if (!config.enabled) return client;

  const originalChat = client.chat.bind(client);
  const originalChatStream = client.chatStream.bind(client);

  client.chat = wrapChat(originalChat, config, onRecord);
  client.chatStream = wrapChatStream(originalChatStream, config, onRecord);

  return client;
}
```

`wrapChat` and `wrapChatStream` follow the same pattern as the other wrappers.

#### Tests (`cohere.test.ts`)

Same structure as OpenAI and Mistral tests. Key additions:
- `mapStopReason('COMPLETE')` → `'end_turn'`
- `mapStopReason('MAX_TOKENS')` → `'max_tokens'`
- `mapStopReason('ERROR_TOXIC')` → `'content_filter'`
- Token counts from `response.meta.tokens.inputTokens` / `outputTokens`
- Streaming: token counts from `stream-end` event

---

## Step 4 — Export all three wrappers from `nr-ai-agent`

In `packages/nr-ai-agent/src/agent.ts`, add exports:

```typescript
export { wrapBedrockClient } from './wrappers/bedrock.js';
export { wrapMistralClient } from './wrappers/mistral.js';
export { wrapCohereClient } from './wrappers/cohere.js';
```

---

## Acceptance criteria

### All three wrappers
- [ ] `npm run build` passes with no TypeScript errors
- [ ] `npm test` passes — all new test files pass
- [ ] `wrapBedrockClient`, `wrapMistralClient`, `wrapCohereClient` are exported from `nr-ai-agent`
- [ ] Non-streaming and streaming paths both call `onRecord` exactly once per request
- [ ] Error paths call `onRecord` and re-throw
- [ ] `config.enabled = false` returns client unmodified
- [ ] `highSecurity = true` forces all content fields to null
- [ ] `record.provider` is `'bedrock'`, `'mistral'`, `'cohere'` respectively
- [ ] Token counts are correctly extracted from each SDK's response shape
- [ ] All new models appear in `DEFAULT_PRICING_TABLE` with positive prices
- [ ] `npm run lint` passes

### Bedrock specifically
- [ ] Non-Converse commands pass through unmodified (no interception)
- [ ] Streaming token counts come from the `metadata` event, not accumulated delta count

### Cohere specifically
- [ ] `mapStopReason` correctly normalizes Cohere finish reasons
- [ ] `preamble` (system prompt) length is captured when present

---

## File checklist

Files to **create**:

```
packages/nr-ai-agent/src/wrappers/bedrock.ts
packages/nr-ai-agent/src/wrappers/bedrock.test.ts
packages/nr-ai-agent/src/wrappers/mistral.ts
packages/nr-ai-agent/src/wrappers/mistral.test.ts
packages/nr-ai-agent/src/wrappers/cohere.ts
packages/nr-ai-agent/src/wrappers/cohere.test.ts
```

Files to **modify**:

```
packages/shared/src/pricing-data.ts   — add Bedrock, Mistral, Cohere model entries
packages/nr-ai-agent/src/agent.ts     — export 3 new wrappers
packages/nr-ai-agent/package.json     — add 3 peer + dev dependencies
```
