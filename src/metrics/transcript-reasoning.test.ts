import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { extractReasoningForToolUse } from './transcript-reasoning.js';

let tmpDir: string;
let transcriptPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nr-transcript-reasoning-test-'));
  transcriptPath = resolve(tmpDir, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function assistantLine(messageId: string, block: Record<string, unknown>): Record<string, unknown> {
  return { type: 'assistant', message: { id: messageId, content: [block] } };
}

function writeTranscript(lines: Record<string, unknown>[]): void {
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('extractReasoningForToolUse', () => {
  it('prefers thinking text when present', () => {
    writeTranscript([
      assistantLine('msg_1', { type: 'thinking', thinking: 'I should check the file first.' }),
      assistantLine('msg_1', { type: 'text', text: 'Let me look.' }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_abc', name: 'Read', input: {} }),
    ]);

    expect(extractReasoningForToolUse(transcriptPath, 'tool_abc')).toBe(
      'I should check the file first.',
    );
  });

  it('falls back to the text block when thinking is empty', () => {
    writeTranscript([
      assistantLine('msg_1', { type: 'text', text: 'Checking the config now.' }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_abc', name: 'Read', input: {} }),
    ]);

    expect(extractReasoningForToolUse(transcriptPath, 'tool_abc')).toBe('Checking the config now.');
  });

  it('returns null when neither thinking nor text is present', () => {
    writeTranscript([
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_abc', name: 'Read', input: {} }),
    ]);

    expect(extractReasoningForToolUse(transcriptPath, 'tool_abc')).toBeNull();
  });

  it('shares the group reasoning across multiple parallel tool_use blocks', () => {
    writeTranscript([
      assistantLine('msg_1', { type: 'thinking', thinking: 'Two independent lookups needed.' }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_a', name: 'Read', input: {} }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_b', name: 'Read', input: {} }),
    ]);

    expect(extractReasoningForToolUse(transcriptPath, 'tool_a')).toBe(
      'Two independent lookups needed.',
    );
    expect(extractReasoningForToolUse(transcriptPath, 'tool_b')).toBe(
      'Two independent lookups needed.',
    );
  });

  it('returns null when the toolUseId is not found in the tail window', () => {
    writeTranscript([
      assistantLine('msg_1', { type: 'thinking', thinking: 'Some reasoning.' }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_a', name: 'Read', input: {} }),
    ]);

    expect(extractReasoningForToolUse(transcriptPath, 'tool_nonexistent')).toBeNull();
  });

  it('returns null when the transcript file does not exist', () => {
    expect(extractReasoningForToolUse(resolve(tmpDir, 'missing.jsonl'), 'tool_a')).toBeNull();
  });

  it('skips malformed or partial JSON lines silently', () => {
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify(
          assistantLine('msg_1', { type: 'thinking', thinking: 'Reasoning before the glitch.' }),
        ),
        '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"cut off mid-w',
        JSON.stringify(
          assistantLine('msg_1', { type: 'tool_use', id: 'tool_a', name: 'Read', input: {} }),
        ),
      ].join('\n') + '\n',
    );

    expect(extractReasoningForToolUse(transcriptPath, 'tool_a')).toBe(
      'Reasoning before the glitch.',
    );
  });

  it('does not leak reasoning from a previous turn with a different message id', () => {
    writeTranscript([
      assistantLine('msg_0', { type: 'thinking', thinking: 'Previous turn reasoning.' }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_a', name: 'Read', input: {} }),
    ]);

    expect(extractReasoningForToolUse(transcriptPath, 'tool_a')).toBeNull();
  });

  it('redacts sensitive content in the extracted reasoning', () => {
    writeTranscript([
      assistantLine('msg_1', {
        type: 'thinking',
        thinking: 'API_KEY=sk-abc123def456 needs rotating',
      }),
      assistantLine('msg_1', { type: 'tool_use', id: 'tool_a', name: 'Read', input: {} }),
    ]);

    const result = extractReasoningForToolUse(transcriptPath, 'tool_a');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-abc123def456');
  });
});
