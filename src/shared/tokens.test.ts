import {
  extractAnthropicTokens,
  extractGeminiTokens,
  extractOpenAITokens,
  extractBedrockTokens,
  extractMistralTokens,
  extractCohereTokens,
  extractStreamTokens,
  safeInt,
  TokenAccumulator,
  __resetUnsupportedProvidersWarned,
} from './tokens.js';
import type { AiProvider } from './tokens.js';
import { getLogOutput } from './__test-utils__/log-output.js';

describe('extractAnthropicTokens', () => {
  it('maps all fields from a full usage object', () => {
    const result = extractAnthropicTokens({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    });

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.thinkingTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(20);
    expect(result.cacheCreationTokens).toBe(10);
    expect(result.totalTokens).toBe(180); // 100 + 50 + 0 + 20 + 10
  });

  it('defaults missing optional fields to 0', () => {
    const result = extractAnthropicTokens({
      usage: {
        input_tokens: 80,
        output_tokens: 40,
      },
    });

    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(40);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.totalTokens).toBe(120);
  });

  it('returns all zeros when usage is missing', () => {
    const result = extractAnthropicTokens({});

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.thinkingTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });
});

describe('extractGeminiTokens', () => {
  it('maps all fields from a full usageMetadata object', () => {
    const result = extractGeminiTokens({
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 50,
        cachedContentTokenCount: 30,
        totalTokenCount: 350,
      },
    });

    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(100);
    expect(result.thinkingTokens).toBe(50);
    expect(result.cacheReadTokens).toBe(30);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.totalTokens).toBe(350); // uses API-provided value
  });

  it('computes totalTokens when totalTokenCount is absent', () => {
    const result = extractGeminiTokens({
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 50,
      },
    });

    expect(result.totalTokens).toBe(350); // 200 + 100 + 50
  });

  it('defaults missing optional fields to 0', () => {
    const result = extractGeminiTokens({
      usageMetadata: {
        promptTokenCount: 60,
        candidatesTokenCount: 30,
      },
    });

    expect(result.inputTokens).toBe(60);
    expect(result.outputTokens).toBe(30);
    expect(result.thinkingTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.totalTokens).toBe(90);
  });

  it('returns all zeros when usageMetadata is missing', () => {
    const result = extractGeminiTokens({});

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.thinkingTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });
});

