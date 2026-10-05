import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
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
    function countCorrections(text: string): number {
      writeLines([userLine(text)]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      return tracker.getMetrics().userCorrections;
    }

    const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    const uncapitalize = (s: string): string =>
      /^I\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
    const withoutLeadingSo = (s: string): string => s.replace(/^so\s+/i, '');

    type Joiner = (clause: string, followUp: string) => string;
    type Pair = readonly [string, string];

    /** Every [clause, follow-up] pair runs under each joiner, so a verdict can't hinge on punctuation. */
    const JOINERS: readonly Joiner[] = [
      (c, f) => `${c}, ${f}.`,
      (c, f) => `${c}. ${capitalize(f)}.`,
      (c, f) => `${c}; ${f}.`,
      (c, f) => `${c} — ${f}.`,
      (c, f) => `${c}\n${capitalize(f)}`,
    ];

    /** The same joiners with the follow-up first ("Let's use Y. X won't work."), so a verdict can't hinge on clause order either. */
    const REVERSED_JOINERS: readonly Joiner[] = [
      (c, f) => `${capitalize(withoutLeadingSo(f))}, ${uncapitalize(c)}.`,
      (c, f) => `${capitalize(withoutLeadingSo(f))}. ${capitalize(c)}.`,
      (c, f) => `${capitalize(withoutLeadingSo(f))}; ${uncapitalize(c)}.`,
      (c, f) => `${capitalize(withoutLeadingSo(f))} — ${uncapitalize(c)}.`,
      (c, f) => `${capitalize(withoutLeadingSo(f))}\n${capitalize(c)}`,
    ];

    const variants = (pairs: readonly Pair[], joiners: readonly Joiner[]): string[] =>
      pairs.flatMap(([clause, followUp]) => joiners.map((join) => join(clause, followUp)));
    const punctuationVariants = (pairs: readonly Pair[]): string[] => variants(pairs, JOINERS);
    const orderAndPunctuationVariants = (pairs: readonly Pair[]): string[] =>
      variants(pairs, [...JOINERS, ...REVERSED_JOINERS]);

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
      "That definitely won't work, let's use a map instead.",
      "Hmm, that won't work, let's try again.",
      "That approach won't work because we can't lock the table.",
      "The migration won't work, it drops the index instead of renaming it.",
      "The migration won't work, it drops the index rather than renaming it.",
    ];

    /**
     * Corrections next to a forward-looking cue, caught by a bare-pronoun opener or a reference to the
     * assistant's output. The bare-pronoun pairs only run reject-first: put the proposal first and the
     * pronoun points at it ("Let's use a map instead. That won't work."), which is design discussion.
     */
    const WONT_WORK_CORRECTIONS_WITH_PROPOSAL = [
      ...punctuationVariants([
        ["That won't work", "let's use a map instead"],
        ["It won't work", 'we should await the promise'],
        ["That won't work", 'we need to handle the null case'],
      ]),
      ...orderAndPunctuationVariants([
        [
          "Your fix won't work because the cache is never invalidated",
          'we should clear it on write',
        ],
        ["The change you made won't work on Windows", "let's revert it"],
        ["The migration still won't work", "let's try a different approach"],
        ["What you just wrote won't work for empty input", 'we need to guard the loop'],
      ]),
    ];

    /** Includes "still", "your", "fails" and "anymore" used about the option rather than the assistant's output. */
    const WONT_WORK_DESIGN_DISCUSSION = orderAndPunctuationVariants([
      ["That approach won't work for X", "let's use Y instead"],
      ["A cache won't work here since we need fresh reads", "let's query the DB directly"],
      ["Polling won't work on Windows", 'so we should use fs.watch'],
      ["Redis won't work for us", 'we could use SQLite instead'],
      ["I think a regex won't work for nested brackets", "so let's write a small parser"],
      ["A global lock won't work at scale", 'instead we should shard by key'],
      ["Symlinks won't work on Windows", 'so we should copy the files'],
      ["Webhooks won't work behind the firewall", "we'll need to poll instead"],
      ["A cron job won't work because we need sub-minute latency", 'so we should use a queue'],
      ["If we do it that way it won't work offline", "so let's cache the manifest"],
      ["We still need fresh reads, so a cache won't work", "let's query the DB"],
      ["Your proposal won't work here", 'instead we should shard by key'],
      ["The retry won't work if the lookup fails", "so let's add a fallback"],
      ["Redis won't work for us anymore", "let's use SQLite"],
    ]);

    const WONT_WORK_DESIGN_DISCUSSION_SINGLE = [
      "Let's query the DB. A cache won't work here.",
      "Let's query the DB, a cache won't work here.",
      "A global lock won't work at scale. The point you made about contention holds, so let's shard by key.",
      "Your solution won't work here, instead we should shard by key.",
    ];

    // Known residuals, pinned to the current verdict so a rule change that
    // fixes or reopens one shows up here.
    const KNOWN_FALSE_POSITIVES = [
      // Rules out an option without proposing one.
      "That approach won't work for production.",
      // A bare-pronoun opener may point at a proposal rather than code; the text can't tell which.
      "It won't work on Windows, so we should use fs.watch.",
      // The proposal is two sentences away, outside the one-sentence window.
      "A cache won't work here. We need fresh reads. Let's query the DB.",
      // "still won't work" marks a repeat failure of the assistant's attempt; a concessive "even with X" reads the same.
      "Even with the polyfill, polling still won't work on Windows, so let's use fs.watch.",
      // An imperative proposal. Imperatives carry corrections as often ("handle undefined too"), so they aren't a cue.
      "Polling won't work on Windows, use fs.watch.",
    ];

    const KNOWN_MISSES = [
      // Names the rejected code with a noun phrase and proposes a fix: reads as design discussion.
      "The null check won't work, we need to handle undefined too.",
      // Curly apostrophe.
      'That won’t work.',
    ];

    it.each([...WONT_WORK_CORRECTIONS, ...WONT_WORK_CORRECTIONS_WITH_PROPOSAL])(
      'detects a correction for %j',
      (text) => {
        expect(countCorrections(text)).toBe(1);
      },
    );

    it.each([...WONT_WORK_DESIGN_DISCUSSION, ...WONT_WORK_DESIGN_DISCUSSION_SINGLE])(
      'does not count %j as a correction',
      (text) => {
        expect(countCorrections(text)).toBe(0);
      },
    );

    it.each(KNOWN_FALSE_POSITIVES)('counts %j (known false positive)', (text) => {
      expect(countCorrections(text)).toBe(1);
    });

    it.each(KNOWN_MISSES)('does not count %j (known miss)', (text) => {
      expect(countCorrections(text)).toBe(0);
    });

    it('counts a bare "That won\'t work." opener when the next sentence adds a task', () => {
      expect(countCorrections("That won't work. Let's also add a test for the empty case.")).toBe(
        1,
      );
    });

    it("lets a reference to the assistant's output in the next sentence override its forward cue", () => {
      expect(
        countCorrections(
          "That approach won't work. Your migration drops the index, let's add it back.",
        ),
      ).toBe(1);
    });

    it('still counts a later correcting sentence when an earlier one is design discussion', () => {
      expect(
        countCorrections(
          "Redis won't work for us, let's use SQLite. Also your migration still won't work.",
        ),
      ).toBe(1);
    });

    interface HeldOutSet {
      readonly source: string;
      readonly rows: ReadonlyArray<{
        readonly text: string;
        readonly label: 'correction' | 'design';
        readonly context: string;
      }>;
    }

    // Written by models that hadn't seen the rule and scored after it was frozen, so they estimate
    // how its word lists generalise. The scores are pinned measurements, not targets: tune the rule
    // on the labeled corpus above, then update these.
    const HELD_OUT: Readonly<Record<string, HeldOutSet>> = (
      JSON.parse(
        readFileSync(resolve(__dirname, '../../test/fixtures/wont-work-held-out.json'), 'utf-8'),
      ) as { sets: Record<string, HeldOutSet> }
    ).sets;

    it.each([
      ['A', { corrections: 25, counted: 25, design: 25, flagged: 23 }],
      ['B', { corrections: 25, counted: 22, design: 25, flagged: 20 }],
    ])('scores held-out set %s', (name, expected) => {
      const rows = HELD_OUT[name].rows;
      const corrections = rows.filter((r) => r.label === 'correction');
      const design = rows.filter((r) => r.label === 'design');
      expect({
        corrections: corrections.length,
        counted: corrections.filter((r) => countCorrections(r.text) === 1).length,
        design: design.length,
        flagged: design.filter((r) => countCorrections(r.text) === 1).length,
      }).toEqual(expected);
    });

    // Fake timers freeze Date.now(), so they can't time a regex. Each input is
    // sized so a backtracking pattern takes seconds while the linear one takes
    // about a millisecond, which keeps the budget far from the line.
    it.each([
      [
        'repeated phrase with no punctuation',
        `${"won't work ".repeat(5_000)}${'x '.repeat(50_000)}let's`,
      ],
      ['long run of sentence punctuation', `A cache won't work ${'.'.repeat(50_000)}x let's`],
      ['long run of mixed punctuation', `A cache won't work ${'.!?'.repeat(20_000)}x let's`],
      ['long whitespace after a modal', `A cache won't work, we can${' '.repeat(100_000)}x`],
    ])('stays fast on a long adversarial message: %s', (_label, text) => {
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
