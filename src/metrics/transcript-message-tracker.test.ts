import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscriptMessageTracker } from './transcript-message-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;
let transcriptPath: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  tmpDir = resolve(
    tmpdir(),
    `nr-transcript-msg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  transcriptPath = resolve(tmpDir, 'transcript.jsonl');
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function userLine(content: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function assistantLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'ok' }],
    },
    uuid: `a-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-01-01T00:00:01.000Z',
    ...overrides,
  });
}

function writeLines(lines: string[]): void {
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
}

function appendLines(lines: string[]): void {
  appendFileSync(transcriptPath, lines.join('\n') + '\n');
}

describe('TranscriptMessageTracker', () => {
  it('counts a real user message', () => {
    writeLines([userLine('please fix the bug')]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(1);
  });

  it('counts a real assistant message', () => {
    writeLines([assistantLine()]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().assistantMessages).toBe(1);
  });

  it.each([
    ['tool_result echo', userLine('irrelevant', { toolUseResult: { some: 'result' } })],
    [
      'isMeta caveat',
      userLine('<local-command-caveat>caveat text</local-command-caveat>', { isMeta: true }),
    ],
    [
      'isCompactSummary continuation',
      userLine('This session is being continued...', { isCompactSummary: true }),
    ],
    [
      'task-notification origin',
      userLine('<task-notification>...</task-notification>', {
        origin: { kind: 'task-notification' },
      }),
    ],
    ['isSidechain user turn', userLine('subagent internal turn', { isSidechain: true })],
    ['command-name echo (no structural marker)', userLine('<command-name>/clear</command-name>')],
    [
      'local-command-stdout (no structural marker)',
      userLine('<local-command-stdout>output</local-command-stdout>'),
    ],
    [
      'teammate-message injection (no structural marker)',
      userLine('Another Claude session sent a message:\nhi'),
    ],
  ])('excludes %s from userMessages', (_label, line) => {
    writeLines([line]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(0);
  });

  it('excludes isSidechain assistant turns from assistantMessages', () => {
    writeLines([assistantLine({ isSidechain: true })]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().assistantMessages).toBe(0);
  });

  it('excludes assistant entries with model <synthetic>', () => {
    writeLines([
      assistantLine({
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'x' }],
        },
      }),
    ]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().assistantMessages).toBe(0);
  });

  it('counts a real user message with array content (attachment-shaped)', () => {
    writeLines([userLine([{ type: 'text', text: 'see attached' }])]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(1);
  });

  it.each([
    ["No. I told you we'd do it differently."],
    ["  no, that's not right"],
    ['Stop. I did not approve that.'],
    ["That's wrong, please redo it."],
  ])('detects a correction for %j', (text) => {
    writeLines([userLine(text)]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userCorrections).toBe(1);
  });

  it('does not count an ordinary message as a correction', () => {
    writeLines([userLine('please add a new endpoint')]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userCorrections).toBe(0);
  });

  it('only processes new lines across multiple refresh() calls (no double-counting)', () => {
    writeLines([userLine('first message')]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(1);

    appendLines([userLine('second message')]);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(2);
  });

  it('waits for a complete trailing line before counting it', () => {
    writeFileSync(transcriptPath, userLine('first message') + '\n');
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(1);

    // Append a partial line with no trailing newline yet.
    appendFileSync(transcriptPath, userLine('second message').slice(0, 20));
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(1);

    // Completing the line on the next append should get it counted.
    appendFileSync(transcriptPath, userLine('second message').slice(20) + '\n');
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(2);
  });

  it('resets the read offset when the file shrinks (rotation)', () => {
    writeLines([userLine('a'), userLine('b')]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(2);

    writeLines([userLine('fresh after rotation')]);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(3);
  });

  it('is a no-op when no transcript path has been observed', () => {
    const tracker = new TranscriptMessageTracker();
    tracker.refresh();
    expect(tracker.getMetrics()).toEqual({
      userMessages: 0,
      assistantMessages: 0,
      userCorrections: 0,
    });
  });

  it('is a no-op when the transcript file does not exist', () => {
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(resolve(tmpDir, 'does-not-exist.jsonl'));
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(0);
  });

  it('keeps the first non-empty transcript path and ignores later calls', () => {
    writeLines([userLine('hello')]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.observeTranscriptPath(resolve(tmpDir, 'does-not-exist.jsonl'));
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(1);
  });

  it('makes forward progress past an oversized line (>1MB) instead of stalling', () => {
    writeLines([
      userLine('first message'),
      userLine('x'.repeat(1_100_000)),
      userLine('second message'),
    ]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    for (let i = 0; i < 5; i++) tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(2);
  });

  it('reset() clears counters, path, and offset', () => {
    writeLines([userLine('hello')]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(1);

    tracker.reset();
    expect(tracker.getMetrics()).toEqual({
      userMessages: 0,
      assistantMessages: 0,
      userCorrections: 0,
    });

    // After reset, the tracker has forgotten the path — refresh() is a no-op
    // until observeTranscriptPath() is called again.
    tracker.refresh();
    expect(tracker.getMetrics().userMessages).toBe(0);
  });
});