describe('extractStreamTokens', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetUnsupportedProvidersWarned();
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('delegates to anthropic extractor', () => {
    const result = extractStreamTokens(
      { usage: { input_tokens: 10, output_tokens: 5 } },
      'anthropic',
    );

    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('delegates to gemini extractor', () => {
    const result = extractStreamTokens(
      { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } },
      'google',
    );

    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(10);
  });

  it('delegates to openai extractor', () => {
    const result = extractStreamTokens(
      { usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 } },
      'openai',
    );

    expect(result.inputTokens).toBe(30);
    expect(result.outputTokens).toBe(15);
    expect(result.totalTokens).toBe(45);
  });

  // bedrock now has a real extractor — verify
  // it's actually wired through extractStreamTokens (not falling through
  // to the warn-once branch).
  it('delegates to bedrock extractor (non-streaming shape)', () => {
    const result = extractStreamTokens(
      { usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } },
      'bedrock',
    );

    expect(result.inputTokens).toBe(40);
    expect(result.outputTokens).toBe(20);
    expect(result.totalTokens).toBe(60);
  });

  it('extracts tokens from Bedrock stream final chunk (metadata.usage shape)', () => {
    const bedrockStreamFinal = {
      metadata: { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
    };
    const result = extractStreamTokens(bedrockStreamFinal, 'bedrock');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it('delegates to mistral extractor', () => {
    const result = extractStreamTokens(
      { usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 } },
      'mistral',
    );

    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(25);
    expect(result.totalTokens).toBe(75);
  });

  it('delegates to cohere extractor (non-streaming shape)', () => {
    const result = extractStreamTokens(
      {
        usage: {
          tokens: { input_tokens: 70, output_tokens: 35 },
          billed_units: { input_tokens: 70, output_tokens: 35 },
        },
      },
      'cohere',
    );

    expect(result.inputTokens).toBe(70);
    expect(result.outputTokens).toBe(35);
    expect(result.totalTokens).toBe(105);
  });

  it('extracts tokens from Cohere stream final chunk (delta.usage shape)', () => {
    const cohereStreamFinal = {
      type: 'message-end',
      delta: {
        usage: {
          tokens: { input_tokens: 100, output_tokens: 50 },
          billed_units: { input_tokens: 100, output_tokens: 50 },
        },
      },
    };
    const result = extractStreamTokens(cohereStreamFinal, 'cohere');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it('extracts tokens from Cohere non-streaming embed shape (meta.billed_units) via extractStreamTokens', () => {
    // Cohere embed responses use meta.billed_units, not usage. Verify the
    // non-streaming fallback path in extractStreamTokens handles this shape.
    const embedResponse = {
      meta: {
        tokens: { input_tokens: 80 },
        billed_units: { input_tokens: 80 },
      },
    };
    const result = extractStreamTokens(embedResponse, 'cohere');
    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(0);
  });

  // warn-once mechanism remains as a defensive
  // guard for hypothetical future providers that get added to AiProvider
  // without a matching extractor. Test against a fake provider literal via
  // type assertion since every real provider in AiProvider is now wired.
  it('warns once for an unrecognized provider and returns zeros', () => {
    const fakeProvider = 'fake-provider' as AiProvider;
    const out1 = extractStreamTokens({}, fakeProvider);
    const out2 = extractStreamTokens({}, fakeProvider);

    expect(out1.totalTokens).toBe(0);
    expect(out2.totalTokens).toBe(0);

    const frames = getLogOutput(stderrSpy, '\n').split('\n');
    const matches = frames.filter(
      (l) => l.includes('extractStreamTokens') && l.includes('fake-provider'),
    );
    // One warning despite two calls.
    expect(matches.length).toBe(1);
  });
});

// Bedrock Converse / ConverseStream API.
describe('extractBedrockTokens', () => {
  it('maps all fields from a full Converse usage object', () => {
    const result = extractBedrockTokens({
      usage: {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 20,
      },
    });

    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(100);
    expect(result.thinkingTokens).toBe(0); // Bedrock Converse does not surface this
    expect(result.cacheReadTokens).toBe(40);
    expect(result.cacheCreationTokens).toBe(20);
    expect(result.totalTokens).toBe(300); // uses API-provided value
  });

  it('computes totalTokens when totalTokens is absent', () => {
    const result = extractBedrockTokens({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 25,
        cacheWriteInputTokens: 5,
      },
    });

    expect(result.totalTokens).toBe(180); // 100 + 50 + 25 + 5
  });

  it('defaults missing optional fields to 0', () => {
    const result = extractBedrockTokens({
      usage: {
        inputTokens: 80,
        outputTokens: 40,
      },
    });

    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.totalTokens).toBe(120);
  });

  it('returns all zeros when usage is missing', () => {
    const result = extractBedrockTokens({});
    expect(result.totalTokens).toBe(0);
  });
});

