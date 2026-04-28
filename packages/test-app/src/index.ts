/**
 * End-to-end integration test for nr-ai-agent Phase 1.
 *
 * Exercises the full pipeline:
 *   init() → wrap client → SDK call → record ingestion → event serialization → harvest buffer → shutdown
 *
 * Usage:
 *   cp .env.example .env   # fill in credentials
 *   npx tsx src/index.ts
 */

import 'dotenv/config';
import { init, NrAiAgent } from 'nr-ai-agent';

const separator = '─'.repeat(60);

function log(section: string, ...args: unknown[]): void {
  const parts = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)));
  process.stdout.write(`[${section}] ${parts.join(' ')}\n`);
}

async function testAnthropic(agent: NrAiAgent): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('anthropic', 'Skipped — ANTHROPIC_API_KEY not set');
    return;
  }

  // Dynamic import so the script doesn't crash if the SDK isn't installed
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const raw = new Anthropic({ apiKey });
  const client = agent.wrapAnthropicClient(raw);

  // --- Non-streaming call ---
  log('anthropic', 'Making non-streaming messages.create call...');
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Say hello in exactly 5 words.' }],
  });

  const text =
    response.content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? b.text : ''))
      .join('') || '(no text)';

  log('anthropic', 'Non-streaming response:', {
    model: response.model,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    text: text.slice(0, 100),
  });

  // --- Streaming call ---
  log('anthropic', 'Making streaming messages.stream call...');
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
  });

  let streamText = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      streamText += event.delta.text;
    }
  }

  const finalMessage = await stream.finalMessage();
  log('anthropic', 'Streaming response:', {
    model: finalMessage.model,
    stopReason: finalMessage.stop_reason,
    inputTokens: finalMessage.usage.input_tokens,
    outputTokens: finalMessage.usage.output_tokens,
    text: streamText.slice(0, 100),
  });
}

async function testGemini(agent: NrAiAgent): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    log('gemini', 'Skipped — GOOGLE_API_KEY not set');
    return;
  }

  const { GoogleGenAI } = await import('@google/genai');
  const raw = new GoogleGenAI({ apiKey });
  const client = agent.wrapGeminiClient(raw);

  // --- Non-streaming call ---
  log('gemini', 'Making generateContent call...');
  const response = await client.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: 'Say hello in exactly 5 words.',
    config: { maxOutputTokens: 128 },
  });

  const text = response.text ?? '(no text)';
  log('gemini', 'Response:', {
    text: text.slice(0, 100),
    inputTokens: response.usageMetadata?.promptTokenCount,
    outputTokens: response.usageMetadata?.candidatesTokenCount,
  });
}

function stdout(msg: string): void {
  process.stdout.write(msg + '\n');
}

async function main(): Promise<void> {
  stdout(separator);
  stdout('nr-ai-agent — Phase 1 Integration Test');
  stdout(separator);

  // --- Initialize ---
  log('init', 'Initializing agent...');
  const agent = await init({
    licenseKey: process.env.NEW_RELIC_LICENSE_KEY ?? 'placeholder-license-key',
    appName: process.env.NEW_RELIC_APP_NAME ?? 'ai-observatory-test',
    accountId: process.env.NEW_RELIC_ACCOUNT_ID ?? '0',
    logLevel: (process.env.NEW_RELIC_AI_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'debug',
  });

  log('init', 'Agent stats after init:', agent.getStats());
  stdout(separator);

  // --- Test Anthropic ---
  try {
    await testAnthropic(agent);
  } catch (err) {
    log('anthropic', 'ERROR:', err instanceof Error ? err.message : err);
  }
  log('stats', 'After Anthropic:', agent.getStats());
  stdout(separator);

  // --- Test Gemini ---
  try {
    await testGemini(agent);
  } catch (err) {
    log('gemini', 'ERROR:', err instanceof Error ? err.message : err);
  }
  log('stats', 'After Gemini:', agent.getStats());
  stdout(separator);

  // --- Shutdown ---
  log('shutdown', 'Shutting down agent (final flush)...');
  await agent.shutdown();
  log('shutdown', 'Done.');
  stdout(separator);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
