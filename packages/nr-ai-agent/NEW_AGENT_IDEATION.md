# New Relic AI Agent — Ideation Document

> Designing a purpose-built New Relic agent for deep observability of AI systems, with first-class support for Anthropic Claude and Google Gemini.

---

## Table of Contents

1. [Vision](#1-vision)
2. [Why a Dedicated AI Agent](#2-why-a-dedicated-ai-agent)
3. [What to Instrument](#3-what-to-instrument)
4. [Metric Taxonomy](#4-metric-taxonomy)
5. [Novel Metrics Deep Dive](#5-novel-metrics-deep-dive)
6. [Architecture](#6-architecture)
7. [Dashboard & Alerting Ideas](#7-dashboard--alerting-ideas)
8. [Implementation Phases](#8-implementation-phases)
9. [Open Questions](#9-open-questions)

---

## 1. Vision

**The thesis**: AI systems are becoming the most expensive, least observable components in modern software. Organizations are spending thousands of dollars per day on API calls with minimal visibility into whether that spend is effective, whether quality is degrading, or where latency bottlenecks live.

Existing New Relic agents bolt AI monitoring onto APM agents as an afterthought — the Python agent's `ai_monitoring` is a config flag that adds LLM events to a general-purpose agent. This works for basic tracking but misses the deeper observability that AI-native systems need.

**A dedicated AI agent would treat every AI interaction as a first-class observable event** — the way APM agents treat every HTTP transaction. It would understand reasoning depth, cost attribution, quality trajectories, agentic workflow patterns, and failure modes that are unique to AI systems.

### Target Users

- **Engineering teams** running AI features in production (chatbots, copilots, code generation, content creation)
- **Platform teams** managing AI infrastructure and cost allocation across teams
- **ML/AI engineers** debugging model behavior, evaluating prompt changes, and comparing providers
- **Finance/ops teams** tracking and forecasting AI spend

---

## 2. Why a Dedicated AI Agent

### What Exists Today (Gaps in Current Agents)

The New Relic Python agent already tracks 7 LLM event types (LlmChatCompletionSummary, LlmChatCompletionMessage, LlmEmbedding, LlmTool, LlmAgent, LlmVectorSearch, LlmVectorSearchResult) for OpenAI, Gemini, LangChain, AutoGen, and Strands.

**What's missing:**

| Gap | Impact |
|-----|--------|
| No direct Anthropic/Claude SDK instrumentation | Only available via AWS Bedrock wrapper — misses direct API users, Claude-specific features like extended thinking |
| No cost estimation | Users can't answer "how much did this conversation cost?" |
| No built-in token counting | Requires user-provided callback function |
| No reasoning/thinking metrics | Claude's thinking blocks and Gemini 2.5's thinking are invisible |
| No prompt caching tracking | Claude's cache_read_input_tokens can save 90% — but you can't see if it's working |
| No quality metrics | No way to detect if AI responses are degrading over time |
| No agentic workflow observability | Tool chains, retry loops, and planning cycles are opaque |
| No multi-modal tracking | Image/audio/video inputs have different costs and latencies — not tracked |
| No safety/content policy metrics | Gemini safety ratings and Claude content filtering are invisible |
| No cross-provider comparison | Can't compare Claude vs Gemini on the same workload |
| Python-only | No support in Node.js/TypeScript (the most common AI SDK language) |

### Why Not Just Extend the Python Agent?

You could — but:
1. AI systems increasingly use **TypeScript/Node.js** (Anthropic SDK, Vercel AI SDK, LangChain.js) or **Go** — no Python agent available
2. The overhead model is wrong — APM agents optimize for low overhead on high-throughput web requests; AI calls are **low-frequency, high-cost** events where richer data collection per call is acceptable
3. AI-specific concepts (reasoning depth, cost attribution, quality scoring, agentic loops) don't map cleanly to APM abstractions (transactions, segments, metrics)
4. A dedicated agent can provide **AI-native dashboards** out of the box instead of requiring custom NRQL queries

---

## 3. What to Instrument

### Primary SDK Targets

#### Anthropic Claude SDK

**Python** (`anthropic` package) and **TypeScript** (`@anthropic-ai/sdk`):

| Method | What to Capture |
|--------|----------------|
| `messages.create()` | Full request/response: model, messages, system prompt, tools, thinking config, token usage, stop_reason, latency |
| `messages.stream()` | All of the above + time-to-first-token, inter-token latency, streaming chunk count |
| `messages.create(thinking={...})` | Thinking block content (if permitted), thinking token count, thinking duration |
| `messages.batches.create()` | Batch size, batch completion time, per-request breakdown |
| Tool use results | Tool name, input/output, execution time, success/failure |
| Prompt caching | `cache_creation_input_tokens`, `cache_read_input_tokens` from usage response |

**Claude-specific features to track:**
- **Extended thinking**: `thinking` content blocks with `budget_tokens`, actual thinking tokens used, thinking-to-output ratio
- **Prompt caching**: Cache creation vs cache read tokens, cache hit rate, cost savings
- **Content block types**: text, tool_use, tool_result, thinking — distribution per request
- **Stop reasons**: end_turn, max_tokens, stop_sequence, tool_use — distribution over time
- **Beta headers**: Which beta features are being used (`anthropic-beta` header values)
- **Token budget utilization**: `max_tokens` requested vs actual output tokens used

#### Google Gemini SDK

**Python** (`google-genai`) and **TypeScript** (`@google/genai`):

| Method | What to Capture |
|--------|----------------|
| `generate_content()` | Model, messages, generation config, token usage, finish reason, latency |
| `generate_content_stream()` | Streaming metrics + time-to-first-token |
| `embed_content()` | Embedding model, input tokens, latency |
| `count_tokens()` | Token counting calls and results |

**Gemini-specific features to track:**
- **Safety ratings**: Per-category scores (harassment, hate speech, sexually explicit, dangerous content, civic integrity) — trend over time
- **Grounding metadata**: Whether Google Search grounding was used, search queries, grounding confidence
- **Context window utilization**: Gemini supports 1M+ tokens — track actual usage vs capacity
- **Code execution**: Built-in code execution tool usage and results
- **Thinking (Gemini 2.5)**: Thinking tokens, reasoning process metrics
- **Cached content**: Context caching API usage and hit rates
- **Multi-modal inputs**: Image, video, audio — track input type distribution and per-modality cost

### Secondary Targets (Agentic Frameworks)

| Framework | What to Track |
|-----------|--------------|
| **LangChain / LangGraph** | Chain execution, graph node traversal, tool calls, retrieval operations, agent loops |
| **Vercel AI SDK** | Streaming, tool calls, structured output, multi-step generation |
| **CrewAI** | Agent roles, task delegation, inter-agent communication, crew completion |
| **AutoGen** | Multi-agent conversations, tool execution, termination conditions |
| **Claude Code / Agentic Claude** | Command execution, file operations, agent spawning, plan creation/approval |

### Tertiary Targets (Infrastructure)

| Component | What to Track |
|-----------|--------------|
| **Vector databases** (Pinecone, Weaviate, Chroma, pgvector) | Query latency, result count, embedding dimensions, index size |
| **RAG pipelines** | Retrieval latency, chunk count, relevance scores, context assembly time |
| **Model routers** (LiteLLM, Portkey, Helicone) | Routing decisions, fallback triggers, load balancing |
| **Guardrails** (Guardrails AI, NeMo) | Check pass/fail rates, latency overhead, violation types |

---

## 4. Metric Taxonomy

Every metric the agent could collect, organized by category:

### 4.1 Speed & Latency Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `ai.request.duration_ms` | Total wall-clock time from request to complete response | Wrapper timing |
| `ai.request.time_to_first_token_ms` | Time from request start to first content token received | Stream delta timing |
| `ai.request.inter_token_latency_ms` | Average time between consecutive tokens in streaming | Stream delta timing |
| `ai.request.tokens_per_second` | Output token generation speed | `output_tokens / duration` |
| `ai.request.thinking_duration_ms` | Time spent in extended thinking (Claude) | Thinking block timing in stream |
| `ai.request.generation_duration_ms` | Time spent generating output (excluding thinking) | `duration - thinking_duration` |
| `ai.request.queue_time_ms` | Time waiting in provider queue before processing starts | Stream `message_start` - request sent |
| `ai.request.overhead_ms` | SDK/network overhead (serialization, TLS, etc.) | `duration - (thinking + generation)` |

### 4.2 Token & Cost Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `ai.tokens.input` | Input tokens consumed | API response `usage` |
| `ai.tokens.output` | Output tokens generated | API response `usage` |
| `ai.tokens.thinking` | Thinking/reasoning tokens (Claude extended thinking, Gemini 2.5) | API response `usage` |
| `ai.tokens.cache_read` | Tokens served from prompt cache (Claude) | `cache_read_input_tokens` |
| `ai.tokens.cache_creation` | Tokens written to prompt cache (Claude) | `cache_creation_input_tokens` |
| `ai.tokens.total` | Total tokens (input + output + thinking) | Computed |
| `ai.cost.input_usd` | Cost of input tokens at current model pricing | `input_tokens * price_per_token` |
| `ai.cost.output_usd` | Cost of output tokens | `output_tokens * price_per_token` |
| `ai.cost.thinking_usd` | Cost of thinking tokens | `thinking_tokens * price_per_token` |
| `ai.cost.cache_read_usd` | Cost of cache-read tokens (discounted) | `cache_read_tokens * cached_price` |
| `ai.cost.cache_creation_usd` | Cost of cache-write tokens (premium) | `cache_creation_tokens * write_price` |
| `ai.cost.total_usd` | Total cost of the request | Sum of all cost components |
| `ai.cost.savings_from_cache_usd` | Money saved via prompt caching | `cache_read_tokens * (full_price - cached_price)` |
| `ai.cost.per_conversation_usd` | Cumulative cost of a conversation | Sum across conversation turns |
| `ai.context.window_utilization` | Percentage of model's context window used | `total_tokens / model_context_limit` |
| `ai.context.input_output_ratio` | Ratio of input to output tokens | `input_tokens / output_tokens` |

### 4.3 Reasoning & Thinking Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `ai.reasoning.thinking_tokens` | Number of tokens used for extended thinking | API response |
| `ai.reasoning.thinking_budget_tokens` | Max thinking tokens allowed | Request config |
| `ai.reasoning.budget_utilization` | % of thinking budget actually used | `thinking_tokens / budget_tokens` |
| `ai.reasoning.thinking_to_output_ratio` | Thinking tokens per output token | `thinking_tokens / output_tokens` |
| `ai.reasoning.depth_index` | Composite reasoning intensity score (0-1) | Normalized composite of thinking ratio + duration |
| `ai.reasoning.thinking_efficiency` | Output quality relative to thinking investment | Requires quality scoring integration |

### 4.4 Quality & Correctness Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `ai.quality.user_feedback_score` | Explicit user rating (thumbs up/down, 1-5 stars) | Application-provided callback |
| `ai.quality.regeneration_rate` | % of responses that were regenerated/retried | Application tracking |
| `ai.quality.edit_distance` | How much the user modified the AI output before using it | Application-provided callback |
| `ai.quality.stop_reason_distribution` | Distribution of stop reasons over time | `stop_reason` field |
| `ai.quality.max_tokens_hit_rate` | % of responses truncated by max_tokens | `stop_reason == "max_tokens"` |
| `ai.quality.tool_call_success_rate` | % of tool calls that succeeded | Tool result tracking |
| `ai.quality.hallucination_flag_rate` | % of responses flagged by guardrails/user as incorrect | Application-provided callback |
| `ai.quality.semantic_similarity_to_expected` | Cosine similarity between response and expected output | Embedding comparison (optional) |
| `ai.quality.response_consistency` | Variance in responses to identical/similar prompts | Embedding comparison across runs |
| `ai.quality.safety_rating` | Gemini safety category scores | Gemini API response |
| `ai.quality.content_filter_triggered` | Whether content filtering altered the response | API response flags |

### 4.5 Agentic Workflow Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `ai.agent.total_steps` | Number of steps in an agentic workflow | Step counter |
| `ai.agent.tool_calls_per_task` | Average tool invocations per task completion | Tool call counter |
| `ai.agent.tool_call_chain_depth` | Deepest sequential tool call chain | Call tree depth |
| `ai.agent.planning_iterations` | Number of plan revisions before execution | Plan event counter |
| `ai.agent.backtrack_count` | Times the agent reversed a decision or retried | Heuristic detection |
| `ai.agent.loop_detection` | Circular tool call patterns (doing the same thing repeatedly) | Pattern matching on tool sequences |
| `ai.agent.task_completion_rate` | % of tasks that reach a successful end state | Task lifecycle tracking |
| `ai.agent.task_duration_ms` | Total time from task start to completion | Task lifecycle timing |
| `ai.agent.tokens_per_task` | Total token consumption for a complete task | Sum across task's API calls |
| `ai.agent.cost_per_task_usd` | Total cost for a complete task | Sum of per-request costs |
| `ai.agent.context_resets` | Number of times context was summarized/compressed due to length | Context management tracking |
| `ai.agent.delegation_count` | Times the agent spawned sub-agents or delegated to other models | Sub-agent creation events |
| `ai.agent.human_intervention_rate` | % of tasks requiring human escalation | Escalation event tracking |

### 4.6 Error & Reliability Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `ai.error.rate` | Overall error rate across requests | Error counter / total |
| `ai.error.rate_limit_hits` | 429 responses from provider | HTTP status tracking |
| `ai.error.rate_limit_tokens_remaining` | Remaining tokens in rate limit window | Response headers |
| `ai.error.rate_limit_requests_remaining` | Remaining requests in rate limit window | Response headers |
| `ai.error.overloaded_rate` | 529 (Claude) / 503 responses | HTTP status tracking |
| `ai.error.content_policy_blocks` | Requests blocked by content policy | Error classification |
| `ai.error.context_length_exceeded` | Requests that exceeded context window | Error classification |
| `ai.error.timeout_rate` | % of requests that timed out | Timeout detection |
| `ai.error.retry_count` | Number of retries before success | Retry tracking |
| `ai.error.fallback_triggers` | Times a fallback model/provider was used | Routing decision tracking |
| `ai.error.provider_availability` | Uptime % per provider endpoint | Success rate calculation |

### 4.7 Conversation & Session Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `ai.conversation.turn_count` | Messages in a conversation | Message counter |
| `ai.conversation.total_tokens` | Cumulative tokens across all turns | Running sum |
| `ai.conversation.total_cost_usd` | Cumulative cost across all turns | Running sum |
| `ai.conversation.context_growth_rate` | How quickly context is growing per turn | Token delta per turn |
| `ai.conversation.estimated_turns_remaining` | Turns before hitting context limit at current growth rate | `(limit - current) / avg_growth` |
| `ai.conversation.system_prompt_token_share` | % of context consumed by system prompt | `system_tokens / total_input` |
| `ai.conversation.duration_ms` | Wall-clock time of entire conversation | Conversation lifecycle |
| `ai.conversation.user_wait_time_ms` | Time user spent waiting for AI responses | Sum of request durations |

---

## 5. Novel Metrics Deep Dive

These are the metrics that don't exist in any current observability tool and represent genuine innovation opportunities.

### 5.1 Reasoning Depth Profiling

**The problem**: Organizations using Claude's extended thinking or Gemini 2.5's thinking have no visibility into whether the model is actually "thinking harder" on difficult problems or wasting tokens on simple ones.

**The solution**: A **Reasoning Depth Profile** that correlates thinking investment with output quality.

```
Reasoning Depth Index = normalize(
    thinking_tokens / output_tokens     * 0.4    // token investment
  + thinking_duration / total_duration  * 0.3    // time investment  
  + thinking_budget_utilization         * 0.3    // budget utilization
)
```

**What you can do with this:**
- Alert when thinking budget utilization drops below a threshold (model may not be engaging deeply enough)
- Alert when it's consistently at 100% (budget may be too low, model may be cutting reasoning short)
- Correlate reasoning depth with downstream quality metrics (user feedback, edit distance) to find the optimal thinking budget
- Compare reasoning depth across prompt versions to measure prompt engineering effectiveness
- Detect "reasoning regression" — when a model update causes less thoughtful responses

**Visualization**: A scatter plot with reasoning depth index on X axis, quality score on Y axis, cost as bubble size. The goal is to find the efficient frontier — maximum quality for minimum reasoning cost.

### 5.2 Prompt Cache Economics

**The problem**: Claude's prompt caching can reduce costs by 90% for cache hits, but there's a 25% premium for cache writes. Organizations need to know: is our caching strategy actually saving money?

**The solution**: Real-time cache economics tracking.

```
Cache Efficiency Score = cache_savings_usd / (cache_savings_usd + cache_creation_premium_usd)
```

**Metrics:**
- `cache_hit_rate` — % of requests that used cached tokens
- `cache_savings_usd` — actual dollars saved from cache reads
- `cache_creation_cost_usd` — premium paid for cache writes
- `cache_net_savings_usd` — savings minus creation costs
- `cache_roi` — return on cache investment over time
- `cache_ttl_effectiveness` — % of cached content actually reused before expiration

**Visualization**: A time-series showing cumulative cache savings vs creation costs, with a crossover point where caching becomes net-positive. Alert when cache hit rate drops (e.g., system prompt changed, invalidating cache).

### 5.3 AI Cost Attribution

**The problem**: "We spent $47,000 on AI last month" — but which team? Which feature? Which conversations were the most expensive?

**The solution**: Multi-dimensional cost attribution, similar to cloud cost allocation.

**Attribution dimensions:**
- **By feature**: "The code review feature costs $12K/month, the chatbot costs $8K/month"
- **By team**: Engineering team vs support team vs marketing team
- **By model**: Claude Opus vs Claude Sonnet vs Gemini Flash
- **By user**: Per-user cost tracking for internal tools (e.g., Copilot usage per developer)
- **By conversation**: Top 10 most expensive conversations this week
- **By error**: Cost of requests that ultimately failed or were retried
- **By thinking**: Cost of reasoning tokens vs output tokens

**Built-in pricing table** (updatable):
```
claude-sonnet-4:    input=$3.00/MTok  output=$15.00/MTok  cache_read=$0.30/MTok
claude-opus-4:      input=$15.00/MTok output=$75.00/MTok  cache_read=$1.50/MTok
gemini-2.5-pro:     input=$1.25/MTok  output=$10.00/MTok  (<=200k context)
gemini-2.5-flash:   input=$0.15/MTok  output=$0.60/MTok   thinking=$0.60/MTok
```

The agent maintains an updatable pricing configuration so cost calculations stay current without agent updates.

### 5.4 Quality Degradation Detection

**The problem**: AI quality can degrade silently — a model update, a prompt regression, or increased load can cause subtle quality drops that aren't caught until users complain.

**The solution**: Multi-signal quality scoring with trend detection.

**Signal sources (from least to most effort to integrate):**

1. **Structural signals** (zero-effort, always available):
   - Stop reason shifts: sudden increase in `max_tokens` truncations
   - Response length anomalies: mean response length drifting
   - Latency anomalies: TTFT or total duration spiking
   - Error rate changes: increased refusals, content blocks
   - Thinking depth changes: thinking budget utilization patterns shifting

2. **Application-provided signals** (callback integration):
   - User feedback (thumbs up/down, ratings)
   - Regeneration events (user asked for a new response)
   - Edit distance (how much the user modified the output)
   - Task completion (did the AI-assisted task succeed?)

3. **Automated evaluation signals** (optional, advanced):
   - Reference-based scoring: compare output against known-good responses
   - LLM-as-judge: use a separate model to evaluate response quality
   - Semantic consistency: embedding similarity across runs with similar inputs
   - Factual grounding: cross-reference claims against source documents

**Anomaly detection**: Use a rolling window baseline (e.g., 24h or 7d) and alert when any quality signal deviates by >2 standard deviations. The composite quality score weights these signals based on availability — if you only have structural signals, the score is less confident but still useful.

### 5.5 Agentic Workflow Tracing

**The problem**: AI agents (Claude Code, LangGraph workflows, CrewAI teams) execute multi-step plans with tool calls, sub-agent delegation, and decision loops. Current observability tools see each API call in isolation — they can't show the agentic "transaction."

**The solution**: Treat an agentic workflow as a **distributed trace** where each step is a span.

**Agentic trace structure:**
```
[AgentTask] "Fix the failing test"                          12.4s  $0.47
  ├─ [LlmCall] claude-sonnet-4 "analyze the error"          2.1s  $0.03
  │    └─ thinking: 847 tokens, depth_index: 0.72
  ├─ [ToolCall] read_file "src/auth.test.ts"                 0.1s
  ├─ [ToolCall] read_file "src/auth.ts"                      0.1s
  ├─ [LlmCall] claude-sonnet-4 "identify the fix"           3.2s  $0.05
  │    └─ thinking: 1,203 tokens, depth_index: 0.81
  ├─ [ToolCall] edit_file "src/auth.ts" (lines 47-52)       0.1s
  ├─ [ToolCall] run_tests "npm test"                         4.8s
  │    └─ result: PASS
  └─ [LlmCall] claude-sonnet-4 "confirm completion"         1.9s  $0.02
```

**What this enables:**
- See the full "story" of how an agent solved a problem
- Identify which steps are bottlenecks (usually tool execution, not LLM calls)
- Detect anti-patterns: excessive retries, circular tool calls, unnecessary LLM calls
- Compare efficiency across different agent configurations or prompt versions
- Calculate cost-per-task and optimize the most expensive workflows

**Anti-pattern detection:**
- **Spinning wheels**: Agent calls the same tool >3 times with similar inputs
- **Overthinking**: Reasoning depth index >0.9 for simple tasks (cost waste)
- **Underthinking**: Reasoning depth <0.2 for complex tasks (quality risk)
- **Context stuffing**: >80% of context window used by prior conversation, leaving little room for reasoning
- **Token explosion**: Single turn consuming >50% of context window
- **Bail-out pattern**: Agent gives up and asks the user after <2 attempts

### 5.6 Provider Comparison & Routing Intelligence

**The problem**: Organizations use multiple AI providers but lack data to make informed routing decisions.

**The solution**: Automated A/B comparison metrics.

**For the same prompt category, compare across providers:**
- Latency (TTFT, total, tokens/sec)
- Cost per equivalent output
- Quality score (if feedback is available)
- Error/retry rate
- Thinking efficiency (reasoning tokens per quality point)

**Derived recommendations:**
- "Claude Opus scores 12% higher on code review tasks but costs 5x more than Gemini Flash — Gemini Flash is the better value for routine reviews"
- "Claude Sonnet's prompt caching saves $340/day on your customer support feature — switching to Gemini would lose this"
- "Gemini 2.5 Pro shows 23% higher safety filter triggers on your content generation pipeline — consider Claude for this workload"

### 5.7 Predictive Cost Forecasting

**The problem**: AI costs are unpredictable — a viral feature can 10x your AI spend overnight.

**The solution**: Time-series forecasting based on usage patterns.

**Forecasting signals:**
- Historical token consumption by feature/team/model
- Growth rate of active users/conversations
- Seasonal patterns (weekday vs weekend, business hours vs off-hours)
- Prompt engineering changes (new system prompt = different token profile)
- Model migrations (switching from Opus to Sonnet)

**Alerts:**
- "At current growth rate, your monthly AI spend will exceed $50K by March 15"
- "The new system prompt increased average input tokens by 34% — projected monthly cost increase: $8,200"
- "Token consumption per user increased 22% this week — investigate whether this is expected"

### 5.8 Semantic Drift Detection

**The problem**: Over time, AI responses can drift from expected patterns — especially after model updates, prompt changes, or shifts in user input distribution.

**The solution**: Track embedding similarity of AI responses against a baseline.

**How it works:**
1. During a baseline period, embed a sample of AI responses (using a lightweight embedding model)
2. Continuously embed new responses and compute cosine similarity to the baseline centroid
3. Alert when average similarity drops below a threshold

**Use cases:**
- Detect when a model update changes response style/content
- Detect when user input distribution shifts (new use case emerging)
- Validate prompt engineering changes haven't caused unintended shifts
- Monitor for "mode collapse" — responses becoming repetitive or generic

### 5.9 Context Window Pressure Analytics

**The problem**: As conversations grow, context windows fill up. At some point, important earlier context gets truncated or summarized, potentially degrading quality. Users have no visibility into this.

**The solution**: Track context window utilization as a first-class metric.

**Metrics:**
- `context_pressure` = `total_tokens / model_context_limit` (0.0 - 1.0)
- `context_growth_rate` = tokens added per turn
- `estimated_turns_remaining` = `(limit - current) / avg_growth_rate`
- `system_prompt_pressure` = `system_tokens / total_input_tokens`
- `context_compression_events` = times context was summarized/truncated

**Alerts:**
- "Context pressure at 85% — conversation quality may degrade within 3 turns"
- "System prompt consumes 40% of context window — consider shortening"
- "Average conversation reaches context limit after 12 turns — consider implementing summarization"

### 5.10 Multi-Modal Cost Decomposition

**The problem**: Multi-modal AI (images, video, audio, PDFs in prompts) has complex pricing that's hard to track.

**The solution**: Track input modality and attribute costs by type.

**Tracked modalities:**
- Text tokens
- Image tokens (varies by resolution — Claude charges per-image based on size)
- PDF/document tokens
- Audio tokens (Gemini)
- Video tokens (Gemini)
- Cached tokens (per modality)

**Visualization**: Stacked bar chart showing cost breakdown by modality per feature/team. Alert when non-text modalities exceed a cost threshold.

---

## 6. Architecture

Based on the patterns identified in the [FINAL_ANALYSIS.md](./FINAL_ANALYSIS.md), here's the recommended architecture.

### Language Choice: TypeScript/Node.js (Primary) + Python (Secondary)

**Why TypeScript first:**
- The Anthropic SDK (`@anthropic-ai/sdk`) and Google GenAI SDK (`@google/genai`) are TypeScript-native
- Vercel AI SDK, LangChain.js, and most agentic frameworks are TypeScript
- No existing New Relic Node.js agent in the open-source repos (greenfield opportunity)
- AI engineering teams increasingly use TypeScript over Python

**Why also Python:**
- Large installed base of Python AI code
- LangChain, AutoGen, CrewAI, Strands are Python-first
- Can leverage patterns from the existing Python agent's `ai_monitoring` module

### Instrumentation Strategy: Monkey-Patching (Python) + Proxy Wrapping (TypeScript)

Following the patterns from the agent analysis:

**TypeScript**: Wrap SDK client classes using ES6 Proxy objects. Intercept `messages.create()`, `messages.stream()`, etc. This is analogous to the Browser agent's approach of replacing global APIs.

```typescript
// Conceptual: wrap the Anthropic client
const originalCreate = client.messages.create;
client.messages.create = async function(params) {
  const span = tracer.startSpan('ai.llm.call');
  span.setAttribute('ai.model', params.model);
  span.setAttribute('ai.tokens.max', params.max_tokens);
  try {
    const response = await originalCreate.call(this, params);
    span.setAttribute('ai.tokens.input', response.usage.input_tokens);
    span.setAttribute('ai.tokens.output', response.usage.output_tokens);
    span.setAttribute('ai.cost.total_usd', calculateCost(params.model, response.usage));
    return response;
  } catch (error) {
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
};
```

**Python**: Use `wrapt`-based monkey-patching via import hooks (same pattern as existing Python agent hooks). Register hook for `anthropic` and `google.genai` modules.

### Data Transport: Dual Protocol

Following patterns from the agent analysis:

1. **New Relic Events API** (`custom_event_data` via collector protocol v17) for real-time event ingestion
2. **New Relic Metric API** for aggregated metrics (token counts, costs, latency percentiles)
3. **New Relic Log API** for AI conversation logs (optional, content-aware)
4. **OTLP export** (optional) for OpenTelemetry compatibility — the Python agent already uses OTLP for ML events

### Core Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application Code                         │
│                                                                 │
│   anthropic.messages.create()    gemini.generate_content()      │
│         │                              │                        │
│         ▼                              ▼                        │
│   ┌───────────┐                 ┌───────────┐                  │
│   │  Claude    │                 │  Gemini   │                  │
│   │  Wrapper   │                 │  Wrapper  │                  │
│   └─────┬─────┘                 └─────┬─────┘                  │
│         │                              │                        │
│         ▼                              ▼                        │
│   ┌──────────────────────────────────────────┐                 │
│   │           AI Agent Core                   │                 │
│   │                                           │                 │
│   │  ┌─────────────┐  ┌──────────────────┐  │                 │
│   │  │ Cost Engine  │  │ Quality Tracker  │  │                 │
│   │  │ (pricing DB) │  │ (signal fusion)  │  │                 │
│   │  └─────────────┘  └──────────────────┘  │                 │
│   │                                           │                 │
│   │  ┌─────────────┐  ┌──────────────────┐  │                 │
│   │  │ Agentic     │  │ Conversation     │  │                 │
│   │  │ Tracer      │  │ Tracker          │  │                 │
│   │  └─────────────┘  └──────────────────┘  │                 │
│   │                                           │                 │
│   │  ┌──────────────────────────────────────┐│                 │
│   │  │         Event Buffer / Reservoir      ││                 │
│   │  └──────────────────────────────────────┘│                 │
│   └──────────────────┬───────────────────────┘                 │
│                      │                                          │
└──────────────────────┼──────────────────────────────────────────┘
                       │
                       │  (HTTPS, gzip, JSON)
                       ▼
              ┌──────────────────┐
              │  New Relic        │
              │  Collector        │
              │  (Events + Metrics│
              │   + Logs APIs)    │
              └──────────────────┘
```

### Key Components

**Provider Wrappers** (one per SDK):
- Intercept API calls, capture request/response metadata
- Handle streaming (accumulate chunks, measure TTFT)
- Extract provider-specific fields (thinking blocks, safety ratings, cache tokens)
- Lightweight — just data capture, no business logic

**Cost Engine**:
- Maintains updatable pricing table per model
- Calculates per-request cost from token usage
- Supports cost attribution tags (feature, team, user)
- Tracks cache economics (savings, ROI)

**Quality Tracker**:
- Aggregates quality signals (structural + application-provided)
- Computes composite quality score
- Maintains rolling baseline for anomaly detection
- Emits quality degradation alerts

**Agentic Tracer**:
- Builds trace trees for multi-step workflows
- Detects anti-patterns (loops, spinning, overthinking)
- Links LLM calls to tool executions to outcomes
- Calculates cost-per-task and efficiency metrics

**Conversation Tracker**:
- Maintains per-conversation state (token accumulation, turn count, cost)
- Tracks context window pressure
- Estimates remaining conversation capacity
- Links conversation ID across turns

**Event Buffer**:
- Reservoir-sampled event collection (same pattern as all NR agents)
- Two-tier harvest: 60s for aggregated metrics, 5s for events
- Snapshot-and-reset at harvest time

### Configuration

Following the agent analysis patterns — environment variables as primary, config file as secondary:

```bash
# Required
NEW_RELIC_LICENSE_KEY=...
NEW_RELIC_APP_NAME=my-ai-app

# AI-specific
NEW_RELIC_AI_MONITORING_ENABLED=true
NEW_RELIC_AI_RECORD_CONTENT=true          # Record prompt/response text
NEW_RELIC_AI_COST_TRACKING_ENABLED=true   # Enable cost calculation
NEW_RELIC_AI_QUALITY_TRACKING_ENABLED=true
NEW_RELIC_AI_CONVERSATION_TRACKING_ENABLED=true
NEW_RELIC_AI_THINKING_TRACKING_ENABLED=true

# Optional
NEW_RELIC_AI_CUSTOM_PRICING_FILE=/path/to/pricing.json  # Override built-in pricing
NEW_RELIC_AI_CONTENT_MAX_LENGTH=4096      # Truncate recorded content
NEW_RELIC_AI_HIGH_SECURITY=true           # Never record content
```

---

## 7. Dashboard & Alerting Ideas

### Pre-Built Dashboard: "AI Command Center"

**Top row — Key indicators (real-time):**
- Total AI spend today ($ with trend arrow)
- Requests/minute (throughput)
- P95 latency (ms)
- Error rate (%)
- Average quality score

**Row 2 — Cost breakdown:**
- Cost by model (stacked area chart over time)
- Cost by feature/team (horizontal bar chart)
- Cache savings vs creation cost (dual-axis line chart)
- Projected monthly cost (forecast line with confidence interval)

**Row 3 — Performance:**
- Time to first token by model (line chart)
- Tokens per second by model (line chart)
- Thinking depth index distribution (histogram)
- Context window utilization heatmap (by conversation)

**Row 4 — Quality:**
- Quality score trend (line chart with anomaly bands)
- Stop reason distribution (stacked bar)
- User feedback distribution (thumbs up/down over time)
- Regeneration rate trend

**Row 5 — Agentic (if applicable):**
- Task completion rate
- Average steps per task
- Cost per task distribution
- Anti-pattern detection alerts (loop count, overthinking events)

### Pre-Built Dashboard: "AI Cost Explorer"

Deep-dive cost analysis:
- Cost treemap: model → feature → endpoint
- Top 10 most expensive conversations (with drill-down)
- Cost anomaly timeline (deviations from baseline)
- "What-if" scenario: estimated savings from switching model X to model Y
- Cache efficiency by system prompt (which prompts benefit most from caching)
- Input/output token ratio by feature (identify verbose prompts)

### Pre-Built Dashboard: "AI Reliability"

Operational health:
- Provider availability by endpoint (uptime %)
- Rate limit headroom (% of limits consumed)
- Error classification breakdown (content policy, rate limit, timeout, server error)
- Retry success rate
- Fallback trigger rate
- Latency percentiles over time (p50, p90, p95, p99)

### Alert Conditions

**Cost alerts:**
- "Daily AI spend exceeded $X" (budget guard)
- "Hourly spend rate is 3x normal" (runaway cost)
- "Cache hit rate dropped below 50%" (cache invalidation)
- "Cost per task increased >30% this week" (efficiency regression)

**Quality alerts:**
- "Quality score dropped >2 std dev from 7-day baseline" (quality degradation)
- "Max tokens hit rate exceeded 20%" (responses being truncated)
- "Safety filter trigger rate exceeded 5%" (content issues)
- "Regeneration rate exceeded 15%" (user dissatisfaction)

**Performance alerts:**
- "P95 TTFT exceeded 3 seconds" (latency spike)
- "Error rate exceeded 5%" (reliability issue)
- "Rate limit headroom below 10%" (approaching limits)
- "Provider availability below 99.5%" (outage risk)

**Agentic alerts:**
- "Loop detection: agent repeated same action >5 times" (stuck agent)
- "Task cost exceeded $5" (expensive task)
- "Human intervention rate exceeded 30%" (agent not autonomous enough)
- "Average task steps increased >50% from baseline" (efficiency regression)

---

## 8. Implementation Phases

### Phase 1: Foundation (4-6 weeks)

**Goal**: Ship a working agent that tracks Claude and Gemini API calls with cost.

**Deliverables:**
- TypeScript SDK wrapping for `@anthropic-ai/sdk` and `@google/genai`
- Basic event types: `AiRequest`, `AiResponse`, `AiMessage`
- Token tracking (input, output, thinking, cache) from API responses
- Cost calculation with built-in pricing table
- Latency metrics (total, TTFT for streaming)
- Collector handshake (preconnect → connect) using protocol v17
- Two-tier harvest (60s metrics, 5s events)
- Error tracking with retry/status code classification
- Basic configuration via environment variables
- One pre-built dashboard: "AI Overview"

### Phase 2: Deep Observability (4-6 weeks)

**Goal**: Add the novel metrics that differentiate this agent.

**Deliverables:**
- Extended thinking metrics (thinking tokens, depth index, budget utilization)
- Prompt cache economics (hit rate, savings, ROI)
- Conversation tracking (per-conversation cost, token accumulation, context pressure)
- Quality signal framework (structural signals + user feedback callback API)
- Multi-modal input tracking (image/PDF/audio token attribution)
- Cost attribution tags (feature, team, user)
- Provider comparison metrics
- Two more dashboards: "AI Cost Explorer" + "AI Reliability"
- Python wrapper (same capabilities, using import hook pattern)

### Phase 3: Agentic Intelligence (4-6 weeks)

**Goal**: First-class observability for AI agents and workflows.

**Deliverables:**
- Agentic workflow tracer (trace tree with spans for LLM calls + tool executions)
- Anti-pattern detection (loops, overthinking, underthinking, spinning)
- Task-level metrics (cost per task, steps per task, completion rate)
- Framework integrations: LangChain.js, Vercel AI SDK, CrewAI
- Sub-agent tracking (delegation, spawning, inter-agent communication)
- Context management visibility (summarization events, context resets)
- "AI Agent Workflows" dashboard

### Phase 4: Intelligence & Prediction (6-8 weeks)

**Goal**: Predictive and automated insights.

**Deliverables:**
- Semantic drift detection (embedding-based response monitoring)
- Quality degradation anomaly detection (rolling baseline, multi-signal)
- Predictive cost forecasting (time-series projection with confidence intervals)
- Automated recommendations ("switch model X to Y for this workload")
- A/B experiment tracking (compare prompt versions, model versions)
- OpenTelemetry export compatibility
- Custom instrumentation API for user-defined AI metrics

---

## 9. Open Questions

### Product Questions
1. **Should this be a standalone agent or an extension to existing agents?** A standalone agent is cleaner architecturally but requires a separate install. An extension (npm package / pip install) that plugs into existing agents leverages existing transport but inherits APM-centric constraints.

   **Decision:** Standalone agent. Cleaner architecture, no APM-centric constraints inherited, and AI teams often don't have (or want) the full APM agent installed.

2. **Content recording default: opt-in or opt-out?** Recording prompt/response text is enormously valuable for debugging but raises privacy concerns. The Python agent defaults to `record_content.enabled=true`. Should an AI-focused agent be more conservative?

   **Decision:** Opt-in (`NEW_RELIC_AI_RECORD_CONTENT=false` by default). AI prompts and responses are more likely to contain PII, trade secrets, or regulated data than general APM payloads. Users must consciously enable content recording.

3. **Pricing table update mechanism?** AI model pricing changes frequently. Should the agent ship with built-in prices and update via server-side config? Or fetch from a pricing API?

   **Decision:** Ship with built-in prices as the fallback. Push price updates via New Relic's existing server-side config mechanism (no separate API dependency, no added latency). Also support a user-provided override file (`NEW_RELIC_AI_CUSTOM_PRICING_FILE`) for enterprise customers with negotiated or private model pricing.

4. **Quality scoring — how opinionated should the agent be?** The structural signals (stop reason, latency, token count) are objective. User feedback integration requires application changes. LLM-as-judge is powerful but adds cost and complexity. Where's the right default?

   **Decision:** Default to structural signals only (zero setup, always available). Expose a clean callback API (`recordFeedback()`, `recordRegeneration()`, `recordEditDistance()`) for application-provided signals. Document LLM-as-judge as an advanced opt-in with explicit cost implications — do not include it in the default agent.

### Technical Questions
5. **Streaming interception complexity**: Both Claude and Gemini use async generators/iterators for streaming. Wrapping these without breaking backpressure, cancellation, and error propagation is non-trivial. The Python agent's `LLMStreamProxy` is a good reference but TypeScript async iterators have different semantics.

   **Decision:** Implement a transparent async generator wrapper that re-yields each chunk unmodified while side-effecting. Measure TTFT on the first content chunk. Accumulate usage from the final event (both SDKs include `usage` in the last stream event). Never buffer the full response. Propagate `AbortSignal` through to the underlying iterator so cancellation works correctly. Wrap the iterator in a `try/finally` to ensure the span always closes.

6. **Conversation ID linking**: How to associate multiple API calls as belonging to one conversation? Options: explicit user-provided ID, automatic session inference, or SDK-level correlation (e.g., message array similarity hashing).

   **Decision:** Explicit user-provided ID as primary, via `setConversationId(id)` or a `nr.conversationId` field in the request params. Automatic fallback: hash the messages array *excluding* the last message to produce a stable fingerprint (since users typically pass the full history on each turn, the prior messages form a stable key). Message array hashing is not viable as a primary mechanism due to cost and fragility.

7. **Token counting for cost**: API responses include token counts — but for *pre-request* estimation (e.g., "this conversation will cost approximately $X"), we need client-side tokenization. Include a tokenizer? Or only do post-hoc costing?

   **Decision:** Post-hoc costing only, from the API response `usage` fields. No bundled tokenizer — adds ~10MB to bundle size, has versioning complexity (each model uses a different tokenizer), and the API response provides exact counts anyway. Display rolling actual cost per completed turn rather than pre-request estimates. If pre-request estimation is ever needed, document use of Gemini's `countTokens()` endpoint as a provider-native option.

8. **Multi-language SDK surface**: TypeScript primary — but what about other languages? Prioritize based on adoption data.

   **Decision:** TypeScript only for initial release. Post-launch language priority based on official SDK availability and AI workload adoption:

   | Priority | Language | Rationale |
   |----------|----------|-----------|
   | 1 | **TypeScript** | Primary — Anthropic and Google SDKs are TS-native; Vercel AI SDK, LangChain.js |
   | 2 | **Python** | Large existing AI/ML base; LangChain, AutoGen, CrewAI, Strands |
   | 3 | **Go** | Official Anthropic and Google Gen AI Go SDKs; widely used for production backend services, especially on Google Cloud |
   | 4 | **Java / Kotlin** | Official Anthropic Java SDK; Spring AI growing rapidly in enterprise |
   | 5 | **C# / .NET** | Growing Azure AI integration; community SDKs for Anthropic and Gemini |
   | 6 | **Rust** | Niche but emerging for performance-critical AI inference infrastructure |

### Competitive Questions
9. **Differentiation from Helicone, Portkey, LangSmith**: These are existing AI observability tools. New Relic's advantage is integration with the rest of the stack (APM, infrastructure, browser, mobile). The AI agent should lean into this — "see the AI call in the context of the HTTP request that triggered it, the database query that fed it, and the user session that experienced the result."

   **Decision:** Agreed. Cross-stack correlation is the primary differentiator and should be the lead value proposition. Design trace/span IDs so AI events can be linked to existing APM transactions, browser sessions, and infrastructure metrics out of the box.

10. **OpenTelemetry GenAI semantic conventions**: OTel is developing [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Should this agent align with those conventions for interoperability, or define richer NR-specific conventions?

    **Decision:** Align with OTel GenAI semantic conventions wherever they exist. Use NR-specific attribute names only for metrics that have no OTel equivalent (e.g., `ai.reasoning.depth_index`, `ai.cost.*`, `ai.agent.*`). This ensures interoperability with OTel-native tooling while preserving the richer observability that is the agent's primary value.

---

*This document is a starting point for discussion. The metric taxonomy in Sections 4-5 is intentionally exhaustive — a real implementation would prioritize based on customer demand and engineering capacity. The phased approach in Section 8 lets us ship value quickly while building toward the full vision.*