// Mistral La Plateforme Chat Completions API.
// OpenAI-compatible shape; no native cache or reasoning fields.
describe('extractMistralTokens', () => {
  it('maps all fields from a full usage object', () => {
    const result = extractMistralTokens({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.thinkingTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.totalTokens).toBe(150);
  });

  it('computes totalTokens when total_tokens is absent', () => {
    const result = extractMistralTokens({
      usage: { prompt_tokens: 80, completion_tokens: 40 },
    });
    expect(result.totalTokens).toBe(120);
  });

  it('returns all zeros when usage is missing', () => {
    const result = extractMistralTokens({});
    expect(result.totalTokens).toBe(0);
  });
});

// Cohere v2 Chat API. Counts surface under
// `usage.tokens` (preferred) with `billed_units` as fallback. Embed
// (`client.embed`) responses use `meta` instead of `usage` with the same
// inner shape — extractor handles both.
describe('extractCohereTokens', () => {
  it('prefers usage.tokens over usage.billed_units when both are present', () => {
    const result = extractCohereTokens({
      usage: {
        tokens: { input_tokens: 100, output_tokens: 50 },
        billed_units: { input_tokens: 95, output_tokens: 48 }, // tier-adjusted
      },
    });

    expect(result.inputTokens).toBe(100); // tokens wins
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it('falls back to billed_units when usage.tokens is absent', () => {
    const result = extractCohereTokens({
      usage: {
        billed_units: { input_tokens: 80, output_tokens: 40 },
      },
    });

    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(40);
    expect(result.totalTokens).toBe(120);
  });

  it('reads from response.meta for embed-endpoint responses', () => {
    const result = extractCohereTokens({
      meta: {
        tokens: { input_tokens: 200 },
      },
    });

    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(0);
    expect(result.totalTokens).toBe(200);
  });

  it('returns all zeros when neither usage nor meta is present', () => {
    const result = extractCohereTokens({});
    expect(result.totalTokens).toBe(0);
  });

  it('returns all zeros when usage has no tokens or billed_units', () => {
    const result = extractCohereTokens({ usage: {} });
    expect(result.totalTokens).toBe(0);
  });
});

// OpenAI Chat Completions extractor.
describe('extractOpenAITokens', () => {
  it('maps all fields from a full usage object', () => {
    const result = extractOpenAITokens({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    });

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.thinkingTokens).toBe(10);
    expect(result.cacheReadTokens).toBe(20);
    expect(result.cacheCreationTokens).toBe(0); // OpenAI does not expose this
    expect(result.totalTokens).toBe(150); // uses API-provided value
  });

  it('computes totalTokens when total_tokens is absent', () => {
    const result = extractOpenAITokens({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    });

    // cacheReadTokens (cached_tokens) is a SUBSET of inputTokens
    // (prompt_tokens) for OpenAI, not additive. Correct total = 100 + 50 = 150,
    // not 170. The old assertion (170) encoded the double-count bug.
    expect(result.totalTokens).toBe(150); // 100 + 50 (cached already in prompt_tokens)
  });

  it('defaults missing optional fields to 0', () => {
    const result = extractOpenAITokens({
      usage: {
        prompt_tokens: 80,
        completion_tokens: 40,
      },
    });

    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(40);
    expect(result.thinkingTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
  });

  it('returns all zeros when usage is missing', () => {
    const result = extractOpenAITokens({});

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it('handles only prompt_tokens_details / completion_tokens_details being present', () => {
    const result = extractOpenAITokens({
      usage: {
        prompt_tokens: 200,
        completion_tokens: 100,
        prompt_tokens_details: {},
        completion_tokens_details: {},
      },
    });

    expect(result.cacheReadTokens).toBe(0);
    expect(result.thinkingTokens).toBe(0);
    expect(result.totalTokens).toBe(300);
  });
});

describe('TokenAccumulator', () => {
  describe('anthropic stream', () => {
    it('accumulates tokens from message_start and message_delta events', () => {
      const acc = new TokenAccumulator('anthropic');

      acc.addChunk({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 15,
            cache_creation_input_tokens: 8,
          },
        },
      });

      acc.addChunk({
        type: 'content_block_start',
      });

      acc.addChunk({
        type: 'content_block_delta',
      });

      acc.addChunk({
        type: 'message_delta',
        usage: { output_tokens: 42 },
      });

      const result = acc.finalize();

      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(42);
      expect(result.thinkingTokens).toBe(0);
      expect(result.cacheReadTokens).toBe(15);
      expect(result.cacheCreationTokens).toBe(8);
      expect(result.totalTokens).toBe(165); // 100 + 42 + 0 + 15 + 8
    });

    it('accumulates thinking_tokens from message_delta when present', () => {
      const acc = new TokenAccumulator('anthropic');
      acc.addChunk({ type: 'message_start', message: { usage: { input_tokens: 100 } } });
      acc.addChunk({
        type: 'message_delta',
        usage: { output_tokens: 50, thinking_tokens: 200 },
      });
      const result = acc.finalize();
      expect(result.thinkingTokens).toBe(200);
      expect(result.totalTokens).toBe(350); // 100 + 50 + 200
    });

    // message_delta usage carries FINAL counts that may
    // differ from message_start. Verified against Anthropic streaming spec.
    it('overwrites cache_read/creation/input_tokens from message_delta when present', () => {
      const acc = new TokenAccumulator('anthropic');

      acc.addChunk({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });

      // Server-side cache attribution finalized in message_delta:
      acc.addChunk({
        type: 'message_delta',
        usage: {
          input_tokens: 110, // revised
          output_tokens: 50,
          cache_read_input_tokens: 80, // populated late
          cache_creation_input_tokens: 5,
        },
      });

      const result = acc.finalize();

      expect(result.inputTokens).toBe(110);
      expect(result.outputTokens).toBe(50);
      expect(result.cacheReadTokens).toBe(80);
      expect(result.cacheCreationTokens).toBe(5);
      // total = 110 + 50 + 0 + 80 + 5 = 245
      expect(result.totalTokens).toBe(245);
    });

    it('ignores chunks after finalize', () => {
      const acc = new TokenAccumulator('anthropic');

      acc.addChunk({
        type: 'message_start',
        message: { usage: { input_tokens: 50 } },
      });
      acc.addChunk({
        type: 'message_delta',
        usage: { output_tokens: 20 },
      });

      const result = acc.finalize();

      // Try adding more after finalize
      acc.addChunk({
        type: 'message_delta',
        usage: { output_tokens: 999 },
      });

      // finalize() returns a snapshot; the accumulator is frozen
      expect(result.outputTokens).toBe(20);
    });
  });

  describe('gemini stream', () => {
    it('uses the last chunk with usageMetadata as authoritative', () => {
      const acc = new TokenAccumulator('google');

      acc.addChunk({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 10,
        },
      });

      acc.addChunk({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 5,
          totalTokenCount: 135,
        },
      });

      // Final chunk with full counts
      acc.addChunk({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 60,
          thoughtsTokenCount: 15,
          cachedContentTokenCount: 20,
          totalTokenCount: 175,
        },
      });

      const result = acc.finalize();

      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(60);
      expect(result.thinkingTokens).toBe(15);
      expect(result.cacheReadTokens).toBe(20);
      expect(result.totalTokens).toBe(175);
    });

    it('skips chunks without usageMetadata', () => {
      const acc = new TokenAccumulator('google');

      acc.addChunk({}); // no usageMetadata
      acc.addChunk({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 } });
      acc.addChunk({}); // no usageMetadata again

      const result = acc.finalize();

      expect(result.inputTokens).toBe(50);
      expect(result.outputTokens).toBe(25);
      expect(result.totalTokens).toBe(75);
    });
  });

  // OpenAI streaming uses stream_options.include_usage so
  // the LAST chunk carries `usage` (same shape as non-streaming response).
  // Earlier chunks may have `choices` deltas but no usage.
  describe('openai stream', () => {
    it('records usage from the final chunk when include_usage is set', () => {
      const acc = new TokenAccumulator('openai');

      // Earlier chunks — content deltas, no usage.
      acc.addChunk({ choices: [{ delta: { content: 'hello' } }] });
      acc.addChunk({ choices: [{ delta: { content: ' world' } }] });

      // Final chunk carries usage.
      acc.addChunk({
        usage: {
          prompt_tokens: 80,
          completion_tokens: 30,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 12 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      });

      const result = acc.finalize();
      expect(result.inputTokens).toBe(80);
      expect(result.outputTokens).toBe(30);
      expect(result.cacheReadTokens).toBe(12);
      expect(result.thinkingTokens).toBe(5);
      expect(result.totalTokens).toBe(110);
    });

    it('returns zeros when no chunk carried usage (include_usage was off)', () => {
      const acc = new TokenAccumulator('openai');
      acc.addChunk({ choices: [{ delta: { content: 'hi' } }] });

      const result = acc.finalize();
      expect(result.totalTokens).toBe(0);
    });

    it('uses inputTokens+outputTokens fallback when total_tokens is absent', () => {
      // When total_tokens is missing, cacheReadTokens (cached_tokens) and
      // thinkingTokens (reasoning_tokens) are subsets, not additive — the old
      // formula would have yielded 80+30+5+12=127. Correct value is 80+30=110.
      const acc = new TokenAccumulator('openai');
      acc.addChunk({
        usage: {
          prompt_tokens: 80,
          completion_tokens: 30,
          // total_tokens intentionally absent
          prompt_tokens_details: { cached_tokens: 12 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      });

      const result = acc.finalize();
      expect(result.inputTokens).toBe(80);
      expect(result.outputTokens).toBe(30);
      expect(result.cacheReadTokens).toBe(12);
      expect(result.thinkingTokens).toBe(5);
      expect(result.totalTokens).toBe(110); // 80 + 30, not 80+30+5+12
    });
  });

  // Mistral streaming uses OpenAI-compatible
  // chunks; the final chunk carries `usage`.
  describe('mistral stream', () => {
    it('records usage from the final chunk', () => {
      const acc = new TokenAccumulator('mistral');

      // Earlier chunks — content deltas, no usage.
      acc.addChunk({ choices: [{ delta: { content: 'bonjour' } }] });
      acc.addChunk({ choices: [{ delta: { content: ' monde' } }] });

      // Final chunk carries usage.
      acc.addChunk({
        usage: { prompt_tokens: 60, completion_tokens: 30, total_tokens: 90 },
      });

      const result = acc.finalize();
      expect(result.inputTokens).toBe(60);
      expect(result.outputTokens).toBe(30);
      expect(result.totalTokens).toBe(90);
    });

    it('returns zeros when no chunk carried usage', () => {
      const acc = new TokenAccumulator('mistral');
      acc.addChunk({ choices: [{ delta: { content: 'hi' } }] });

      const result = acc.finalize();
      expect(result.totalTokens).toBe(0);
    });
  });

  // Bedrock ConverseStream emits a `metadata`
  // event near the end of the stream carrying `usage`. Earlier events
  // (messageStart / contentBlockDelta) carry no usage and must no-op.
  describe('bedrock stream', () => {
    it('records usage from the metadata event', () => {
      const acc = new TokenAccumulator('bedrock');

      // Earlier events — no usage.
      acc.addChunk({ messageStart: { role: 'assistant' } });
      acc.addChunk({ contentBlockDelta: { delta: { text: 'hello' } } });
      acc.addChunk({ messageStop: { stopReason: 'end_turn' } });

      // Metadata event carries usage.
      acc.addChunk({
        metadata: {
          usage: {
            inputTokens: 120,
            outputTokens: 60,
            totalTokens: 180,
            cacheReadInputTokens: 30,
            cacheWriteInputTokens: 10,
          },
        },
      });

      const result = acc.finalize();
      expect(result.inputTokens).toBe(120);
      expect(result.outputTokens).toBe(60);
      expect(result.cacheReadTokens).toBe(30);
      expect(result.cacheCreationTokens).toBe(10);
      expect(result.totalTokens).toBe(180);
    });

    it('returns zeros when no metadata event was seen', () => {
      const acc = new TokenAccumulator('bedrock');
      acc.addChunk({ messageStart: { role: 'assistant' } });

      const result = acc.finalize();
      expect(result.totalTokens).toBe(0);
    });
  });

  // Cohere v2 streaming events. The terminal
  // `message-end` event carries `delta.usage.tokens`; earlier events
  // (`message-start`, `content-delta`, etc.) carry no usage and no-op.
  describe('cohere stream', () => {
    it('records usage from the message-end event', () => {
      const acc = new TokenAccumulator('cohere');

      // Earlier events — no usage.
      acc.addChunk({ type: 'message-start', delta: { message: { role: 'assistant' } } });
      acc.addChunk({ type: 'content-delta', delta: { message: { content: { text: 'hi' } } } });

      // Terminal message-end carries usage.
      acc.addChunk({
        type: 'message-end',
        delta: {
          usage: {
            tokens: { input_tokens: 90, output_tokens: 45 },
            billed_units: { input_tokens: 90, output_tokens: 45 },
          },
        },
      });

      const result = acc.finalize();
      expect(result.inputTokens).toBe(90);
      expect(result.outputTokens).toBe(45);
      expect(result.totalTokens).toBe(135);
    });

    it('falls back to billed_units when delta.usage.tokens is absent', () => {
      const acc = new TokenAccumulator('cohere');
      acc.addChunk({
        type: 'message-end',
        delta: { usage: { billed_units: { input_tokens: 50, output_tokens: 20 } } },
      });

      const result = acc.finalize();
      expect(result.inputTokens).toBe(50);
      expect(result.outputTokens).toBe(20);
      expect(result.totalTokens).toBe(70);
    });

    it('returns zeros when no message-end event was seen', () => {
      const acc = new TokenAccumulator('cohere');
      acc.addChunk({ type: 'message-start', delta: { message: { role: 'assistant' } } });

      const result = acc.finalize();
      expect(result.totalTokens).toBe(0);
    });
  });

  // warn-once mechanism remains as a defensive
  // guard for future provider additions to AiProvider that don't yet have
  // an extractor. Asserted against a fake provider via type assertion
  // since every real provider is now wired.
  describe('unrecognized providers (warn-once defensive guard)', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
      __resetUnsupportedProvidersWarned();
      stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('warns once and returns zeros for a fake provider', () => {
      const fakeProvider = 'fake-provider' as AiProvider;
      const acc = new TokenAccumulator(fakeProvider);
      acc.addChunk({ usage: { prompt_tokens: 100 } });
      acc.addChunk({ usage: { prompt_tokens: 100 } });
      const result = acc.finalize();

      expect(result.totalTokens).toBe(0);

      const frames = getLogOutput(stderrSpy, '\n').split('\n');
      const matches = frames.filter(
        (l) => l.includes('TokenAccumulator') && l.includes('fake-provider'),
      );
      expect(matches.length).toBe(1);
    });
  });

  it('returns all zeros when no chunks are added', () => {
    const anthAcc = new TokenAccumulator('anthropic');
    const gemAcc = new TokenAccumulator('google');

    const anthResult = anthAcc.finalize();
    const gemResult = gemAcc.finalize();

    for (const result of [anthResult, gemResult]) {
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.thinkingTokens).toBe(0);
      expect(result.cacheReadTokens).toBe(0);
      expect(result.cacheCreationTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
    }
  });

  // reset() allows reuse across retries
  describe('reset()', () => {
    it('zeroes latestUsage and clears finalized state', () => {
      const acc = new TokenAccumulator('anthropic');
      acc.addChunk({
        type: 'message_start',
        message: { usage: { input_tokens: 100 } },
      });
      acc.addChunk({
        type: 'message_delta',
        usage: { output_tokens: 50, input_tokens: 100 },
      });
      const first = acc.finalize();
      expect(first.totalTokens).toBe(150);

      acc.reset();

      // After reset, finalize returns a zero snapshot — not the stale one.
      const afterReset = acc.finalize();
      expect(afterReset.inputTokens).toBe(0);
      expect(afterReset.outputTokens).toBe(0);
      expect(afterReset.totalTokens).toBe(0);
    });

    it('allows the accumulator to be reused for a second stream', () => {
      const acc = new TokenAccumulator('anthropic');
      acc.addChunk({
        type: 'message_start',
        message: { usage: { input_tokens: 100 } },
      });
      acc.addChunk({
        type: 'message_delta',
        usage: { output_tokens: 50, input_tokens: 100 },
      });
      acc.finalize();
      acc.reset();

      // After reset, addChunk should accept new data (it was a no-op before reset
      // because finalize had set the finalized flag).
      acc.addChunk({
        type: 'message_start',
        message: { usage: { input_tokens: 7 } },
      });
      acc.addChunk({
        type: 'message_delta',
        usage: { output_tokens: 3, input_tokens: 7 },
      });
      const second = acc.finalize();
      expect(second.inputTokens).toBe(7);
      expect(second.outputTokens).toBe(3);
      expect(second.totalTokens).toBe(10);
    });

    it('preserves the provider binding across reset()', () => {
      // Implementation detail check: reset() must not change which extractor
      // path addChunk routes to. Build a Gemini accumulator, reset, and feed
      // a Gemini chunk — it must still extract correctly.
      const acc = new TokenAccumulator('google');
      acc.addChunk({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
      acc.finalize();
      acc.reset();

      acc.addChunk({ usageMetadata: { promptTokenCount: 99, candidatesTokenCount: 1 } });
      const result = acc.finalize();
      expect(result.inputTokens).toBe(99);
    });

    it('addChunk after finalize without reset is a no-op (regression guard)', () => {
      const acc = new TokenAccumulator('anthropic');
      acc.finalize();
      // No reset — chunks should be ignored.
      acc.addChunk({
        type: 'message_start',
        message: { usage: { input_tokens: 999 } },
      });
      const result = acc.finalize();
      expect(result.inputTokens).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // S-05: safeInt rejects Infinity, -Infinity, negative values, and floats
  // ---------------------------------------------------------------------------
  describe('safeInt guard', () => {
    it('clamps Infinity token counts to 0', () => {
      const result = extractAnthropicTokens({
        usage: { input_tokens: Infinity, output_tokens: 50 },
      });
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(50);
      expect(result.totalTokens).toBe(50);
    });

    it('clamps negative token counts to 0', () => {
      const result = extractAnthropicTokens({
        usage: { input_tokens: -100, output_tokens: -50 },
      });
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
    });

    it('floors fractional token counts', () => {
      const result = extractAnthropicTokens({
        usage: { input_tokens: 10.9, output_tokens: 5.1 },
      });
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
      expect(result.totalTokens).toBe(15);
    });

    it('clamps Infinity in Gemini usageMetadata to 0', () => {
      const result = extractGeminiTokens({
        usageMetadata: { promptTokenCount: Infinity, candidatesTokenCount: 20 },
      });
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(20);
    });

    it('clamps negative Gemini token counts to 0', () => {
      const result = extractGeminiTokens({
        usageMetadata: { promptTokenCount: -999, candidatesTokenCount: 10 },
      });
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(10);
    });
  });

  // safeInt emits a debug log when truncating fractions
  describe('safeInt fractional truncation logging', () => {
    let originalLogLevel: string | undefined;
    let stderrSpy: jest.SpyInstance;

    beforeEach(async () => {
      originalLogLevel = process.env.NEW_RELIC_AI_LOG_LEVEL;
      stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.NEW_RELIC_AI_LOG_LEVEL = 'debug';
      // Env-resolved level is cached on first use; reset
      // the cache so the next log call (from the module-level tokenLogger)
      // re-reads `debug` rather than the default `info` from module load.
      const { __resetLogLevelCache } = await import('./logger.js');
      __resetLogLevelCache();
    });

    afterEach(async () => {
      if (originalLogLevel === undefined) {
        delete process.env.NEW_RELIC_AI_LOG_LEVEL;
      } else {
        process.env.NEW_RELIC_AI_LOG_LEVEL = originalLogLevel;
      }
      const { __resetLogLevelCache } = await import('./logger.js');
      __resetLogLevelCache();
      stderrSpy.mockRestore();
    });

    it('returns the floored value for fractional inputs', () => {
      expect(safeInt(10.7)).toBe(10);
      expect(safeInt(0.999)).toBe(0);
      expect(safeInt(99.0001)).toBe(99);
    });

    it('does not log when the input is already an integer', () => {
      // Reset spy to count only logs from these specific calls.
      stderrSpy.mockClear();
      expect(safeInt(0)).toBe(0);
      expect(safeInt(100)).toBe(100);
      expect(safeInt(99999)).toBe(99999);
      // No fractional truncation, so no debug log message about it.
      const output = getLogOutput(stderrSpy);
      expect(output).not.toContain('safeInt truncated fractional value');
    });

    it('returns 0 (no log) for non-numeric / non-finite / negative inputs', () => {
      stderrSpy.mockClear();
      expect(safeInt(NaN)).toBe(0);
      expect(safeInt(Infinity)).toBe(0);
      expect(safeInt(-1.5)).toBe(0);
      expect(safeInt('not a number')).toBe(0);
      expect(safeInt(null)).toBe(0);
      expect(safeInt(undefined)).toBe(0);
      // safeInt logs ONLY on the truncation path; rejected inputs return 0
      // without a fractional-truncation log.
      const output = getLogOutput(stderrSpy);
      expect(output).not.toContain('safeInt truncated fractional value');
    });
  });
});
