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
    ["Incorrect, that's not what I asked for."],
    ["Actually, that's not right — try again."],
    ['Undo that.'],
    ["Don't do that."],
    ["Don't do that again."],
    ['Undo it now.'],
    ['Revert that already.'],
    ["That approach won't work because there's a race condition."],
    ['You missed the null case.'],
    ['This is the third time — read the file first.'],
  ])('detects a correction for %j', (text) => {
    writeLines([userLine(text)]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userCorrections).toBe(1);
  });

  it.each([
    ['please add a new endpoint'],
    ["Actually, let's also add tests"],
    ['Revert the last commit'],
    ['Stop the dev server and restart it'],
    ['no rush, whenever you get to it'],
    ['Undo the last commit in git history'],
    ["Don't push directly to that branch"],
    ['Revert that first commit'],
    ['No, thanks'],
    ["No, that's fine"],
  ])('does not count %j as a correction', (text) => {
    writeLines([userLine(text)]);
    const tracker = new TranscriptMessageTracker();
    tracker.observeTranscriptPath(transcriptPath);
    tracker.refresh();
    expect(tracker.getMetrics().userCorrections).toBe(0);
  });

  // #677: labeled corpus for the "won't work" clause. Corrections reject
  // something the assistant already produced; design discussion rules out an
  // option before anything was built and proposes the next one.
  describe("won't work corpus (#677)", () => {
    const WONT_WORK_CORRECTIONS = [
      "That approach won't work because there's a race condition.",
      "That won't work.",
      "This still won't work.",
      "Your fix won't work because the cache is never invalidated.",
      "It won't work, the test still fails.",
      "That wont work, you're reading the wrong file.",
      'This still wont work — same error as before.',
      "The change you made won't work since the handler is never registered.",
      "It still won't work after your last edit.",
      "That won't work, let's try again.",
      "That won't work for empty arrays — the loop skips index 0.",
      "Your version won't work for us, let's go back to the old one.",
    ];

    const WONT_WORK_DESIGN_DISCUSSION = [
      "That approach won't work for X, let's use Y instead",
      "A cache won't work here since we need fresh reads — let's query the DB directly.",
      "Polling won't work on Windows, so we should use fs.watch.",
      "Redis won't work for us; we could use SQLite instead.",
      "I think a regex won't work for nested brackets, so let's write a small parser.",
      "A global lock won't work at scale — instead we should shard by key.",
      "Symlinks won't work on Windows so we should copy the files.",
      "Webhooks won't work behind the firewall, we'll need to poll instead.",
      "A cron job won't work because we need sub-minute latency, so we should use a queue.",
      "If we do it that way it won't work offline, so let's cache the manifest.",
    ];

    it.each(WONT_WORK_CORRECTIONS)('detects a correction for %j', (text) => {
      writeLines([userLine(text)]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      expect(tracker.getMetrics().userCorrections).toBe(1);
    });

    it.each(WONT_WORK_DESIGN_DISCUSSION)('does not count %j as a correction', (text) => {
      writeLines([userLine(text)]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      expect(tracker.getMetrics().userCorrections).toBe(0);
    });

    it('scopes the forward-looking cue to the sentence containing "won\'t work"', () => {
      writeLines([userLine("That won't work. Let's also add a test for the empty case.")]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      expect(tracker.getMetrics().userCorrections).toBe(1);
    });

    it('still counts a later correcting sentence when an earlier one is design discussion', () => {
      writeLines([
        userLine(
          "Redis won't work for us, let's use SQLite. Also your migration still won't work.",
        ),
      ]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      expect(tracker.getMetrics().userCorrections).toBe(1);
    });

    it('stays fast on a long adversarial message', () => {
      const text = `${"won't work ".repeat(5_000)}${'x '.repeat(50_000)}let's`;
      writeLines([userLine(text)]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      const start = Date.now();
      tracker.refresh();
      expect(Date.now() - start).toBeLessThan(1_000);
    });
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
