import {
  extractAnthropicTokens,
  extractGeminiTokens,
  extractStreamTokens,
  TokenAccumulator,
} from './tokens.js';

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
});
