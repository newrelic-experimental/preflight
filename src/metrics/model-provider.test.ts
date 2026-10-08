import { classifyProvider } from './model-provider.js';

describe('classifyProvider', () => {
  it.each([
    ['claude-sonnet-5', 'anthropic'],
    ['claude-opus-4-8', 'anthropic'],
    ['claude-haiku-4-5-20251001', 'anthropic'],
    ['gemini-2.5-pro', 'google'],
    ['gemini-3.1-flash-lite-preview', 'google'],
    ['gpt-4o', 'openai'],
    ['gpt-5.6-sol', 'openai'],
    ['o1-mini', 'openai'],
    ['o3', 'openai'],
    ['o4-mini', 'openai'],
    ['mistral-large-latest', 'mistral'],
    ['ministral-8b-latest', 'mistral'],
    ['codestral-latest', 'mistral'],
    ['open-mistral-7b', 'mistral'],
    ['open-mixtral-8x7b', 'mistral'],
    ['command-r-plus', 'cohere'],
    ['command-light', 'cohere'],
  ])('classifies direct-API model %s as %s', (model, expected) => {
    expect(classifyProvider(model)).toBe(expected);
  });

  it.each([
    ['anthropic.claude-sonnet-5', 'bedrock'],
    ['us.anthropic.claude-opus-5', 'bedrock'],
    ['eu.anthropic.claude-fable-5', 'bedrock'],
    ['global.anthropic.claude-sonnet-4-6', 'bedrock'],
    ['amazon.nova-pro-v1:0', 'bedrock'],
    ['meta.llama3-70b-instruct-v1:0', 'bedrock'],
    ['mistral.mistral-large-2402-v1:0', 'bedrock'],
  ])('classifies Bedrock model ID %s as bedrock, not the underlying vendor', (model, expected) => {
    expect(classifyProvider(model)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(classifyProvider('Claude-Sonnet-5')).toBe('anthropic');
    expect(classifyProvider('US.ANTHROPIC.CLAUDE-OPUS-5')).toBe('bedrock');
  });

  it('returns undefined for unrecognized model IDs rather than guessing', () => {
    expect(classifyProvider('some-unknown-model')).toBeUndefined();
    expect(classifyProvider('')).toBeUndefined();
  });

  it('returns undefined for pricing-table vendors with no AiProvider value', () => {
    expect(classifyProvider('grok-4.5')).toBeUndefined();
    expect(classifyProvider('kimi-k2.7-code')).toBeUndefined();
    expect(classifyProvider('mai-code-1-flash')).toBeUndefined();
    expect(classifyProvider('raptor-mini')).toBeUndefined();
  });
});
