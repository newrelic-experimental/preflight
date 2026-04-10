# New Relic AI Agent — Implementation Plan

> Derived from [NEW_AGENT_IDEATION.md](./NEW_AGENT_IDEATION.md). Each numbered item is a self-contained block of Claude session work with implementation and testing criteria.

---

## Table of Contents

- [Phase 0: Project Bootstrap](#phase-0-project-bootstrap)
- [Phase 1: Foundation (4-6 weeks)](#phase-1-foundation-4-6-weeks)
- [Phase 2: Deep Observability (4-6 weeks)](#phase-2-deep-observability-4-6-weeks)
- [Phase 3: Agentic Intelligence (4-6 weeks)](#phase-3-agentic-intelligence-4-6-weeks)
- [Phase 4: Intelligence & Prediction (6-8 weeks)](#phase-4-intelligence--prediction-6-8-weeks)

---

## Phase 0: Project Bootstrap

> Prerequisites that must exist before any feature work begins. These are shared infrastructure that every subsequent task depends on.

### 0.1 — TypeScript & Build Infrastructure

**Implementation:**
- Create `tsconfig.base.json` at monorepo root with shared compiler settings (`strict: true`, `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `declaration: true`, `declarationMap: true`, `sourceMap: true`, `outDir: dist`)
- Create per-package `tsconfig.json` files in `packages/shared`, `packages/nr-ai-agent`, `packages/nr-ai-mcp-server`, and `packages/test-app` that extend the base config and set `rootDir`, `outDir`, and project references
- Configure composite project references so `tsc --build` compiles in dependency order (shared -> nr-ai-agent -> test-app)
- Add `"type": "module"` to each `package.json` or configure appropriate module settings for ESM/CJS interop
- Verify `npm run build` from the monorepo root compiles all packages without errors

**Testing:**
- Create a trivial `src/index.ts` in each package that exports a placeholder (e.g., `export const VERSION = '0.1.0'`)
- Run `npm run build` from root — all packages compile, `dist/` directories are created with `.js`, `.d.ts`, and `.js.map` files
- Verify project references resolve: `nr-ai-agent` can import from `@nr-ai-observatory/shared`
- Verify `test-app` can import from `nr-ai-agent`

---

### 0.2 — Test Infrastructure (Jest + TypeScript)

**Implementation:**
- Install `jest`, `ts-jest`, `@types/jest` as devDependencies at the monorepo root
- Create `jest.config.base.ts` at the root with shared settings (`preset: ts-jest`, `testEnvironment: node`, `testMatch: ['**/*.test.ts']`, coverage thresholds)
- Create per-package `jest.config.ts` that extends the base
- Add `packages/*/src/**/*.test.ts` pattern for co-located tests
- Add `packages/*/test/` directories for integration tests
- Configure `npm run test` at root to run all package tests via workspaces
- Add coverage reporting (`--coverage` with `lcov` + `text` reporters)

**Testing:**
- Write a trivial test in `packages/shared/src/index.test.ts` that asserts `VERSION === '0.1.0'`
- Run `npm test` from root — test passes, coverage report is generated
- Verify tests can import from the package source (not `dist/`)

---

### 0.3 — Linting & Formatting

**Implementation:**
- Install `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `prettier`, `eslint-config-prettier` as root devDependencies
- Create `.eslintrc.cjs` (or `eslint.config.mjs` for flat config) with TypeScript rules, no-unused-vars as error, no-explicit-any as warn
- Create `.prettierrc` with project-wide formatting settings (single quotes, trailing commas, 100 char print width — or team preference)
- Add `npm run lint` and `npm run format` scripts
- Add `.eslintignore` to exclude `dist/`, `node_modules/`, `coverage/`

**Testing:**
- Run `npm run lint` — passes cleanly on placeholder source files
- Intentionally introduce a lint error (unused variable) — verify it's caught
- Run `npm run format` — verify formatting is applied consistently

---

### 0.4 — Shared Package: Logger Utility

**Implementation:**
- Create `packages/shared/src/logger.ts`
- Implement a simple structured logger with levels: `debug`, `info`, `warn`, `error`
- Support configurable log level via `NEW_RELIC_AI_LOG_LEVEL` env var (default: `info`)
- Output structured JSON to stderr (so it doesn't interfere with stdout data)
- Include timestamp, level, component name, and message in each log entry
- Export `createLogger(component: string)` factory function

**Testing:**
- Unit test: `createLogger('test')` produces a logger with all 4 level methods
- Unit test: log level filtering — setting level to `warn` suppresses `debug` and `info`
- Unit test: output format is valid JSON with expected fields
- Unit test: `NEW_RELIC_AI_LOG_LEVEL` env var is respected

---

### 0.5 — Shared Package: Configuration Loader

**Implementation:**
- Create `packages/shared/src/config.ts`
- Define a `AgentConfig` TypeScript interface covering all config fields from Section 6 of the ideation doc:
  - `licenseKey` (required), `appName` (required), `enabled`, `recordContent`, `costTrackingEnabled`, `qualityTrackingEnabled`, `conversationTrackingEnabled`, `thinkingTrackingEnabled`, `customPricingFile`, `contentMaxLength`, `highSecurity`, `logLevel`, `collectorHost`
- Implement `loadConfig()` that reads from environment variables (`NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_APP_NAME`, etc.) with sensible defaults
- Validate required fields and throw clear error messages for missing config
- Support `NEW_RELIC_AI_HIGH_SECURITY=true` which forces `recordContent=false`
- Freeze the returned config object to prevent mutation

**Testing:**
- Unit test: all env vars map correctly to config fields
- Unit test: missing `NEW_RELIC_LICENSE_KEY` throws with a descriptive message
- Unit test: `highSecurity=true` forces `recordContent=false` even if explicitly set
- Unit test: default values are correct (e.g., `enabled=true`, `recordContent=false` per design decision #2)
- Unit test: returned config is frozen (`Object.isFrozen`)

---

## Phase 1: Foundation (4-6 weeks)

> **Goal**: Ship a working agent that tracks Claude and Gemini API calls with cost.

### 1.1 — TypeScript SDK Wrapping: Anthropic Claude (`@anthropic-ai/sdk`)

**Implementation:**
- Create `packages/nr-ai-agent/src/wrappers/anthropic.ts`
- Implement a `wrapAnthropicClient(client: Anthropic)` function that uses ES6 Proxy or direct method replacement to intercept:
  - `client.messages.create()` — non-streaming completion calls
  - `client.messages.stream()` — streaming completion calls (returns an async iterable)
- For `messages.create()`:
  - Capture pre-call: timestamp, `params.model`, `params.max_tokens`, `params.system`, `params.tools` (names only), `params.thinking` config (if present), message count
  - Capture post-call: `response.usage` (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens), `response.stop_reason`, `response.model`, content block types (text, tool_use, thinking), wall-clock duration
  - If `recordContent` is enabled: capture system prompt text, last user message text, and response text (truncated to `contentMaxLength`)
- For `messages.stream()`:
  - Return a transparent async generator wrapper that re-yields each chunk unmodified
  - Measure time-to-first-token (TTFT): delta between request start and the first `content_block_delta` event containing text
  - Accumulate final `usage` from the `message_stop` / final event
  - Propagate `AbortSignal` so cancellation works correctly
  - Use `try/finally` to ensure the span always closes even on error or cancellation
- Store captured data in a structured `AiRequestRecord` object (defined in 1.2) and pass it to the event buffer (defined in 0.5 / 1.7)
- The wrapper must be non-invasive: if the agent is disabled (`enabled=false`), `wrapAnthropicClient` returns the client unmodified
- The wrapper must not swallow exceptions — all errors from the underlying SDK propagate to the caller unchanged

**Testing:**
- Unit test: wrap a mock Anthropic client; call `messages.create()` with a fake response; verify all fields are captured in the `AiRequestRecord`
- Unit test: wrap a mock streaming client; yield 5 chunks then a final event with usage; verify TTFT is measured, total tokens are accumulated, and all chunks are re-yielded unmodified
- Unit test: when `AbortSignal` is triggered mid-stream, the wrapper closes cleanly and the span is finalized
- Unit test: when the underlying call throws (e.g., 429 rate limit), the error propagates and an error record is still captured
- Unit test: when `enabled=false`, the original client is returned (no proxy, no overhead)
- Unit test: when `recordContent=false`, no prompt/response text is captured but all numeric metrics are
- Unit test: when `highSecurity=true`, content fields are always empty regardless of `recordContent`
- Integration test (in `test-app`): call the real Anthropic SDK with a wrapped client, verify the request completes normally and an `AiRequestRecord` is produced (requires `ANTHROPIC_API_KEY`; skip in CI if not set)

---

### 1.2 — TypeScript SDK Wrapping: Google Gemini (`@google/genai`)

**Implementation:**
- Create `packages/nr-ai-agent/src/wrappers/gemini.ts`
- Add `@google/genai` as a peerDependency in `packages/nr-ai-agent/package.json` (optional peer — the wrapper only activates if the SDK is installed)
- Implement `wrapGeminiClient(client: GoogleGenAI)` that intercepts:
  - `client.models.generateContent()` — non-streaming content generation
  - `client.models.generateContentStream()` — streaming content generation
  - `client.models.embedContent()` — embedding calls
- For `generateContent()`:
  - Capture pre-call: timestamp, model name, generation config (temperature, topP, topK, maxOutputTokens), tool declarations (names only), safety settings
  - Capture post-call: `response.usageMetadata` (promptTokenCount, candidatesTokenCount, totalTokenCount, thoughtsTokenCount if present), `finishReason`, safety ratings per category, wall-clock duration
  - If grounding metadata is present (Google Search grounding), capture: `searchEntryPoint`, `groundingChunks` count, `groundingSupports` count
  - If `recordContent` is enabled: capture last user message and response text (truncated to `contentMaxLength`)
- For `generateContentStream()`:
  - Transparent async generator wrapper (same pattern as Anthropic wrapper in 1.1)
  - Measure TTFT from first chunk with text content
  - Accumulate usage metadata from the final chunk
  - Propagate abort/cancellation correctly
- For `embedContent()`:
  - Capture model, input token count, embedding dimensions, wall-clock duration
  - Store as a separate `AiEmbeddingRecord` event type
- All captured data flows into the same event buffer as the Anthropic wrapper
- Same non-invasive behavior: disabled agent returns client unmodified, errors always propagate

**Testing:**
- Unit test: wrap a mock Gemini client; call `generateContent()` with a fake response; verify all fields captured including `usageMetadata`, `finishReason`, and safety ratings
- Unit test: streaming wrapper re-yields all chunks, measures TTFT, accumulates usage from final chunk
- Unit test: `embedContent()` produces an `AiEmbeddingRecord` with correct dimensions and token count
- Unit test: safety ratings are captured per category (harassment, hate speech, sexually explicit, dangerous content, civic integrity)
- Unit test: grounding metadata is captured when present, and fields are absent when grounding is not used
- Unit test: Gemini thinking tokens (`thoughtsTokenCount`) are captured when present (Gemini 2.5 models)
- Unit test: errors propagate, abort signals work, disabled agent returns unwrapped client
- Unit test: `recordContent=false` suppresses text but not numeric metrics
- Integration test (in `test-app`): call real Gemini SDK with wrapped client, verify normal operation and record production (requires `GOOGLE_API_KEY`; skip in CI if not set)

---

### 1.3 — Basic Event Types: `AiRequest`, `AiResponse`, `AiMessage`

**Implementation:**
- Create `packages/shared/src/events/types.ts`
- Define TypeScript interfaces for the core event types that both wrappers produce:
  - **`AiRequest`** — one per API call, captures the request side:
    - `id` (UUID v4), `timestamp` (epoch ms), `provider` (`'anthropic' | 'google'`), `model`, `requestMethod` (`'messages.create' | 'messages.stream' | 'generateContent' | 'generateContentStream' | 'embedContent'`)
    - `maxTokens`, `temperature`, `topP`, `systemPromptLength` (token estimate or char count), `messageCount`, `toolCount`, `toolNames` (string array)
    - `thinkingEnabled` (boolean), `thinkingBudgetTokens` (number | null)
    - `streamingEnabled` (boolean)
    - Custom attributes: `nr.appName`, `nr.entityGuid` (if known), user-provided tags (feature, team, user)
  - **`AiResponse`** — one per API call, captures the response side:
    - `id` (same UUID as the paired `AiRequest`), `timestamp`, `provider`, `model` (actual model returned, may differ from requested)
    - `durationMs`, `timeToFirstTokenMs` (null if non-streaming), `tokensPerSecond`
    - `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalTokens`
    - `costInputUsd`, `costOutputUsd`, `costThinkingUsd`, `costCacheReadUsd`, `costCacheCreationUsd`, `costTotalUsd`
    - `stopReason`, `contentBlockTypes` (array of block type strings)
    - `error` (null or `{ type, message, statusCode }`)
  - **`AiMessage`** — optional, only when `recordContent=true`, captures message content:
    - `id` (same UUID), `timestamp`, `role` (`'system' | 'user' | 'assistant'`), `content` (truncated string), `contentLength` (original length before truncation), `sequence` (0-indexed position in the message array)
- Create `packages/shared/src/events/factory.ts`
  - Implement `createAiRequest(params)`, `createAiResponse(params)`, `createAiMessage(params)` factory functions that generate IDs and set timestamps
  - Validate required fields at construction time
- All event types must include a `toNrEvent()` method or serializer that converts to the flat key-value format expected by New Relic's Events API (dot-separated attribute names, string/number values only, no nested objects)

**Testing:**
- Unit test: `createAiRequest()` generates a valid UUID, sets timestamp to current time, and includes all required fields
- Unit test: `createAiResponse()` with all token fields correctly set; `totalTokens` is computed as `inputTokens + outputTokens + thinkingTokens`
- Unit test: `createAiMessage()` truncates content to `contentMaxLength` and preserves `contentLength` as the original
- Unit test: `toNrEvent()` serialization produces flat key-value pairs with no nested objects, all keys are dot-separated strings, values are strings or numbers
- Unit test: factory functions throw on missing required fields (e.g., `AiRequest` without `model`)
- Unit test: `AiMessage` events are not created when `recordContent=false`
- Unit test: paired `AiRequest` and `AiResponse` share the same `id`

---

### 1.4 — Token Tracking (Input, Output, Thinking, Cache)

**Implementation:**
- Create `packages/shared/src/tokens.ts`
- Implement a `TokenUsage` interface and `extractTokenUsage()` functions per provider:
  - **`extractAnthropicTokens(response)`**: extracts from Anthropic's `response.usage` object:
    - `input_tokens` -> `inputTokens`
    - `output_tokens` -> `outputTokens`
    - `cache_creation_input_tokens` -> `cacheCreationTokens` (may be undefined)
    - `cache_read_input_tokens` -> `cacheReadTokens` (may be undefined)
    - Thinking tokens: iterate `response.content` blocks, sum token counts from blocks where `type === 'thinking'` (or use `response.usage` fields if available in newer SDK versions)
    - Compute `totalTokens = inputTokens + outputTokens + thinkingTokens`
  - **`extractGeminiTokens(response)`**: extracts from Gemini's `response.usageMetadata`:
    - `promptTokenCount` -> `inputTokens`
    - `candidatesTokenCount` -> `outputTokens`
    - `thoughtsTokenCount` -> `thinkingTokens` (Gemini 2.5, may be undefined)
    - `cachedContentTokenCount` -> `cacheReadTokens` (may be undefined)
    - `totalTokenCount` -> `totalTokens`
  - **`extractStreamTokens(finalChunk, provider)`**: same extraction but from the final streaming chunk/event
- Handle missing/undefined fields gracefully — default to 0, never NaN
- Implement `TokenAccumulator` class for streaming: call `.addChunk(chunk)` per stream event, call `.finalize()` to get the final `TokenUsage` after the stream ends
- The `TokenAccumulator` should detect the "final" chunk pattern per provider (Anthropic: `message_stop` event or `type === 'message'` in the final delta; Gemini: last chunk with `usageMetadata`)

**Testing:**
- Unit test: `extractAnthropicTokens()` correctly maps all fields from a real-shaped Anthropic response (with and without cache tokens, with and without thinking)
- Unit test: `extractGeminiTokens()` correctly maps all fields from a real-shaped Gemini response (with and without thinking tokens)
- Unit test: missing optional fields (cache tokens, thinking tokens) default to 0, not `undefined` or `NaN`
- Unit test: `TokenAccumulator` fed a sequence of Anthropic stream chunks produces the correct final `TokenUsage`
- Unit test: `TokenAccumulator` fed a sequence of Gemini stream chunks produces the correct final `TokenUsage`
- Unit test: `totalTokens` is always the sum of `inputTokens + outputTokens + thinkingTokens`
- Unit test: edge case — empty response (0 tokens) produces a valid `TokenUsage` with all zeros

---

### 1.5 — Cost Calculation with Built-in Pricing Table

**Implementation:**
- Create `packages/shared/src/pricing.ts`
- Define a `ModelPricing` interface:
  ```
  { inputPerMTok: number, outputPerMTok: number, thinkingPerMTok?: number,
    cacheReadPerMTok?: number, cacheCreationPerMTok?: number, contextWindow: number }
  ```
- Ship a built-in `DEFAULT_PRICING_TABLE: Record<string, ModelPricing>` covering current models:
  - Anthropic: `claude-sonnet-4-20250514`, `claude-opus-4-20250514`, `claude-haiku-3-5-20241022` (and alias patterns like `claude-sonnet-4` -> latest dated version)
  - Google: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`
  - Include tiered pricing where applicable (e.g., Gemini 2.5 Pro has different rates above 200k context)
- Implement model name resolution: `resolveModelPricing(modelName: string): ModelPricing | null`
  - Exact match first, then prefix match (e.g., `claude-sonnet-4-20250514` matches `claude-sonnet-4`)
  - Return `null` for unknown models (cost will be reported as 0 with a warning log)
- Implement `calculateCost(model: string, usage: TokenUsage): CostBreakdown`
  - Returns: `{ inputUsd, outputUsd, thinkingUsd, cacheReadUsd, cacheCreationUsd, totalUsd }`
  - All values in USD, calculated as `tokens * pricePerMTok / 1_000_000`
  - Implement `savingsFromCacheUsd`: `cacheReadTokens * (fullInputPrice - cacheReadPrice) / 1_000_000`
- Support custom pricing file override via `NEW_RELIC_AI_CUSTOM_PRICING_FILE`:
  - Load JSON file at startup, merge with (and override) the built-in table
  - Log a warning if the file is invalid JSON or has unknown model names
- Create `packages/shared/src/pricing-data.ts` (or `.json`) as the actual pricing data, separate from logic so it's easy to update

**Testing:**
- Unit test: `calculateCost()` for `claude-sonnet-4` with 1000 input, 500 output, 200 thinking tokens — verify exact USD values against known pricing
- Unit test: `calculateCost()` for `gemini-2.5-flash` with thinking tokens — verify thinking cost uses the correct thinking rate
- Unit test: cache cost calculation — `cacheReadUsd` uses discounted rate, `cacheCreationUsd` uses premium rate, `savingsFromCacheUsd` is correctly computed
- Unit test: `resolveModelPricing()` with exact model name, prefix-matched name, and unknown model name
- Unit test: unknown model returns `null` and `calculateCost()` returns all-zero `CostBreakdown` with a logged warning
- Unit test: custom pricing file overrides built-in prices for specified models and leaves others unchanged
- Unit test: custom pricing file with invalid JSON logs a warning and falls back to built-in table
- Unit test: all costs are non-negative, `totalUsd` equals the sum of components
- Unit test: Gemini tiered pricing — verify that >200k context pricing is applied when input tokens exceed the tier threshold

---

### 1.6 — Latency Metrics (Total Duration, TTFT for Streaming)

**Implementation:**
- Create `packages/shared/src/timing.ts`
- Implement a `RequestTimer` class that captures all latency dimensions from Section 4.1 of the ideation doc:
  - `start()` — record `performance.now()` (or `process.hrtime.bigint()`) at request initiation
  - `markFirstToken()` — record timestamp when first content token arrives (streaming only)
  - `markThinkingStart()` / `markThinkingEnd()` — bracket the thinking phase (if detectable from stream events)
  - `stop()` — record final timestamp
  - `getMetrics()` returns:
    - `durationMs`: total wall-clock time (`stop - start`)
    - `timeToFirstTokenMs`: time to first content token (`firstToken - start`), null if non-streaming
    - `thinkingDurationMs`: time spent in thinking phase (`thinkingEnd - thinkingStart`), null if no thinking
    - `generationDurationMs`: time generating output excluding thinking (`durationMs - thinkingDurationMs`)
    - `tokensPerSecond`: `outputTokens / (durationMs / 1000)` (requires token count to be passed in)
    - `overheadMs`: `durationMs - thinkingDurationMs - generationDurationMs` (SDK/network overhead estimate)
- Use `performance.now()` for sub-millisecond precision (not `Date.now()`)
- Integrate `RequestTimer` into both the Anthropic and Gemini wrappers (from 1.1 and 1.2):
  - Non-streaming: `start()` before call, `stop()` after response
  - Streaming: `start()` before call, `markFirstToken()` on first content chunk, detect thinking boundaries from stream event types, `stop()` when stream ends
- For Anthropic streaming: detect thinking phase from `content_block_start` with `type: 'thinking'` and `content_block_stop` for the same block index
- For Gemini streaming: detect thinking from `thoughtsTokenCount` incrementing between chunks (or dedicated thought events if available)

**Testing:**
- Unit test: `RequestTimer` with `start()` then `stop()` produces a valid `durationMs` > 0
- Unit test: `markFirstToken()` between `start()` and `stop()` produces a valid `timeToFirstTokenMs` between 0 and `durationMs`
- Unit test: thinking brackets produce valid `thinkingDurationMs`; `generationDurationMs = durationMs - thinkingDurationMs`
- Unit test: `tokensPerSecond` calculation is correct (e.g., 100 tokens in 2000ms = 50 tokens/sec)
- Unit test: non-streaming call — `timeToFirstTokenMs` is `null`, `thinkingDurationMs` is `null` (unless thinking is detectable from response structure)
- Unit test: `getMetrics()` before `stop()` throws an error
- Unit test: calling `markFirstToken()` multiple times only records the first invocation
- Integration test: time a real (or mocked) streaming response and verify TTFT is within a reasonable range of the simulated delay

---

### 1.7 — New Relic Collector Transport (Preconnect, Connect, Protocol v17)

**Implementation:**
- Create `packages/shared/src/transport/collector.ts`
- Implement the New Relic collector handshake sequence following agent protocol v17:
  1. **Preconnect** — `POST` to `https://collector.newrelic.com/agent_listener/invoke_raw_method?method=preconnect` with license key header. Response returns the assigned collector host (e.g., `collector-42.newrelic.com`)
  2. **Connect** — `POST` to the assigned collector host with agent metadata (app name, language `nodejs`, agent version, host info, PID, settings). Response returns `agent_run_id` — required for all subsequent data submissions
  3. **Data submission** — Use the `agent_run_id` to send event data, metric data, and custom events
- Alternatively (simpler initial path): use the **New Relic Events API** directly (`https://insights-collector.newrelic.com/v1/accounts/{account_id}/events`) and the **Metric API** (`https://metric-api.newrelic.com/metric/v1`) which only require the license key — no handshake needed
  - Start with the Events API + Metric API (simpler, no handshake state machine)
  - Implement the full collector protocol as a follow-up if needed for server-side config or session management
- Create `packages/shared/src/transport/events-api.ts`:
  - `sendEvents(events: NrEvent[], licenseKey: string)` — POST to Events API with gzip compression, `Content-Type: application/json`, `Api-Key` header
  - Handle response codes: 200 (success), 400 (bad request — log and drop), 403 (invalid key — log and disable), 408/429 (backoff and retry)
  - Implement exponential backoff with jitter for retryable errors (max 3 retries, base delay 1s, max delay 30s)
- Create `packages/shared/src/transport/metric-api.ts`:
  - `sendMetrics(metrics: NrMetric[], licenseKey: string)` — POST to Metric API in the expected format (`[{ metrics: [...] }]`)
  - Same error handling and retry logic as Events API
- Support EU region: detect from license key format (EU keys contain `EU` region indicator) or from `NEW_RELIC_HOST` env var; route to `insights-collector.eu01.nr-data.net` and `metric-api.eu.newrelic.com`
- Use Node.js native `fetch` (available in Node 18+) or `undici` — no heavy HTTP client dependency
- Implement gzip compression for all payloads using `zlib.gzip()`

**Testing:**
- Unit test: `sendEvents()` serializes events to JSON, sends with correct headers (`Api-Key`, `Content-Type`, `Content-Encoding: gzip`)
- Unit test: mock HTTP — 200 response returns success
- Unit test: mock HTTP — 429 response triggers retry with exponential backoff (verify delay pattern)
- Unit test: mock HTTP — 403 response logs an error and does not retry
- Unit test: mock HTTP — network error triggers retry
- Unit test: max retry limit (3) is respected; after 3 failures, the batch is dropped with a warning log
- Unit test: EU region detection routes to EU endpoints
- Unit test: gzip compression is applied to the payload (verify `Content-Encoding` header)
- Unit test: `sendMetrics()` formats payload in NR Metric API expected structure
- Integration test: send a test custom event to the real NR Events API and verify it appears in NRQL query (requires `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_ACCOUNT_ID`; skip in CI if not set)

---

### 1.8 — Event Buffer with Two-Tier Harvest (60s Metrics, 5s Events)

**Implementation:**
- Create `packages/shared/src/harvest/event-buffer.ts`
- Implement `EventBuffer` class with reservoir sampling (same pattern used by all NR agents):
  - `add(event: NrEvent)` — add an event to the buffer
  - If buffer is full (configurable max, default 1000), use reservoir sampling to decide whether to keep the new event (replace a random existing event with probability `maxSize / totalSeen`)
  - This ensures a statistically representative sample even under high throughput
- Implement `MetricAggregator` class:
  - `record(name: string, value: number, attributes: Record<string, string | number>)` — record a metric data point
  - Aggregation: for each unique `(name, attributes)` key, maintain `count`, `sum`, `min`, `max`, `sumOfSquares` over the harvest interval
  - `harvest()` — snapshot current aggregated metrics, reset accumulators, return the snapshot
- Create `packages/shared/src/harvest/harvest-scheduler.ts`
- Implement `HarvestScheduler` class:
  - Two independent timers:
    - **Events harvest**: every 5 seconds — flush `EventBuffer`, send via Events API
    - **Metrics harvest**: every 60 seconds — flush `MetricAggregator`, send via Metric API
  - `start()` — begin both harvest cycles using `setInterval`
  - `stop()` — clear both intervals, perform a final flush of both buffers (graceful shutdown)
  - Snapshot-and-reset at harvest time: take the current buffer contents atomically, reset the buffer, then send the snapshot asynchronously. This ensures no data loss if the send fails (the snapshot can be retried)
  - If a send fails after retries, log a warning with the number of dropped events/metrics
- Integrate with the transport layer (1.7): `HarvestScheduler` depends on `sendEvents()` and `sendMetrics()`
- Register `process.on('beforeExit')` and `process.on('SIGTERM')` to trigger a final flush on shutdown

**Testing:**
- Unit test: `EventBuffer.add()` stores events up to max size
- Unit test: reservoir sampling — add 2000 events to a buffer of size 1000; verify buffer contains exactly 1000 events and the sampling is roughly uniform (statistical test with tolerance)
- Unit test: `MetricAggregator.record()` correctly computes count, sum, min, max across multiple data points for the same metric name
- Unit test: `MetricAggregator.harvest()` returns the snapshot and resets — subsequent harvest returns empty
- Unit test: `HarvestScheduler` fires events harvest at ~5s intervals and metrics harvest at ~60s intervals (use fake timers / `jest.useFakeTimers()`)
- Unit test: `stop()` triggers a final flush — verify both buffers are emptied and send functions are called
- Unit test: snapshot-and-reset is atomic — events added during send are captured in the next harvest, not lost
- Unit test: if `sendEvents()` fails, the dropped count is logged but the scheduler continues operating

---

### 1.9 — Error Tracking with Retry/Status Code Classification

**Implementation:**
- Create `packages/shared/src/errors.ts`
- Define an `AiErrorClassification` enum covering all error types from Section 4.6 of the ideation doc:
  - `RATE_LIMIT` (HTTP 429)
  - `OVERLOADED` (HTTP 529 for Anthropic, HTTP 503 for Gemini)
  - `CONTENT_POLICY` (HTTP 400 with content policy error type)
  - `CONTEXT_LENGTH_EXCEEDED` (HTTP 400 with context length error type)
  - `AUTHENTICATION` (HTTP 401, 403)
  - `NOT_FOUND` (HTTP 404 — invalid model or endpoint)
  - `TIMEOUT` (request timed out, no HTTP response)
  - `SERVER_ERROR` (HTTP 500, 502)
  - `NETWORK_ERROR` (connection refused, DNS failure, etc.)
  - `UNKNOWN` (catch-all)
- Implement `classifyError(error: unknown, provider: 'anthropic' | 'google'): AiErrorClassification`:
  - For Anthropic SDK errors: inspect `error.status` and `error.error.type` (e.g., `overloaded_error`, `rate_limit_error`, `invalid_request_error`)
  - For Gemini SDK errors: inspect `error.status` and `error.message` patterns
  - For generic errors: inspect `error.code` (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`)
- Implement `AiErrorRecord` event type:
  - `id` (same UUID as the paired request), `timestamp`, `provider`, `model`
  - `classification` (from enum above)
  - `httpStatusCode` (number or null)
  - `errorType` (provider-specific error type string)
  - `errorMessage` (truncated to 1024 chars)
  - `retryable` (boolean — true for rate limit, overloaded, timeout, server error)
  - `retryCount` (number of retries attempted before this error, if known)
- Extract rate limit headers when available:
  - Anthropic: `anthropic-ratelimit-tokens-remaining`, `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-tokens-reset`
  - Gemini: standard rate limit headers if present
  - Store these as `rateLimitTokensRemaining`, `rateLimitRequestsRemaining` on the `AiErrorRecord`
- Integrate error classification into both wrappers (1.1, 1.2): when a call throws, classify the error and emit an `AiErrorRecord` in addition to the `AiResponse` with the error field set

**Testing:**
- Unit test: `classifyError()` with an Anthropic 429 error -> `RATE_LIMIT`
- Unit test: `classifyError()` with an Anthropic 529 error -> `OVERLOADED`
- Unit test: `classifyError()` with an Anthropic `invalid_request_error` about context length -> `CONTEXT_LENGTH_EXCEEDED`
- Unit test: `classifyError()` with a Gemini 503 error -> `OVERLOADED`
- Unit test: `classifyError()` with a Gemini 400 content policy error -> `CONTENT_POLICY`
- Unit test: `classifyError()` with a generic `ECONNREFUSED` -> `NETWORK_ERROR`
- Unit test: `classifyError()` with a timeout error -> `TIMEOUT`
- Unit test: `classifyError()` with an unrecognized error -> `UNKNOWN`
- Unit test: `AiErrorRecord` correctly captures rate limit headers when present
- Unit test: `retryable` flag is `true` for rate limit, overloaded, timeout, server error; `false` for auth, content policy, context length
- Unit test: error message is truncated to 1024 characters

---

### 1.10 — Agent Entry Point & Initialization API

**Implementation:**
- Create `packages/nr-ai-agent/src/index.ts` — the main entry point exported by the package
- Implement the public API surface:
  ```typescript
  // Primary API — initialize the agent, returns wrapper functions
  export function init(options?: Partial<AgentConfig>): NrAiAgent;

  // Convenience — wrap an Anthropic client
  export function wrapAnthropicClient(client: Anthropic): Anthropic;

  // Convenience — wrap a Gemini client
  export function wrapGeminiClient(client: GoogleGenAI): GoogleGenAI;
  ```
- The `init()` function:
  1. Loads configuration (merging env vars + passed options, via config loader from 0.5)
  2. Validates the license key and app name
  3. Initializes the logger (from 0.4)
  4. Loads the pricing table (from 1.5), merging custom pricing file if configured
  5. Creates the `EventBuffer` and `MetricAggregator` (from 1.8)
  6. Creates the transport layer (from 1.7)
  7. Starts the `HarvestScheduler` (from 1.8)
  8. Returns an `NrAiAgent` instance with methods: `wrapAnthropicClient()`, `wrapGeminiClient()`, `shutdown()`, `getStats()`
- `shutdown()` — stops the harvest scheduler, performs final flush, cleans up resources. Returns a `Promise<void>` that resolves when the final flush is complete
- `getStats()` — returns current agent statistics: events buffered, events sent, events dropped, metrics recorded, uptime
- Singleton guard: calling `init()` twice logs a warning and returns the existing instance (do not create duplicate harvest loops)
- If `enabled=false` in config, `init()` returns a no-op agent where all wrapper methods return the client unchanged and no background processes run
- Register `process.on('beforeExit')` and `SIGTERM`/`SIGINT` handlers to call `shutdown()` automatically

**Testing:**
- Unit test: `init()` with valid config returns an `NrAiAgent` with all expected methods
- Unit test: `init()` with missing license key throws a clear error
- Unit test: `init()` with `enabled=false` returns a no-op agent; `wrapAnthropicClient()` returns the original client
- Unit test: calling `init()` twice returns the same instance and logs a warning
- Unit test: `shutdown()` stops the harvest scheduler and triggers a final flush
- Unit test: `getStats()` reflects the number of events added and sent
- Integration test (in `test-app`): full lifecycle — `init()` -> wrap a client -> make a call -> verify events are buffered -> `shutdown()` -> verify final flush
- Integration test: SIGTERM handler triggers shutdown (send SIGTERM to the process and verify flush occurs)

---

### 1.11 — Pre-Built Dashboard: "AI Overview"

**Implementation:**
- Create `packages/nr-ai-agent/dashboards/ai-overview.json`
- Build a New Relic dashboard JSON definition following the [NR Dashboard API format](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-dashboards/) containing:
  - **Top row — Key indicators** (Billboard widgets):
    - Total AI spend today (`SELECT sum(ai.cost.total_usd) FROM AiResponse SINCE today`)
    - Total requests (`SELECT count(*) FROM AiRequest SINCE today`)
    - P95 latency (`SELECT percentile(ai.request.duration_ms, 95) FROM AiResponse SINCE 1 hour ago`)
    - Error rate (`SELECT percentage(count(*), WHERE error IS NOT NULL) FROM AiResponse SINCE 1 hour ago`)
  - **Row 2 — Cost breakdown** (Line/Area charts):
    - Cost by model over time (`SELECT sum(ai.cost.total_usd) FROM AiResponse FACET model TIMESERIES SINCE 24 hours ago`)
    - Cost by provider over time (`SELECT sum(ai.cost.total_usd) FROM AiResponse FACET provider TIMESERIES SINCE 24 hours ago`)
  - **Row 3 — Performance** (Line charts):
    - Latency percentiles over time (`SELECT percentile(ai.request.duration_ms, 50, 90, 95, 99) FROM AiResponse TIMESERIES SINCE 24 hours ago`)
    - Time to first token by model (`SELECT average(ai.request.time_to_first_token_ms) FROM AiResponse WHERE ai.request.time_to_first_token_ms IS NOT NULL FACET model TIMESERIES SINCE 24 hours ago`)
    - Tokens per second by model (`SELECT average(ai.request.tokens_per_second) FROM AiResponse FACET model TIMESERIES SINCE 24 hours ago`)
  - **Row 4 — Token Usage** (Stacked Area/Bar charts):
    - Token distribution (input vs output vs thinking vs cache) (`SELECT sum(ai.tokens.input), sum(ai.tokens.output), sum(ai.tokens.thinking), sum(ai.tokens.cache_read) FROM AiResponse TIMESERIES SINCE 24 hours ago`)
    - Stop reason distribution (`SELECT count(*) FROM AiResponse FACET stopReason SINCE 24 hours ago`)
  - **Row 5 — Errors** (Table + Line chart):
    - Error rate over time (`SELECT percentage(count(*), WHERE error IS NOT NULL) FROM AiResponse TIMESERIES SINCE 24 hours ago`)
    - Recent errors table (`SELECT timestamp, model, error.classification, error.message FROM AiResponse WHERE error IS NOT NULL SINCE 1 hour ago LIMIT 20`)
- Include a README section in the dashboard JSON description explaining what each widget shows and what NRQL event types are required
- Create a helper script `packages/nr-ai-agent/scripts/deploy-dashboard.ts` that uses the NR NerdGraph API to create/update the dashboard in a specified account

**Testing:**
- Unit test: validate the dashboard JSON structure is valid (parse it, verify it has `pages`, each page has `widgets`, each widget has `nrqlQueries`)
- Unit test: every NRQL query in the dashboard is syntactically valid (basic regex/parser check for SELECT, FROM, required clauses)
- Unit test: the deploy script correctly calls the NerdGraph `dashboardCreate` mutation with the expected payload structure
- Manual test: deploy the dashboard to a test NR account, verify all widgets render (will show "No data" until the agent is sending real events, but the widgets should not error)

---

## Phase 2: Deep Observability (4-6 weeks)

> **Goal**: Add the novel metrics that differentiate this agent.

### 2.1 — Extended Thinking Metrics (Thinking Tokens, Depth Index, Budget Utilization)

**Implementation:**
- Create `packages/nr-ai-agent/src/metrics/reasoning.ts`
- Implement `ReasoningMetrics` interface from Section 4.3 and the Reasoning Depth Profiling deep dive (Section 5.1):
  - `thinkingTokens`: number of tokens used for extended thinking
  - `thinkingBudgetTokens`: max thinking tokens allowed (from request `thinking.budget_tokens`)
  - `budgetUtilization`: `thinkingTokens / thinkingBudgetTokens` (0.0 - 1.0, null if no budget set)
  - `thinkingToOutputRatio`: `thinkingTokens / outputTokens`
  - `depthIndex`: composite reasoning intensity score (0.0 - 1.0), computed as:
    ```
    normalize(
      (thinkingTokens / outputTokens) * 0.4 +
      (thinkingDurationMs / totalDurationMs) * 0.3 +
      budgetUtilization * 0.3
    )
    ```
    Where `normalize()` clamps and scales to [0, 1] using empirical bounds (e.g., token ratio > 5 is maxed)
  - `thinkingEfficiency`: placeholder for quality-score-relative metric (null until quality scoring is available in 2.4)
- Implement `extractReasoningMetrics(request, response, timing): ReasoningMetrics`:
  - For Anthropic: read `thinking.budget_tokens` from request params; extract thinking token count from `response.usage` or by summing tokens in `thinking` content blocks; use `thinkingDurationMs` from `RequestTimer`
  - For Gemini 2.5: read `thoughtsTokenCount` from `response.usageMetadata`; thinking budget may come from `thinkingConfig.thinkingBudget` if present
  - When no thinking is used (no thinking config, or model doesn't support it), return null rather than zero-filled metrics
- Emit reasoning metrics as attributes on the `AiResponse` event (e.g., `ai.reasoning.thinking_tokens`, `ai.reasoning.depth_index`)
- Also emit as standalone aggregated metrics via `MetricAggregator`: `ai.reasoning.depth_index` (gauge), `ai.reasoning.budget_utilization` (gauge) — faceted by model

**Testing:**
- Unit test: `extractReasoningMetrics()` with Anthropic thinking response — 1000 thinking tokens, 500 output tokens, budget of 2000 — verify `budgetUtilization` = 0.5, `thinkingToOutputRatio` = 2.0, `depthIndex` is between 0 and 1
- Unit test: `depthIndex` normalization — extreme values (very high token ratio, very low) produce sensible 0-1 scores
- Unit test: `depthIndex` with zero thinking tokens returns null (no thinking used)
- Unit test: Gemini 2.5 thinking metrics extracted from `thoughtsTokenCount`
- Unit test: when thinking is not configured/available, `extractReasoningMetrics()` returns null
- Unit test: `budgetUtilization` at 100% (thinking tokens = budget tokens)
- Unit test: reasoning metrics are correctly added as attributes on the `AiResponse` event

---

### 2.2 — Prompt Cache Economics (Hit Rate, Savings, ROI)

**Implementation:**
- Create `packages/nr-ai-agent/src/metrics/cache-economics.ts`
- Implement `CacheMetrics` interface from Section 5.2:
  - `cacheHit`: boolean — whether any cache-read tokens were used (`cacheReadTokens > 0`)
  - `cacheReadTokens`: tokens served from prompt cache
  - `cacheCreationTokens`: tokens written to prompt cache
  - `cacheSavingsUsd`: money saved from cache reads — `cacheReadTokens * (fullInputPrice - cacheReadPrice) / 1_000_000`
  - `cacheCreationCostUsd`: premium paid for cache writes — `cacheCreationTokens * (cacheCreationPrice - fullInputPrice) / 1_000_000`
  - `cacheNetSavingsUsd`: `cacheSavingsUsd - cacheCreationCostUsd`
- Implement `CacheEconomicsTracker` class that maintains rolling aggregates:
  - `totalRequests`: total requests tracked
  - `cacheHitCount`: requests with cache hits
  - `cacheHitRate`: `cacheHitCount / totalRequests`
  - `cumulativeSavingsUsd`: running sum of net cache savings
  - `cacheRoi`: `cumulativeSavingsUsd / cumulativeCreationCostUsd` (return on cache investment)
  - `cacheEfficiencyScore`: `cacheSavingsUsd / (cacheSavingsUsd + cacheCreationCostUsd)` — from Section 5.2 formula
- The tracker records per-request cache metrics and emits them as attributes on the `AiResponse` event
- Also emit rolling aggregates as gauge metrics via `MetricAggregator` at each harvest:
  - `ai.cache.hit_rate`, `ai.cache.cumulative_savings_usd`, `ai.cache.roi`, `ai.cache.efficiency_score`
- For Gemini: map `cachedContentTokenCount` to cache read tokens; Gemini's context caching API has different pricing — use the appropriate rate from the pricing table
- Only active when `costTrackingEnabled=true` in config; otherwise, track hit/miss counts but skip USD calculations

**Testing:**
- Unit test: `CacheMetrics` computed from a response with 5000 cache-read tokens and 1000 cache-creation tokens for `claude-sonnet-4` — verify `cacheSavingsUsd` and `cacheCreationCostUsd` are correct against known pricing
- Unit test: `cacheNetSavingsUsd` = savings minus creation cost
- Unit test: `CacheEconomicsTracker` across 10 requests (7 cache hits, 3 misses) — verify `cacheHitRate` = 0.7
- Unit test: `cacheRoi` calculation is correct after multiple requests with varying cache hit/miss patterns
- Unit test: `cacheEfficiencyScore` = 1.0 when there are no creation costs (all reads)
- Unit test: when no cache tokens are present (non-caching request), `cacheHit` = false, all USD values = 0
- Unit test: Gemini cache metrics use the correct pricing rates
- Unit test: when `costTrackingEnabled=false`, hit/miss counts are tracked but USD values are 0

---

### 2.3 — Conversation Tracking (Per-Conversation Cost, Tokens, Context Pressure)

**Implementation:**
- Create `packages/nr-ai-agent/src/metrics/conversation.ts`
- Implement `ConversationTracker` class that maintains per-conversation state from Sections 4.7 and 5.9:
  - `conversationId`: string identifier (user-provided via `setConversationId()` or auto-generated)
  - `turnCount`: number of API calls (turns) in this conversation
  - `totalTokens`: cumulative tokens across all turns (input + output + thinking)
  - `totalCostUsd`: cumulative cost across all turns
  - `contextGrowthRate`: average tokens added per turn (`totalInputTokens / turnCount` delta)
  - `estimatedTurnsRemaining`: `(modelContextLimit - currentInputTokens) / avgGrowthRate`
  - `systemPromptTokenShare`: `systemPromptTokens / totalInputTokens` (tracked per-turn)
  - `contextPressure`: `totalInputTokens / modelContextLimit` (0.0 - 1.0)
  - `durationMs`: wall-clock time from first to latest turn
  - `userWaitTimeMs`: sum of all request durations (time user waited for AI)
- Conversation ID resolution (from design decision #6):
  1. Check for explicit user-provided ID via `agent.setConversationId(id)` API
  2. Check for `nr.conversationId` in request params custom metadata
  3. Auto-generate: hash the messages array excluding the last message to produce a stable fingerprint (SHA-256 of JSON-serialized prior messages, truncated to 16 hex chars)
- Implement `ConversationStore`: in-memory `Map<string, ConversationState>` with TTL-based cleanup (conversations idle for >1 hour are evicted with a final summary event emitted)
- On each API call, update the conversation state and emit:
  - Updated attributes on the `AiResponse` event: `ai.conversation.id`, `ai.conversation.turn_count`, `ai.conversation.total_cost_usd`, `ai.conversation.context_pressure`
  - At conversation eviction (TTL expiry or explicit `endConversation(id)` call): emit an `AiConversationSummary` custom event with all accumulated stats
- Expose public API methods on `NrAiAgent`:
  - `setConversationId(id: string)` — set the conversation ID for the current context (thread-local or explicit binding)
  - `endConversation(id: string)` — explicitly close a conversation and emit the summary event
  - `getConversationStats(id: string)` — return current `ConversationState` for inspection

**Testing:**
- Unit test: `ConversationTracker` across 5 turns — verify `turnCount`, `totalTokens`, `totalCostUsd` accumulate correctly
- Unit test: `contextPressure` computed correctly for a model with 200k context limit and 50k tokens used = 0.25
- Unit test: `estimatedTurnsRemaining` with steady growth rate of 5000 tokens/turn, 150k remaining = 30 turns
- Unit test: `systemPromptTokenShare` for a system prompt of 2000 tokens out of 10000 total input = 0.2
- Unit test: conversation ID auto-generation — two calls with the same prior messages produce the same conversation ID; adding a different prior message produces a different ID
- Unit test: explicit `setConversationId()` overrides auto-generation
- Unit test: `ConversationStore` TTL eviction — after 1 hour idle, conversation is removed and summary event is emitted
- Unit test: `endConversation()` emits an `AiConversationSummary` event with correct accumulated stats
- Unit test: `userWaitTimeMs` = sum of all request `durationMs` values across turns

---

### 2.4 — Quality Signal Framework (Structural Signals + User Feedback Callback API)

**Implementation:**
- Create `packages/nr-ai-agent/src/metrics/quality.ts`
- Implement the quality tracking system from Section 5.4, starting with structural signals (zero-effort, always available):
  - **Stop reason tracking**: maintain a rolling window (configurable, default 1 hour) of stop reasons; detect shifts in distribution (e.g., sudden increase in `max_tokens` truncations)
  - **Response length anomaly**: rolling mean and standard deviation of response token count; flag when a response is >2 std dev from the rolling mean
  - **Latency anomaly**: rolling mean and std dev of `durationMs` and `timeToFirstTokenMs`; flag spikes
  - **Error rate tracking**: rolling error rate; flag when it exceeds a configurable threshold (default 5%)
  - **Thinking depth changes**: rolling mean of `depthIndex`; flag when it drifts (requires reasoning metrics from 2.1)
- Implement `QualityTracker` class:
  - `recordStructuralSignals(response: AiResponse)` — called automatically on every response; updates rolling baselines and emits anomaly flags
  - Rolling window implementation: circular buffer of recent data points with configurable window size (default: 100 requests or 1 hour, whichever is reached first)
  - Composite `qualityScore` (0.0 - 1.0): weighted combination of available signals:
    - `maxTokensHitRate` weight: -0.3 (penalty when truncation is frequent)
    - `errorRate` weight: -0.3 (penalty when errors are high)
    - `latencyAnomaly` weight: -0.2 (penalty when latency spikes)
    - `responseLengthAnomaly` weight: -0.2 (penalty when length anomalies appear)
    - Baseline: 1.0 (perfect) minus penalties
  - Score is emitted as `ai.quality.score` gauge metric
- Implement callback API for application-provided signals (per design decision #4):
  - `agent.recordFeedback(requestId: string, score: number, metadata?: Record<string, string>)` — record user feedback (e.g., thumbs up = 1, thumbs down = 0, or 1-5 star rating)
  - `agent.recordRegeneration(requestId: string)` — record that the user requested a new response
  - `agent.recordEditDistance(requestId: string, editDistance: number)` — record how much the user modified the AI output (0 = no edits, 1 = completely rewritten)
  - Each callback emits an `AiQualityFeedback` custom event linked to the original request ID
- When feedback signals are available, incorporate them into the composite quality score with higher weight than structural signals

**Testing:**
- Unit test: `QualityTracker` with 100 normal responses, then 5 with `stopReason: 'max_tokens'` — verify `maxTokensHitRate` increases and `qualityScore` decreases
- Unit test: rolling window evicts old data correctly — after window size exceeded, oldest data points are dropped
- Unit test: latency anomaly detection — 100 responses at ~200ms, then 1 at 5000ms — flagged as anomaly
- Unit test: response length anomaly — 100 responses at ~500 tokens, then 1 at 50 tokens — flagged
- Unit test: composite `qualityScore` with no anomalies = 1.0; with 50% error rate, score is significantly penalized
- Unit test: `recordFeedback()` with a valid request ID emits an `AiQualityFeedback` event with correct score
- Unit test: `recordRegeneration()` emits an event and increments the regeneration rate counter
- Unit test: `recordEditDistance()` with distance 0.8 emits correctly
- Unit test: invalid request ID in callback logs a warning but doesn't throw
- Unit test: when `qualityTrackingEnabled=false`, no tracking occurs and callbacks are no-ops

---

### 2.5 — Multi-Modal Input Tracking (Image/PDF/Audio Token Attribution)

**Implementation:**
- Create `packages/nr-ai-agent/src/metrics/multimodal.ts`
- Implement `MultiModalMetrics` interface from Section 5.10:
  - `inputModalities`: array of modality types present in the request (e.g., `['text', 'image']`)
  - `imageCount`: number of image inputs
  - `imageTokenEstimate`: estimated tokens consumed by images (Anthropic charges per-image based on size; Gemini similar)
  - `pdfCount`: number of PDF/document inputs
  - `pdfPageCount`: total pages across all PDFs
  - `audioSeconds`: total audio duration (Gemini)
  - `videoSeconds`: total video duration (Gemini)
  - `textTokens`: tokens from text content only
- Implement `detectModalities(messages: Message[]): MultiModalMetrics`:
  - For Anthropic: scan message content blocks for `type: 'image'` (contains `source.type: 'base64'` or `source.type: 'url'`), `type: 'document'` (PDF)
    - Image token estimation: Anthropic uses a formula based on image dimensions — `tokens = (width * height) / 750`. If dimensions aren't known (URL source), estimate from base64 size or log a warning
  - For Gemini: scan `parts` array for `inlineData` with image MIME types, `fileData` for uploaded files, audio/video MIME types
    - Gemini provides token counts per part in some cases; use those when available
- Emit modality attributes on the `AiRequest` event: `ai.input.modalities`, `ai.input.image_count`, `ai.input.pdf_count`, etc.
- Emit cost attribution by modality on the `AiResponse` event: `ai.cost.text_input_usd`, `ai.cost.image_input_usd` (computed from estimated image tokens * model input rate)
- Also emit as aggregated metrics: `ai.multimodal.image_tokens` (counter), `ai.multimodal.requests_with_images` (counter) — faceted by model and feature tag

**Testing:**
- Unit test: `detectModalities()` with a text-only message — returns `inputModalities: ['text']`, all other counts = 0
- Unit test: `detectModalities()` with an Anthropic message containing 2 base64 images — returns `imageCount: 2`, correct token estimate based on image dimensions
- Unit test: `detectModalities()` with an Anthropic message containing a PDF — returns `pdfCount: 1`
- Unit test: `detectModalities()` with a Gemini message containing audio — returns `audioSeconds` from the audio metadata
- Unit test: `detectModalities()` with mixed content (text + image + PDF) — all modalities detected
- Unit test: image token estimation formula matches Anthropic's documented calculation
- Unit test: when image dimensions are unknown, a reasonable estimate is used and a warning is logged
- Unit test: modality attributes are correctly added to the `AiRequest` event

---

### 2.6 — Cost Attribution Tags (Feature, Team, User)

**Implementation:**
- Create `packages/nr-ai-agent/src/metrics/cost-attribution.ts`
- Implement multi-dimensional cost attribution from Section 5.3:
  - Define standard attribution tag keys: `ai.attribution.feature`, `ai.attribution.team`, `ai.attribution.user`, `ai.attribution.environment`
  - These tags are attached to every `AiRequest` and `AiResponse` event, enabling NRQL queries like:
    `SELECT sum(ai.cost.total_usd) FROM AiResponse FACET ai.attribution.feature SINCE 1 week ago`
- Implement three ways to set attribution tags (in priority order):
  1. **Per-request** — pass tags in a metadata object on the API call:
     ```typescript
     agent.wrapAnthropicClient(client);
     // Then in the request:
     client.messages.create({
       model: 'claude-sonnet-4-20250514',
       messages: [...],
       // Agent picks up custom metadata:
       metadata: { nr: { feature: 'code-review', team: 'backend', user: 'alice' } }
     });
     ```
     The wrapper extracts `metadata.nr.*` before forwarding the call (strip it from params so the upstream SDK doesn't reject unknown fields)
  2. **Context-scoped** — set tags for all subsequent calls in the current async context:
     ```typescript
     agent.setAttributionContext({ feature: 'chatbot', team: 'support' });
     // All subsequent calls in this async context inherit these tags
     ```
     Use Node.js `AsyncLocalStorage` to propagate context across async boundaries
  3. **Global defaults** — set via environment variables or `init()` config:
     `NEW_RELIC_AI_ATTRIBUTION_FEATURE=chatbot`, `NEW_RELIC_AI_ATTRIBUTION_TEAM=platform`
- Priority: per-request > context-scoped > global defaults (specific overrides general)
- Implement `resolveAttribution(requestMetadata, asyncContext, globalConfig): AttributionTags`
- Also support arbitrary custom tags beyond the standard ones (e.g., `{ environment: 'staging', promptVersion: 'v3' }`) — these are passed through as custom event attributes with `ai.custom.*` prefix

**Testing:**
- Unit test: per-request tags are extracted from `metadata.nr.*` and attached to the events
- Unit test: per-request tags are stripped from the params before forwarding to the SDK (so the SDK doesn't receive unknown fields)
- Unit test: context-scoped tags via `setAttributionContext()` are inherited by all calls within the async context
- Unit test: `AsyncLocalStorage` propagation — tags set in an outer async context are visible in inner async calls
- Unit test: global default tags from config are applied when no per-request or context tags are set
- Unit test: priority ordering — per-request tag overrides context tag overrides global default for the same key
- Unit test: custom tags are prefixed with `ai.custom.*` on the emitted events
- Unit test: missing attribution (no tags set anywhere) results in events with no attribution attributes (not null values)
- Unit test: attribution tags appear on both `AiRequest` and `AiResponse` events for the same call

---

### 2.7 — Provider Comparison Metrics

**Implementation:**
- Create `packages/nr-ai-agent/src/metrics/provider-comparison.ts`
- Implement automated comparison metrics from Section 5.6 that enable cross-provider analysis:
  - The core insight: since both Anthropic and Gemini wrappers emit the same `AiRequest`/`AiResponse` event schema with a `provider` attribute, comparison is primarily a **dashboard/NRQL concern** — but the agent needs to ensure data is consistently structured
- Implement `ProviderComparisonAggregator` class:
  - Maintains rolling aggregates per `(provider, model)` pair:
    - `avgDurationMs`, `p95DurationMs`, `avgTtftMs`
    - `avgTokensPerSecond`
    - `avgCostPerRequestUsd`
    - `errorRate`
    - `avgThinkingTokens`, `avgDepthIndex` (for models that support thinking)
  - Emits comparison gauge metrics at each harvest:
    - `ai.provider.avg_duration_ms` (faceted by provider and model)
    - `ai.provider.avg_cost_per_request_usd`
    - `ai.provider.error_rate`
    - `ai.provider.avg_tokens_per_second`
- Implement `requestCategorization`: optionally tag requests with a category (e.g., "code-review", "summarization", "chat") so comparisons can be per-workload type
  - Category can come from attribution tags (`ai.attribution.feature`) or from a user-provided callback
  - This enables: "For code-review tasks, Claude Sonnet costs $0.05/request vs Gemini Flash at $0.02/request"
- Emit a periodic `AiProviderComparison` summary event (every 60s) with side-by-side metrics per provider for each active category, enabling pre-built comparison dashboard widgets

**Testing:**
- Unit test: `ProviderComparisonAggregator` receiving 10 Anthropic and 10 Gemini requests produces correct per-provider averages
- Unit test: p95 calculation across a set of response durations is correct
- Unit test: error rate per provider is independently computed (Anthropic 2/10 = 20%, Gemini 0/10 = 0%)
- Unit test: metrics are faceted by both provider and model (e.g., separate stats for `claude-sonnet-4` vs `claude-opus-4`)
- Unit test: `AiProviderComparison` event includes side-by-side metrics for active providers
- Unit test: when only one provider is active, comparison event still emits (with single-provider data)
- Unit test: request categorization — two categories produce independent comparison metrics
- Unit test: rolling aggregates evict data outside the window period

---

### 2.8 — Pre-Built Dashboards: "AI Cost Explorer" + "AI Reliability"

**Implementation:**
- Create `packages/nr-ai-agent/dashboards/ai-cost-explorer.json`
- Build the "AI Cost Explorer" dashboard from Section 7 of the ideation doc:
  - **Cost treemap**: cost breakdown by model -> feature -> endpoint (`SELECT sum(ai.cost.total_usd) FROM AiResponse FACET model, ai.attribution.feature SINCE 1 week ago`)
  - **Top 10 most expensive conversations**: table widget (`SELECT max(ai.conversation.total_cost_usd) FROM AiConversationSummary FACET ai.conversation.id SINCE 1 week ago LIMIT 10`)
  - **Cost anomaly timeline**: line chart with anomaly bands (`SELECT sum(ai.cost.total_usd) FROM AiResponse TIMESERIES 1 hour SINCE 7 days ago COMPARE WITH 1 week ago`)
  - **Cache efficiency**: dual-axis chart showing cache savings vs creation cost over time (`SELECT sum(ai.cost.savings_from_cache_usd), sum(ai.cost.cache_creation_usd) FROM AiResponse TIMESERIES SINCE 7 days ago`)
  - **Input/output token ratio by feature**: bar chart (`SELECT average(ai.tokens.input) / average(ai.tokens.output) FROM AiResponse FACET ai.attribution.feature SINCE 7 days ago`)
  - **Cost by attribution dimension**: pie charts for cost by team, by user, by feature
- Create `packages/nr-ai-agent/dashboards/ai-reliability.json`
- Build the "AI Reliability" dashboard from Section 7:
  - **Provider availability**: line chart of success rate per provider over time (`SELECT percentage(count(*), WHERE error IS NULL) FROM AiResponse FACET provider TIMESERIES SINCE 24 hours ago`)
  - **Rate limit headroom**: line chart (`SELECT latest(ai.error.rate_limit_tokens_remaining) FROM AiResponse FACET provider TIMESERIES SINCE 24 hours ago`)
  - **Error classification breakdown**: stacked bar chart (`SELECT count(*) FROM AiResponse WHERE error IS NOT NULL FACET error.classification SINCE 24 hours ago`)
  - **Retry success rate**: percentage of retried requests that eventually succeeded
  - **Latency percentiles**: multi-line chart p50, p90, p95, p99 (`SELECT percentile(ai.request.duration_ms, 50, 90, 95, 99) FROM AiResponse TIMESERIES SINCE 24 hours ago`)
- Update the deploy script from 1.11 to support deploying all dashboards (pass dashboard name or `--all`)

**Testing:**
- Unit test: validate both dashboard JSON files parse correctly and follow NR dashboard structure
- Unit test: all NRQL queries in both dashboards are syntactically valid
- Unit test: deploy script can target a single dashboard or all dashboards
- Manual test: deploy both dashboards to a test NR account; verify widgets render without errors

---

### 2.9 — Python Wrapper (Same Capabilities, Import Hook Pattern)

**Implementation:**
- Create a new top-level directory `python/` (or `packages/nr-ai-agent-python/`) for the Python package
- Set up Python project structure:
  - `pyproject.toml` with package metadata, dependencies (`wrapt`, `requests`), optional dependencies (`anthropic`, `google-genai`)
  - `src/nr_ai_agent/` package directory
  - `tests/` directory with `pytest` configuration
- Implement import hook-based instrumentation (same pattern as the existing NR Python agent):
  - `src/nr_ai_agent/hooks/anthropic_hook.py`: register a `wrapt` import hook for the `anthropic` module
    - On import, monkey-patch `anthropic.Anthropic.messages.create()` and `anthropic.Anthropic.messages.stream()`
    - Same data capture as the TypeScript wrapper (1.1): request params, response usage, timing, error classification
  - `src/nr_ai_agent/hooks/gemini_hook.py`: register a hook for `google.genai`
    - Monkey-patch `genai.GenerativeModel.generate_content()` and `generate_content_stream()`
    - Same data capture as TypeScript wrapper (1.2)
- Implement the same shared modules in Python:
  - `src/nr_ai_agent/pricing.py` — same pricing table and `calculate_cost()` logic
  - `src/nr_ai_agent/tokens.py` — same token extraction logic
  - `src/nr_ai_agent/timing.py` — same `RequestTimer` using `time.perf_counter()`
  - `src/nr_ai_agent/errors.py` — same error classification
  - `src/nr_ai_agent/transport.py` — Events API and Metric API transport (using `requests` or `urllib3`)
  - `src/nr_ai_agent/harvest.py` — event buffer with reservoir sampling, harvest scheduler using `threading.Timer`
  - `src/nr_ai_agent/config.py` — configuration from environment variables
- Implement `src/nr_ai_agent/__init__.py` with the public API:
  ```python
  def init(license_key=None, app_name=None, **kwargs) -> NrAiAgent
  def wrap_anthropic_client(client) -> client
  def wrap_gemini_client(client) -> client
  ```
- Support auto-instrumentation: if `nr_ai_agent` is imported before `anthropic`/`google.genai`, the import hooks automatically wrap the SDKs without explicit `wrap_*` calls
- Emit the same event types (`AiRequest`, `AiResponse`, `AiMessage`, `AiErrorRecord`) with the same attribute names as the TypeScript agent — ensuring consistent NRQL queries and dashboards across languages
- Include all Phase 2 metrics: reasoning metrics, cache economics, conversation tracking, quality signals, multi-modal detection, cost attribution

**Testing:**
- Unit test: `wrap_anthropic_client()` intercepts `messages.create()` and captures all expected fields
- Unit test: streaming wrapper for `messages.stream()` measures TTFT, accumulates tokens, re-yields chunks
- Unit test: Gemini wrapper captures `generate_content()` and `generate_content_stream()` correctly
- Unit test: pricing calculations match TypeScript implementation for the same inputs
- Unit test: token extraction matches TypeScript implementation for the same response shapes
- Unit test: error classification produces the same classifications as TypeScript for equivalent errors
- Unit test: event buffer reservoir sampling works correctly
- Unit test: harvest scheduler fires at correct intervals
- Unit test: transport layer sends events with correct headers and gzip compression
- Unit test: auto-instrumentation via import hooks — importing `anthropic` after `nr_ai_agent` results in automatic wrapping
- Integration test: full lifecycle with real Anthropic SDK — `init()` -> make a call -> verify events buffered -> `shutdown()` -> verify flush
- Cross-language test: send equivalent requests from both TypeScript and Python agents; verify the resulting NR events have identical attribute names and value types (enabling the same NRQL queries to work against both)

---

## Phase 3: Agentic Intelligence (4-6 weeks)

> **Goal**: First-class observability for AI agents and workflows.

### 3.1 — Agentic Workflow Tracer (Trace Tree with Spans)

**Implementation:**
- Create `packages/nr-ai-agent/src/agentic/tracer.ts`
- Implement the agentic workflow tracing system from Section 5.5, treating an agentic workflow as a distributed trace where each step is a span:
- Define span types:
  - `AgentTask` — root span representing the entire task (e.g., "Fix the failing test")
  - `LlmCall` — span for an LLM API call (wraps existing `AiRequest`/`AiResponse`)
  - `ToolCall` — span for a tool/function execution (name, input, output, duration, success/failure)
  - `SubAgent` — span for a delegated sub-agent task
  - `Planning` — span for a planning/reasoning phase
- Implement `AgenticTracer` class:
  - `startTask(name: string, metadata?: Record<string, string>): TaskSpan` — create a root span for a new agentic task; returns a `TaskSpan` handle
  - `TaskSpan.startLlmCall(model: string): LlmSpan` — create a child span for an LLM call; automatically linked to any `AiRequest`/`AiResponse` events produced during this span
  - `TaskSpan.startToolCall(toolName: string, input?: any): ToolSpan` — create a child span for a tool execution
  - `TaskSpan.startSubAgent(name: string): TaskSpan` — create a nested task span for sub-agent delegation
  - `Span.end(result?: { success: boolean, output?: string })` — close a span and record its outcome
- Build the trace tree structure:
  - Each span has: `traceId` (shared across the entire task), `spanId` (unique), `parentSpanId` (links to parent), `startTime`, `endTime`, `durationMs`, `spanType`, `attributes`
  - Use NR's distributed tracing format: spans are emitted as `Span` events compatible with the NR Trace API
  - `traceId` links all spans in a task together for visualization in the NR Distributed Tracing UI
- Implement automatic LLM call linking:
  - When an `LlmSpan` is active (via `AsyncLocalStorage`), the SDK wrappers (1.1, 1.2) automatically attach `traceId` and `spanId` to the `AiRequest`/`AiResponse` events
  - This means: even without explicit tracer usage, if the user wraps their agent's top-level function with `startTask()`, all nested LLM calls are automatically linked
- Calculate task-level aggregates on `TaskSpan.end()`:
  - `totalDurationMs`, `totalLlmCalls`, `totalToolCalls`, `totalTokens`, `totalCostUsd`, `stepCount`
  - Emit as attributes on the root `AgentTask` span and as an `AiAgentTaskSummary` custom event

**Testing:**
- Unit test: `startTask()` creates a root span with a unique `traceId` and `spanId`
- Unit test: `startLlmCall()` creates a child span with the correct `parentSpanId` linking to the task span
- Unit test: `startToolCall()` creates a child span with tool name, input (if provided), duration on end
- Unit test: nested task spans (sub-agents) form a correct tree with proper parent-child relationships
- Unit test: `end()` on a task span computes correct aggregates (total duration, LLM calls, tool calls, cost)
- Unit test: spans are emitted in NR distributed tracing format with required fields
- Unit test: automatic LLM call linking — when an `LlmSpan` is active via `AsyncLocalStorage`, the Anthropic wrapper's `AiResponse` event includes the correct `traceId` and `spanId`
- Unit test: trace tree serialization produces the correct hierarchical structure shown in Section 5.5
- Unit test: `startToolCall()` with `success: false` on end correctly records the failure

---

### 3.2 — Anti-Pattern Detection (Loops, Overthinking, Underthinking, Spinning)

**Implementation:**
- Create `packages/nr-ai-agent/src/agentic/anti-patterns.ts`
- Implement the anti-pattern detectors from Section 5.5:
  - **Spinning Wheels**: agent calls the same tool >N times (configurable, default 3) with similar inputs
    - Similarity check: hash tool name + JSON-serialized input; if the same hash appears >N times within a task span, flag it
    - Emit: `AiAntiPattern` event with `type: 'spinning_wheels'`, `toolName`, `repeatCount`, `traceId`
  - **Overthinking**: reasoning depth index >0.9 for tasks classified as "simple"
    - Simple task heuristic: low tool call count (<3), short output (<500 tokens), or user-provided complexity tag
    - Emit: `AiAntiPattern` event with `type: 'overthinking'`, `depthIndex`, `taskComplexity`
  - **Underthinking**: reasoning depth <0.2 for tasks classified as "complex"
    - Complex task heuristic: high tool call count (>5), long output (>2000 tokens), or user-provided complexity tag
    - Emit: `AiAntiPattern` event with `type: 'underthinking'`, `depthIndex`, `taskComplexity`
  - **Context Stuffing**: >80% of context window consumed by prior conversation, leaving little room for reasoning
    - Uses `contextPressure` from conversation tracker (2.3)
    - Emit: `AiAntiPattern` event with `type: 'context_stuffing'`, `contextPressure`
  - **Token Explosion**: single turn consuming >50% of context window
    - Check: `(inputTokens + outputTokens) / modelContextLimit > 0.5`
    - Emit: `AiAntiPattern` event with `type: 'token_explosion'`, `tokenShare`
  - **Bail-Out Pattern**: agent gives up and asks the user after <N attempts (configurable, default 2)
    - Detection heuristic: task ends with `stopReason: 'end_turn'` and response contains escalation phrases, after fewer than N tool calls
    - Emit: `AiAntiPattern` event with `type: 'bail_out'`, `attemptCount`
- Implement `AntiPatternDetector` class:
  - `analyze(taskSpan: TaskSpan): AntiPattern[]` — run all detectors against a completed task span, return any detected anti-patterns
  - Called automatically when `TaskSpan.end()` is invoked
  - Configurable thresholds via agent config (e.g., `NEW_RELIC_AI_ANTI_PATTERN_SPIN_THRESHOLD=3`)
- Emit anti-pattern events to the event buffer and as gauge metrics:
  - `ai.agent.anti_pattern_count` (counter, faceted by type)
  - `ai.agent.spinning_wheels_rate` (percentage of tasks with spinning)

**Testing:**
- Unit test: spinning wheels — task span with 4 identical `readFile("src/auth.ts")` tool calls -> detected
- Unit test: spinning wheels — task span with 3 different tool calls -> not detected
- Unit test: spinning wheels — similar but not identical inputs (e.g., `readFile("src/auth.ts")` vs `readFile("src/auth.test.ts")`) -> not detected (different hashes)
- Unit test: overthinking — depth index 0.95 with 2 tool calls and 200 output tokens -> detected
- Unit test: underthinking — depth index 0.1 with 8 tool calls and 3000 output tokens -> detected
- Unit test: context stuffing — context pressure 0.85 -> detected; 0.75 -> not detected
- Unit test: token explosion — single turn at 55% of context window -> detected; 40% -> not detected
- Unit test: bail-out — task with 1 tool call ending in escalation -> detected; task with 5 tool calls ending in escalation -> not detected
- Unit test: configurable thresholds — changing spin threshold from 3 to 5 changes detection behavior
- Unit test: `analyze()` on a clean task span returns empty array

---

### 3.3 — Task-Level Metrics (Cost per Task, Steps per Task, Completion Rate)

**Implementation:**
- Create `packages/nr-ai-agent/src/agentic/task-metrics.ts`
- Implement task-level aggregation metrics from Section 4.5:
  - **`ai.agent.task_duration_ms`**: total time from `TaskSpan.start()` to `TaskSpan.end()`
  - **`ai.agent.total_steps`**: count of child spans (LLM calls + tool calls) in the task
  - **`ai.agent.tool_calls_per_task`**: count of `ToolCall` child spans
  - **`ai.agent.llm_calls_per_task`**: count of `LlmCall` child spans
  - **`ai.agent.tokens_per_task`**: sum of `totalTokens` across all LLM calls in the task
  - **`ai.agent.cost_per_task_usd`**: sum of `costTotalUsd` across all LLM calls in the task
  - **`ai.agent.task_completion_rate`**: percentage of tasks that end with `success: true`
  - **`ai.agent.tool_call_chain_depth`**: deepest nesting level in the span tree (e.g., task -> LLM -> tool -> sub-agent -> LLM = depth 4)
- Implement `TaskMetricsAggregator` class:
  - Maintains rolling stats across completed tasks:
    - `avgCostPerTask`, `p95CostPerTask`, `avgStepsPerTask`, `avgDurationMs`
    - `completionRate` (rolling window)
    - `avgToolCallsPerTask`, `avgLlmCallsPerTask`
  - Emits aggregated metrics at each 60s harvest:
    - `ai.agent.avg_cost_per_task_usd` (gauge)
    - `ai.agent.completion_rate` (gauge)
    - `ai.agent.avg_steps_per_task` (gauge)
    - `ai.agent.avg_duration_ms` (gauge)
- On each `TaskSpan.end()`:
  - Compute all per-task metrics from the span tree
  - Emit an `AiAgentTaskSummary` custom event with all metrics as attributes
  - Feed into `TaskMetricsAggregator` for rolling stats
- Expose a public API: `agent.getTaskMetrics(): TaskAggregateStats` — returns current rolling aggregates for programmatic access

**Testing:**
- Unit test: task span with 3 LLM calls (100 + 200 + 150 tokens, $0.01 + $0.02 + $0.015 cost) and 4 tool calls -> `totalSteps` = 7, `tokensPerTask` = 450, `costPerTask` = $0.045
- Unit test: `toolCallChainDepth` for a flat task (all children direct) = 1; for a nested task (tool -> sub-agent -> LLM) = 3
- Unit test: `taskCompletionRate` across 10 tasks (8 success, 2 failure) = 80%
- Unit test: `TaskMetricsAggregator` rolling averages update correctly as new tasks complete
- Unit test: `AiAgentTaskSummary` event contains all expected attributes
- Unit test: p95 cost calculation across a distribution of task costs is correct
- Unit test: task with zero LLM calls (e.g., cache-only task) produces valid metrics with zeroed token/cost fields
- Unit test: `getTaskMetrics()` returns current aggregates matching what's been recorded

---

### 3.4 — Framework Integrations: LangChain.js, Vercel AI SDK, CrewAI

**Implementation:**
- Create `packages/nr-ai-agent/src/integrations/` directory with one file per framework
- **LangChain.js** (`packages/nr-ai-agent/src/integrations/langchain.ts`):
  - Implement a LangChain callback handler (`NrAiCallbackHandler`) that implements the `BaseCallbackHandler` interface
  - Hook into LangChain lifecycle events:
    - `handleLLMStart` / `handleLLMEnd` — capture LLM calls (map to `LlmCall` spans)
    - `handleChainStart` / `handleChainEnd` — capture chain executions (map to `AgentTask` spans)
    - `handleToolStart` / `handleToolEnd` — capture tool calls (map to `ToolCall` spans)
    - `handleAgentAction` / `handleAgentEnd` — capture agent decisions (map to `Planning` spans)
    - `handleRetrieverStart` / `handleRetrieverEnd` — capture RAG retrieval (map to `ToolCall` spans with type "retrieval")
  - Usage: `const chain = new LLMChain({ callbacks: [new NrAiCallbackHandler(agent)] })`
  - Automatically builds the trace tree from the nested callback structure
- **Vercel AI SDK** (`packages/nr-ai-agent/src/integrations/vercel-ai.ts`):
  - Implement a Vercel AI SDK middleware or telemetry hook
  - The Vercel AI SDK supports telemetry via `experimental_telemetry` option — hook into this to capture:
    - `generateText` / `streamText` — map to `LlmCall` spans
    - Tool calls and results — map to `ToolCall` spans
    - Multi-step generation — map to `AgentTask` with child `LlmCall` spans
  - Alternative: wrap the `createAnthropic()` / `createGoogleGenerativeAI()` provider functions to intercept at the SDK level
- **CrewAI** (`packages/nr-ai-agent/src/integrations/crewai.ts` — Python only, in the Python package):
  - Implement a CrewAI callback that hooks into:
    - Crew execution start/end — map to root `AgentTask` span
    - Agent task assignment — map to child `AgentTask` spans per agent
    - Tool usage — map to `ToolCall` spans
    - Inter-agent delegation — map to `SubAgent` spans
  - Track CrewAI-specific metrics: agent roles, task delegation chains, crew completion time
- Each integration is an optional peer dependency — the integration module only loads if the framework is installed
- Implement a registry pattern: `agent.registerIntegration('langchain', options)` — lazy-loads the integration module

**Testing:**
- Unit test (LangChain): mock LangChain callback lifecycle — `handleChainStart` -> `handleLLMStart` -> `handleToolStart` -> `handleToolEnd` -> `handleLLMEnd` -> `handleChainEnd` — verify correct trace tree is built
- Unit test (LangChain): `handleRetrieverStart` / `handleRetrieverEnd` produces retrieval tool spans with correct attributes
- Unit test (LangChain): error in `handleLLMError` produces an error span
- Unit test (Vercel AI): mock `generateText()` with tool calls — verify LLM span and tool spans are created
- Unit test (Vercel AI): mock `streamText()` — verify streaming metrics (TTFT) are captured
- Unit test (Vercel AI): multi-step generation produces a task span with multiple child LLM spans
- Unit test (CrewAI, Python): mock crew execution with 2 agents and 3 tasks — verify task delegation spans are correctly nested
- Unit test: `registerIntegration()` with an uninstalled framework throws a helpful error ("langchain not found, install with npm install langchain")
- Unit test: integration modules only import framework types when explicitly activated (no import errors if framework not installed)
- Integration test: run a simple LangChain chain with the callback handler and verify events appear in the event buffer

---

### 3.5 — Sub-Agent Tracking (Delegation, Spawning, Inter-Agent Communication)

**Implementation:**
- Create `packages/nr-ai-agent/src/agentic/sub-agent.ts`
- Extend the `AgenticTracer` (from 3.1) with explicit sub-agent tracking capabilities:
  - **Delegation tracking**: when an agent delegates work to a sub-agent, the parent `TaskSpan` creates a child `SubAgent` span that encapsulates the sub-agent's entire execution
    - `TaskSpan.delegate(agentName: string, taskDescription: string): TaskSpan` — creates a nested task span tagged as a sub-agent delegation
    - The returned `TaskSpan` represents the sub-agent's work and can contain its own LLM calls, tool calls, and further delegations
  - **Spawning tracking**: when an agent spawns concurrent sub-agents (e.g., fan-out pattern)
    - `TaskSpan.spawn(agents: Array<{ name: string, task: string }>): TaskSpan[]` — creates multiple concurrent child task spans
    - Each spawn is tagged with `ai.agent.spawn_index` and `ai.agent.spawn_total`
    - The parent span tracks total spawn count and waits for all to complete before computing aggregates
  - **Inter-agent communication**: track messages passed between agents
    - `agent.recordAgentMessage(from: string, to: string, messageType: string, tokenCount?: number)` — emit an `AiAgentMessage` event
    - Attributes: `fromAgent`, `toAgent`, `messageType` (e.g., "task_assignment", "result", "question", "clarification"), `tokenCount` (if applicable)
- Sub-agent metrics (additions to Section 4.5):
  - `ai.agent.delegation_count`: number of times this task delegated to sub-agents
  - `ai.agent.spawn_count`: number of concurrent sub-agents spawned
  - `ai.agent.delegation_depth`: deepest nesting level of delegation (task -> sub-agent -> sub-sub-agent = depth 2)
  - `ai.agent.inter_agent_messages`: count of messages exchanged between agents
  - `ai.agent.delegation_overhead_ms`: time spent coordinating delegation vs actual sub-agent work
- Emit all metrics as attributes on the root `AgentTask` span and in the `AiAgentTaskSummary` event

**Testing:**
- Unit test: `delegate()` creates a child span with `spanType: 'sub_agent'` and correct parent-child linking
- Unit test: `spawn()` with 3 agents creates 3 concurrent child spans, each tagged with spawn index
- Unit test: nested delegation (task -> delegate -> delegate) produces correct `delegationDepth` = 2
- Unit test: `recordAgentMessage()` emits an `AiAgentMessage` event with correct from/to/type fields
- Unit test: `delegationOverheadMs` = parent span duration minus sum of child span durations
- Unit test: spawned sub-agents running concurrently — parent span duration is approximately `max(child durations)`, not `sum(child durations)`
- Unit test: all sub-agent metrics roll up correctly into the root task summary
- Unit test: delegation chain cost = sum of all nested sub-agent costs

---

### 3.6 — Context Management Visibility (Summarization Events, Context Resets)

**Implementation:**
- Create `packages/nr-ai-agent/src/agentic/context-management.ts`
- Implement context lifecycle tracking for agentic workflows where context windows fill up and must be managed:
  - **Context reset detection**: when an agent's message history is truncated or summarized, detect the reset and emit an `AiContextReset` event
    - Detection heuristic: if the input token count drops significantly between consecutive turns in the same conversation (e.g., >50% reduction), infer a context reset/summarization occurred
    - Alternative: provide an explicit API — `agent.recordContextReset(conversationId, { reason, tokensBefore, tokensAfter, summarizedTurns })`
  - **Context compression events**: track when and how context is managed
    - `AiContextReset` event attributes: `conversationId`, `tokensBefore`, `tokensAfter`, `tokensRemoved`, `compressionRatio` (`tokensAfter / tokensBefore`), `reason` (`'summarization' | 'truncation' | 'sliding_window' | 'manual'`), `turnsRemoved`
  - **Context growth monitoring**: extends conversation tracking (2.3) with context management awareness
    - `contextResetsCount`: number of context resets in a conversation
    - `avgTokensBetweenResets`: average tokens accumulated before each reset
    - `contextEfficiency`: ratio of "useful" context to total tokens processed over the conversation lifetime (`totalOutputTokens / totalInputTokens` across all resets)
- Implement `ContextManagementTracker` class:
  - `recordTurn(conversationId, inputTokens, outputTokens)` — track context growth; auto-detect resets
  - `recordContextReset(conversationId, details)` — explicit reset recording
  - Maintains per-conversation context lifecycle: token count at each turn, reset events, growth rate post-reset
- Emit metrics:
  - `ai.context.resets_count` (counter, per conversation)
  - `ai.context.compression_ratio` (gauge, per reset event)
  - `ai.context.avg_tokens_between_resets` (gauge)
- Update `AiConversationSummary` event (from 2.3) to include context management stats

**Testing:**
- Unit test: auto-detection — 5 turns growing from 1000 to 5000 tokens, then turn 6 at 1200 tokens -> context reset detected
- Unit test: auto-detection — 5 turns growing from 1000 to 5000 tokens, then turn 6 at 4800 tokens -> no reset detected (normal slight variation)
- Unit test: explicit `recordContextReset()` emits an `AiContextReset` event with all specified attributes
- Unit test: `compressionRatio` for 5000 tokens -> 1200 tokens = 0.24
- Unit test: `contextResetsCount` increments correctly across multiple resets in one conversation
- Unit test: `avgTokensBetweenResets` with 3 resets at 5000, 6000, 4000 tokens = 5000 average
- Unit test: `contextEfficiency` calculation across a conversation with resets
- Unit test: context management stats appear in the `AiConversationSummary` event

---

### 3.7 — Pre-Built Dashboard: "AI Agent Workflows"

**Implementation:**
- Create `packages/nr-ai-agent/dashboards/ai-agent-workflows.json`
- Build the "AI Agent Workflows" dashboard from Section 7 of the ideation doc:
  - **Row 1 — Key indicators** (Billboard widgets):
    - Task completion rate (`SELECT percentage(count(*), WHERE ai.agent.task_success = true) FROM AiAgentTaskSummary SINCE 24 hours ago`)
    - Average cost per task (`SELECT average(ai.agent.cost_per_task_usd) FROM AiAgentTaskSummary SINCE 24 hours ago`)
    - Average steps per task (`SELECT average(ai.agent.total_steps) FROM AiAgentTaskSummary SINCE 24 hours ago`)
    - Anti-pattern detection count (`SELECT count(*) FROM AiAntiPattern SINCE 24 hours ago`)
  - **Row 2 — Task performance** (Line/Bar charts):
    - Task duration distribution (`SELECT histogram(ai.agent.task_duration_ms, 20) FROM AiAgentTaskSummary SINCE 24 hours ago`)
    - Cost per task over time (`SELECT average(ai.agent.cost_per_task_usd) FROM AiAgentTaskSummary TIMESERIES SINCE 7 days ago`)
    - Steps per task over time (`SELECT average(ai.agent.total_steps) FROM AiAgentTaskSummary TIMESERIES SINCE 7 days ago`)
  - **Row 3 — Anti-patterns** (Table + Pie chart):
    - Anti-pattern distribution (`SELECT count(*) FROM AiAntiPattern FACET type SINCE 7 days ago`)
    - Recent anti-patterns table (`SELECT timestamp, type, traceId, toolName, depthIndex FROM AiAntiPattern SINCE 24 hours ago LIMIT 20`)
    - Spinning wheels rate over time (`SELECT percentage(count(*), WHERE type = 'spinning_wheels') FROM AiAntiPattern TIMESERIES SINCE 7 days ago`)
  - **Row 4 — Tool usage** (Bar/Table charts):
    - Tool call frequency (`SELECT count(*) FROM Span WHERE spanType = 'tool_call' FACET toolName SINCE 24 hours ago`)
    - Tool success rate by tool (`SELECT percentage(count(*), WHERE ai.tool.success = true) FROM Span WHERE spanType = 'tool_call' FACET toolName SINCE 24 hours ago`)
    - Slowest tools (`SELECT average(durationMs) FROM Span WHERE spanType = 'tool_call' FACET toolName SINCE 24 hours ago`)
  - **Row 5 — Agent delegation** (Funnel + Table):
    - Delegation depth distribution (`SELECT histogram(ai.agent.delegation_depth, 5) FROM AiAgentTaskSummary SINCE 7 days ago`)
    - Sub-agent cost breakdown (`SELECT sum(ai.agent.cost_per_task_usd) FROM AiAgentTaskSummary FACET ai.agent.name SINCE 7 days ago`)
    - Context resets per conversation (`SELECT average(ai.context.resets_count) FROM AiConversationSummary SINCE 7 days ago`)
- Update the deploy script to include this dashboard

**Testing:**
- Unit test: validate dashboard JSON structure
- Unit test: all NRQL queries are syntactically valid
- Unit test: deploy script handles the new dashboard
- Manual test: deploy to test NR account; verify all widgets render without errors

---

## Phase 4: Intelligence & Prediction (6-8 weeks)

> **Goal**: Predictive and automated insights.

### 4.1 — Semantic Drift Detection (Embedding-Based Response Monitoring)

**Implementation:**
- Create `packages/nr-ai-agent/src/intelligence/semantic-drift.ts`
- Implement the semantic drift detection system from Section 5.8:
  - **Baseline establishment**: during a configurable baseline period (default: first 24 hours or first 1000 responses), embed a sample of AI responses using a lightweight embedding model
    - Embedding model options: use Gemini's `embedContent()` API (already wrapped in 1.2), or a local embedding model via ONNX Runtime (e.g., `all-MiniLM-L6-v2` for ~25MB), or a user-configured embedding endpoint
    - Default: use the provider's own embedding API if available; fall back to a configurable external endpoint
  - **Baseline centroid**: compute the mean embedding vector across all baseline samples — this is the "expected" response distribution center
  - **Ongoing monitoring**: embed a configurable sample of new responses (default: 10% sampling rate) and compute cosine similarity to the baseline centroid
  - **Drift detection**: alert when average similarity drops below a configurable threshold (default: 0.85) over a rolling window
- Implement `SemanticDriftDetector` class:
  - `initialize(embeddingFn: (text: string) => Promise<number[]>)` — configure the embedding function
  - `recordBaseline(responseText: string)` — add to baseline during establishment period
  - `finalizeBaseline()` — compute centroid, switch to monitoring mode
  - `checkDrift(responseText: string): DriftResult` — embed the response, compute similarity to centroid, return `{ similarity, drifted, centroidDistance }`
  - `getDriftMetrics(): DriftMetrics` — return current rolling average similarity, drift events count, baseline size
- Emit metrics:
  - `ai.drift.similarity_score` (gauge): rolling average cosine similarity to baseline
  - `ai.drift.drift_detected` (event): emitted when drift crosses threshold
  - `ai.drift.baseline_size` (gauge): number of samples in baseline
- Sampling: only embed a configurable percentage of responses to control embedding API cost (configurable via `NEW_RELIC_AI_DRIFT_SAMPLE_RATE`, default 0.1)
- Feature-scoped baselines: maintain separate baselines per `ai.attribution.feature` tag (the "code review" feature has a different expected response distribution than the "chatbot" feature)

**Testing:**
- Unit test: `recordBaseline()` with 100 similar embeddings produces a centroid that is close to each individual embedding
- Unit test: `checkDrift()` with a response similar to baseline returns `similarity > 0.85` and `drifted = false`
- Unit test: `checkDrift()` with a very different response returns `similarity < 0.85` and `drifted = true`
- Unit test: `finalizeBaseline()` switches from baseline to monitoring mode — subsequent `recordBaseline()` calls are ignored
- Unit test: cosine similarity calculation is mathematically correct (test with known vectors)
- Unit test: sampling rate of 0.1 means approximately 10% of responses are checked (statistical test with tolerance)
- Unit test: feature-scoped baselines — two features maintain independent centroids
- Unit test: drift detection emits an `ai.drift.drift_detected` event with correct attributes
- Unit test: rolling window correctly evicts old similarity scores

---

### 4.2 — Quality Degradation Anomaly Detection (Rolling Baseline, Multi-Signal)

**Implementation:**
- Create `packages/nr-ai-agent/src/intelligence/anomaly-detection.ts`
- Extend the quality signal framework (2.4) with statistical anomaly detection from Section 5.4:
  - **Rolling baseline**: maintain a configurable baseline window (default: 7 days or 10,000 requests) of quality signal values
  - **Multi-signal fusion**: combine all available quality signals into a unified anomaly score:
    - Structural signals (always available): stop reason distribution, response length, latency, error rate, thinking depth
    - Application signals (when available): user feedback, regeneration rate, edit distance
    - Semantic signals (when available): drift score from 4.1
  - **Anomaly detection algorithm**: for each signal, maintain a rolling mean and standard deviation; flag when a signal deviates by >N standard deviations (configurable, default N=2) from the baseline
  - **Composite anomaly score**: weighted combination of individual signal anomaly scores, where weights reflect signal reliability:
    - Structural signals: weight 0.3 (always available but indirect)
    - Application signals: weight 0.5 (strong signal when available)
    - Semantic signals: weight 0.2 (computationally expensive, may have latency)
    - Weights are automatically adjusted based on signal availability (if application signals are unavailable, structural signals get proportionally more weight)
- Implement `AnomalyDetector` class:
  - `recordSignal(signalName: string, value: number, timestamp: number)` — add a data point to the rolling window
  - `checkAnomaly(signalName: string, value: number): AnomalyResult` — check if a value is anomalous relative to baseline; returns `{ anomalous, zScore, baselineMean, baselineStdDev }`
  - `getCompositeScore(): number` — 0.0 (no anomalies) to 1.0 (all signals anomalous)
  - `getAnomalyReport(): AnomalyReport` — detailed breakdown per signal
- Emit events and metrics:
  - `ai.quality.anomaly_detected` (event): emitted when composite score exceeds threshold, includes which signals triggered
  - `ai.quality.composite_anomaly_score` (gauge): rolling composite anomaly score
  - `ai.quality.signal_anomaly` (event): per-signal anomaly events for fine-grained alerting
- Integration with NR alerting: the composite score is designed to be used as an NRQL alert condition:
  `SELECT latest(ai.quality.composite_anomaly_score) FROM Metric WHERE ai.quality.composite_anomaly_score > 0.7`

**Testing:**
- Unit test: baseline with 1000 normal data points (mean=100, stddev=10); new value 125 (z=2.5) -> anomalous
- Unit test: baseline with 1000 normal data points; new value 105 (z=0.5) -> not anomalous
- Unit test: rolling window evicts data outside the window period — old anomalies don't affect current baseline
- Unit test: composite score with 1 of 3 signals anomalous produces a score between 0.3 and 0.5 (depending on weights)
- Unit test: composite score with all signals anomalous produces a score near 1.0
- Unit test: composite score with no anomalies produces 0.0
- Unit test: weight auto-adjustment — when only structural signals are available, they receive full weight
- Unit test: `getAnomalyReport()` lists each signal with its current value, baseline mean, z-score, and anomalous flag
- Unit test: `ai.quality.anomaly_detected` event is emitted only when composite score exceeds threshold
- Unit test: anomaly detection works correctly with a cold start (no baseline yet — use a minimum sample size before detecting, e.g., 100 data points)

---

### 4.3 — Predictive Cost Forecasting (Time-Series Projection)

**Implementation:**
- Create `packages/nr-ai-agent/src/intelligence/cost-forecasting.ts`
- Implement the predictive cost forecasting system from Section 5.7:
  - **Data collection**: maintain hourly cost aggregates (total cost, by model, by feature, by team) in a circular buffer covering the trailing 30 days
  - **Forecasting model**: implement a simple but effective time-series projection:
    - **Linear trend**: fit a linear regression to daily cost totals to capture growth/decline
    - **Seasonal adjustment**: detect weekday/weekend patterns and business-hours patterns from the trailing data
    - **Change-point awareness**: if a recent prompt change or model migration is detected (via attribution tags or config changes), weight recent data more heavily
  - **Projection output**: forecast daily cost for the next 7 and 30 days, with confidence intervals (based on historical variance)
- Implement `CostForecaster` class:
  - `recordCost(timestamp: number, costUsd: number, dimensions: { model, feature, team })` — feed a cost data point
  - `forecast(horizonDays: number): CostForecast` — returns:
    - `projectedDailyCostUsd`: array of daily projected costs
    - `projectedMonthlyCostUsd`: sum of projected daily costs for the next 30 days
    - `confidenceIntervalLow`, `confidenceIntervalHigh`: 90% confidence bounds
    - `growthRatePercent`: daily cost growth rate
    - `projectedBudgetExceedDate`: date when projected cumulative cost exceeds a configured budget (null if within budget)
  - `forecastByDimension(dimension: 'model' | 'feature' | 'team', horizonDays: number): Record<string, CostForecast>` — per-dimension forecasts
- Emit forecast metrics at each 60s harvest (but recompute forecast less frequently — every 1 hour):
  - `ai.forecast.projected_daily_cost_usd` (gauge)
  - `ai.forecast.projected_monthly_cost_usd` (gauge)
  - `ai.forecast.growth_rate_percent` (gauge)
  - `ai.forecast.budget_exceed_date` (attribute, ISO date string or "none")
- Emit forecast alert events:
  - `AiCostForecastAlert` when projected monthly cost exceeds a configured budget threshold
  - `AiCostGrowthAlert` when daily growth rate exceeds a configured threshold (e.g., >10%/day)
- Budget configuration: `NEW_RELIC_AI_MONTHLY_BUDGET_USD` env var — if set, enables budget-exceed forecasting

**Testing:**
- Unit test: linear regression on 7 daily cost data points with clear upward trend — forecast projects higher costs
- Unit test: flat cost data (same daily cost) — forecast projects the same cost, growth rate near 0%
- Unit test: seasonal adjustment — weekday costs 2x weekend costs — forecast for a Monday is higher than for a Saturday
- Unit test: confidence interval — higher historical variance produces wider confidence intervals
- Unit test: `projectedBudgetExceedDate` with a $10K monthly budget and $400/day spend -> exceeds around day 25
- Unit test: `projectedBudgetExceedDate` is null when spend is within budget
- Unit test: per-dimension forecast — different growth rates per model produce different model-level projections
- Unit test: `AiCostForecastAlert` is emitted when projected monthly cost exceeds configured budget
- Unit test: `AiCostGrowthAlert` is emitted when growth rate exceeds threshold
- Unit test: forecast with insufficient data (<7 days) returns a low-confidence projection with wider intervals

---

### 4.4 — Automated Recommendations ("Switch Model X to Y for This Workload")

**Implementation:**
- Create `packages/nr-ai-agent/src/intelligence/recommendations.ts`
- Implement an automated recommendation engine from Section 5.6 that generates actionable insights based on observed data:
  - **Model optimization recommendations**: compare cost, latency, and quality across models for the same workload category:
    - "Claude Opus costs $0.47/request for code review but Claude Sonnet scores within 5% on quality at $0.05/request — consider switching"
    - "Gemini Flash handles summarization at 1/3 the cost of Claude Sonnet with comparable quality"
    - Logic: for each workload category (feature tag), compare all models used on cost-per-quality-point; recommend cheaper models that maintain quality within a configurable tolerance (default: 10% quality degradation max)
  - **Cache optimization recommendations**:
    - "Your system prompt changed 3 times today, invalidating the cache each time — cache hit rate dropped from 85% to 12%"
    - "Feature X has 0% cache hit rate but uses a static system prompt — enable prompt caching to save an estimated $X/day"
    - Logic: analyze cache hit rate by feature; identify features with cacheable patterns but low hit rates; estimate savings from caching based on their token volumes
  - **Thinking budget recommendations**:
    - "Thinking budget utilization is consistently at 100% for complex tasks — consider increasing budget from 4K to 8K tokens"
    - "Thinking budget utilization averages 15% for simple queries — consider reducing or disabling thinking to save $X/day"
    - Logic: analyze budget utilization distribution; recommend increases when consistently maxed, decreases when consistently under-utilized
  - **Context management recommendations**:
    - "Average conversations hit context limits after 12 turns — implement summarization after turn 8 to maintain quality"
    - Logic: analyze context pressure trajectories and correlate with quality score changes
- Implement `RecommendationEngine` class:
  - `analyze(): Recommendation[]` — run all recommendation analyzers against current accumulated data; return prioritized recommendations
  - Each `Recommendation` has: `type`, `severity` (`info` | `warning` | `critical`), `title` (short), `description` (detailed), `estimatedImpact` (e.g., "$340/day savings"), `confidence` (0.0-1.0 based on data volume)
  - Runs periodically (configurable, default: every 6 hours) or on-demand via `agent.getRecommendations()`
- Emit recommendations as `AiRecommendation` custom events, enabling:
  - NR dashboard widget showing current recommendations
  - NRQL alerting on high-severity recommendations

**Testing:**
- Unit test: model optimization — two models with same workload, one 5x cheaper with 8% quality difference -> recommendation generated
- Unit test: model optimization — two models with same workload, cheaper one has 25% quality drop -> no recommendation (quality gap too large)
- Unit test: cache optimization — feature with static system prompt and 0% cache hit rate -> recommendation to enable caching with estimated savings
- Unit test: cache optimization — feature with 90% cache hit rate -> no recommendation (already optimized)
- Unit test: thinking budget at 100% utilization for >50% of requests -> recommendation to increase budget
- Unit test: thinking budget at 10% utilization -> recommendation to reduce/disable thinking with cost savings estimate
- Unit test: context pressure reaching limit at turn 12 with quality degradation at turn 10 -> recommendation to implement summarization
- Unit test: recommendation confidence scales with data volume — 10 data points = low confidence, 1000 = high confidence
- Unit test: recommendations are prioritized by estimated impact (highest savings first)
- Unit test: `AiRecommendation` events contain all required attributes

---

### 4.5 — A/B Experiment Tracking (Compare Prompt Versions, Model Versions)

**Implementation:**
- Create `packages/nr-ai-agent/src/intelligence/experiments.ts`
- Implement A/B experiment tracking to compare prompt versions, model versions, or configuration changes:
  - **Experiment definition**: users define experiments with a name, variants, and metrics to compare:
    ```typescript
    agent.defineExperiment({
      name: 'system-prompt-v3-test',
      variants: ['control', 'variant-a', 'variant-b'],
      metrics: ['ai.cost.total_usd', 'ai.request.duration_ms', 'ai.quality.score'],
      startDate: new Date('2025-06-01'),
      endDate: new Date('2025-06-14'), // optional
    });
    ```
  - **Variant assignment**: per-request, the user tags which variant is active:
    - Via attribution metadata: `metadata: { nr: { experiment: 'system-prompt-v3-test', variant: 'variant-a' } }`
    - Via context API: `agent.setExperimentVariant('system-prompt-v3-test', 'variant-a')`
  - **Metric collection**: the agent automatically segments all metrics by experiment variant, enabling:
    - `SELECT average(ai.cost.total_usd) FROM AiResponse FACET ai.experiment.variant WHERE ai.experiment.name = 'system-prompt-v3-test' SINCE 7 days ago`
  - **Statistical comparison**: for each metric, compute:
    - Per-variant mean, median, p95, standard deviation
    - Relative difference between variants (e.g., "variant-a is 12% cheaper than control")
    - Statistical significance (two-sample t-test or Mann-Whitney U test, depending on distribution normality)
    - Sample size and confidence level
- Implement `ExperimentTracker` class:
  - `defineExperiment(config)` — register an experiment
  - `tagRequest(experimentName, variant)` — tag the current request with an experiment variant
  - `getExperimentResults(experimentName): ExperimentResults` — compute comparison metrics across variants
  - `ExperimentResults` includes: per-variant stats, pairwise comparisons with relative differences and p-values, recommended winner (if statistically significant)
- Emit experiment data:
  - Variant tags on all `AiRequest`/`AiResponse` events: `ai.experiment.name`, `ai.experiment.variant`
  - Periodic `AiExperimentSummary` events (every 6 hours) with per-variant aggregated stats
  - `AiExperimentConclusion` event when an experiment reaches statistical significance or its end date
- Store active experiments in memory; persist experiment definitions to config file for restart resilience

**Testing:**
- Unit test: `defineExperiment()` registers an experiment; `tagRequest()` adds variant attributes to events
- Unit test: `getExperimentResults()` with 100 "control" requests (mean cost $0.05) and 100 "variant-a" requests (mean cost $0.04) -> variant-a is 20% cheaper with correct p-value
- Unit test: statistical significance test — large effect size with 100+ samples -> significant (p < 0.05); same data with only 5 samples -> not significant
- Unit test: multiple metrics compared simultaneously — each metric gets independent comparison stats
- Unit test: experiment with 3 variants produces pairwise comparisons for all 3 pairs
- Unit test: variant tags appear on `AiRequest` and `AiResponse` events
- Unit test: `AiExperimentSummary` event includes per-variant aggregates
- Unit test: `AiExperimentConclusion` emitted when experiment end date is reached
- Unit test: experiment variant set via context API propagates across async boundaries (AsyncLocalStorage)

---

### 4.6 — OpenTelemetry Export Compatibility

**Implementation:**
- Create `packages/nr-ai-agent/src/export/otel.ts`
- Implement OTLP (OpenTelemetry Protocol) export as an optional secondary export target (per design decision #10):
  - **Attribute mapping**: map all agent-specific attributes to OTel GenAI semantic conventions where they exist:
    - `ai.request.model` -> `gen_ai.request.model`
    - `ai.tokens.input` -> `gen_ai.usage.input_tokens`
    - `ai.tokens.output` -> `gen_ai.usage.output_tokens`
    - `ai.request.duration_ms` -> standard span `duration`
    - `ai.request.temperature` -> `gen_ai.request.temperature`
    - `ai.request.max_tokens` -> `gen_ai.request.max_output_tokens`
    - `ai.response.stop_reason` -> `gen_ai.response.finish_reasons`
    - Agent-specific attributes with no OTel equivalent keep their `ai.*` prefix (e.g., `ai.reasoning.depth_index`, `ai.cost.total_usd`, `ai.agent.total_steps`)
  - **Span export**: convert agent spans (from 3.1 tracer) to OTel spans:
    - Map `LlmCall` spans to OTel `gen_ai` client spans
    - Map `ToolCall` spans to OTel internal spans with tool semantic conventions
    - Map `AgentTask` spans to OTel server/internal spans
    - Include trace context propagation (`traceparent` header support)
  - **Metric export**: convert agent metrics to OTel metrics:
    - Gauge metrics -> OTel gauge data points
    - Counter metrics -> OTel sum data points (monotonic)
    - Histogram metrics -> OTel histogram data points
  - **OTLP transport**: implement OTLP/HTTP JSON exporter:
    - `POST` to configurable endpoint (default: `http://localhost:4318/v1/traces` for spans, `/v1/metrics` for metrics)
    - Support `NEW_RELIC_OTLP_ENDPOINT` env var for the NR OTLP endpoint
    - Include proper OTel headers (`Content-Type: application/json`)
- Configuration:
  - `NEW_RELIC_AI_OTLP_EXPORT_ENABLED=true` — enable OTLP export (default: false)
  - `NEW_RELIC_AI_OTLP_ENDPOINT` — OTLP endpoint URL
  - OTLP export runs in parallel with the primary NR Events/Metric API export (dual-write)
- Optional: if `@opentelemetry/sdk-node` is installed, register as an OTel SpanExporter/MetricExporter using the official OTel SDK interfaces rather than a custom OTLP client

**Testing:**
- Unit test: attribute mapping — all OTel GenAI convention attributes are correctly mapped (table-driven test comparing input attributes to expected OTel attribute names)
- Unit test: agent-specific attributes with no OTel equivalent retain their `ai.*` prefix
- Unit test: `LlmCall` span converts to valid OTel span with `gen_ai.*` attributes
- Unit test: `ToolCall` span converts to valid OTel internal span
- Unit test: metric export produces valid OTLP metric JSON structure
- Unit test: OTLP transport sends to the configured endpoint with correct headers
- Unit test: when `OTLP_EXPORT_ENABLED=false`, no OTLP export occurs
- Unit test: dual-write — both NR and OTLP exports fire for the same data
- Integration test: send spans to a local OTel Collector and verify they appear correctly (requires a running collector; skip in CI if not available)

---

### 4.7 — Custom Instrumentation API for User-Defined AI Metrics

**Implementation:**
- Create `packages/nr-ai-agent/src/api/custom-metrics.ts`
- Implement a public API that allows users to define and emit custom AI metrics beyond what the agent automatically captures:
  - **Custom events**:
    ```typescript
    agent.recordCustomEvent('AiEvaluation', {
      promptVersion: 'v3.2',
      evaluationScore: 0.87,
      evaluationModel: 'claude-opus-4',
      groundTruthMatch: true,
      latencyMs: 1200,
    });
    ```
    - Validate attribute types (string, number, boolean only — NR custom events don't support nested objects)
    - Validate attribute name length (max 255 chars) and value length (max 4096 chars for strings)
    - Add standard agent attributes automatically (`ai.app_name`, `ai.agent_version`, timestamp)
  - **Custom metrics**:
    ```typescript
    agent.recordCustomMetric('ai.custom.eval_score', 0.87, {
      promptVersion: 'v3.2',
      model: 'claude-opus-4',
    });
    ```
    - Supports gauge, counter, and summary metric types
    - Automatically aggregated by the `MetricAggregator` (from 1.8) and sent at the 60s harvest
  - **Custom spans**:
    ```typescript
    const span = agent.startCustomSpan('ai.custom.eval_pipeline', { evalType: 'reference' });
    // ... do evaluation work ...
    span.setAttribute('score', 0.87);
    span.end();
    ```
    - Integrates with the agentic tracer (3.1) — custom spans appear in the trace tree
    - If no parent span is active, creates a standalone span
  - **Decorator/wrapper pattern** (convenience):
    ```typescript
    const evaluateResponse = agent.instrument('ai.custom.evaluation', async (response) => {
      const score = await runEval(response);
      return score;
    });
    ```
    - Automatically creates a span, measures duration, captures return value as an attribute
- Validation:
  - Event names must match NR custom event naming rules (alphanumeric, max 255 chars, no `Nr` prefix)
  - Metric names must follow `ai.custom.*` prefix convention
  - Attribute values are validated and truncated if needed (not rejected — truncation with a warning is friendlier than rejection)
- All custom data flows through the same event buffer and harvest scheduler as auto-captured data

**Testing:**
- Unit test: `recordCustomEvent()` creates an event with correct attributes and standard agent attributes
- Unit test: `recordCustomEvent()` validates attribute types — rejects nested objects, arrays
- Unit test: `recordCustomEvent()` truncates long string values to 4096 chars with a warning
- Unit test: `recordCustomMetric()` registers the metric in the `MetricAggregator` with correct name and dimensions
- Unit test: `startCustomSpan()` creates a span that integrates with the active trace context
- Unit test: `startCustomSpan()` with no active trace creates a standalone span
- Unit test: `instrument()` wrapper measures duration and captures return value
- Unit test: `instrument()` wrapper propagates errors (doesn't swallow exceptions)
- Unit test: event name validation — rejects names starting with `Nr`, rejects names > 255 chars
- Unit test: custom events and metrics flow through the event buffer and are sent at harvest time
- Integration test: record a custom event, trigger harvest, verify the event appears in NR NRQL query

---

