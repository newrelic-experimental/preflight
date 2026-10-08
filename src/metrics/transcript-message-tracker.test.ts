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

/** An assistant entry whose only content block calls the tool `name`. */
function toolUseLine(name: string, overrides: Record<string, unknown> = {}): string {
  return assistantLine({
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [
        { type: 'tool_use', id: `t-${Math.random().toString(36).slice(2)}`, name, input: {} },
      ],
    },
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
    ["That won't work, there's a race condition."],
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

  // #677: "won't work" reads the assistant's turn before the message. These
  // pin how the transcript sets that turn state; the corpus below pins what
  // each state decides.
  describe("turn state for won't work (#677)", () => {
    /** Read before an unrelated exchange, so the transcript has shown it records tool calls. */
    const EARLIER_EXCHANGE = [toolUseLine('Read'), userLine('go ahead')];
    /** Counts in every turn state, so it shows the state matters only for "won't work". */
    const ANY_STATE = "That's wrong, please redo it.";
    /** Counts after a turn that acted, and not after one that talked. */
    const ACTED_ONLY = "That approach won't work because there's a race condition.";
    /** Counts on its text alone, and not after a turn that talked. */
    const TEXT_ONLY = "That won't work.";

    function corrections(lines: string[]): number {
      writeLines(lines);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      return tracker.getMetrics().userCorrections;
    }

    it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'Agent'])(
      'reads a turn that called %s as acting',
      (tool) => {
        expect(corrections([...EARLIER_EXCHANGE, toolUseLine(tool), userLine(ACTED_ONLY)])).toBe(1);
      },
    );

    it.each([
      'Read',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'TodoWrite',
      'mcp__github__get_issue',
    ])('reads a turn that only called %s as talking', (tool) => {
      expect(corrections([...EARLIER_EXCHANGE, toolUseLine(tool), userLine(TEXT_ONLY)])).toBe(0);
    });

    it('reads a text-only turn as talking once the transcript has shown a tool call', () => {
      expect(corrections([...EARLIER_EXCHANGE, assistantLine(), userLine(TEXT_ONLY)])).toBe(0);
      expect(corrections([...EARLIER_EXCHANGE, assistantLine(), userLine(ANY_STATE)])).toBe(1);
    });

    it('decides on the text alone before the transcript has shown a tool call', () => {
      expect(corrections([assistantLine(), userLine(TEXT_ONLY)])).toBe(1);
      expect(corrections([assistantLine(), userLine(ACTED_ONLY)])).toBe(0);
    });

    it('decides on the text alone when no assistant entry came since the last user message', () => {
      expect(corrections([toolUseLine('Edit'), userLine('ok'), userLine(ACTED_ONLY)])).toBe(0);
      expect(corrections([toolUseLine('Read'), userLine('ok'), userLine(TEXT_ONLY)])).toBe(1);
    });

    it('keeps a turn acting through the text and tool results that follow the action', () => {
      expect(
        corrections([
          ...EARLIER_EXCHANGE,
          toolUseLine('Edit'),
          userLine([{ type: 'tool_result', content: 'ok' }], { toolUseResult: { ok: true } }),
          toolUseLine('Read'),
          assistantLine(),
          userLine(ACTED_ONLY),
        ]),
      ).toBe(1);
    });

    it('starts each turn over at a real user message', () => {
      expect(
        corrections([
          toolUseLine('Edit'),
          userLine('thanks, now explain the retry logic'),
          assistantLine(),
          userLine(ACTED_ONLY),
        ]),
      ).toBe(0);
    });

    it('ignores sidechain and synthetic assistant entries', () => {
      const syntheticEdit = assistantLine({
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'tool_use', id: 't-synthetic', name: 'Edit', input: {} }],
        },
      });
      expect(
        corrections([
          ...EARLIER_EXCHANGE,
          assistantLine(),
          toolUseLine('Edit', { isSidechain: true }),
          syntheticEdit,
          userLine(ACTED_ONLY),
        ]),
      ).toBe(0);
    });

    it('reset() forgets the turn state', () => {
      writeLines([toolUseLine('Edit')]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      tracker.reset();
      writeLines([userLine(ACTED_ONLY)]);
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      expect(tracker.getMetrics().userCorrections).toBe(0);
    });
  });

  // #677: labeled corpus for the "won't work" clause. Corrections reject
  // something the assistant already produced; design discussion rules out an
  // option before anything was built, with or without proposing the next one.
  describe("won't work corpus (#677)", () => {
    /** Classifies `text` with no assistant entry before it, so the text decides alone. */
    function countCorrections(text: string): number {
      writeLines([userLine(text)]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      return tracker.getMetrics().userCorrections;
    }

    /**
     * Classifies `text` after an assistant turn that called `tools`, in order. An empty list is a
     * text-only reply. An unrelated exchange comes first, in which the assistant reads a file, so the
     * transcript has shown it records tool calls.
     */
    function countCorrectionsAfterTurn(text: string, tools: readonly string[]): number {
      writeLines([
        toolUseLine('Read'),
        userLine('go ahead'),
        ...(tools.length === 0 ? [assistantLine()] : tools.map((name) => toolUseLine(name))),
        userLine(text),
      ]);
      const tracker = new TranscriptMessageTracker();
      tracker.observeTranscriptPath(transcriptPath);
      tracker.refresh();
      return tracker.getMetrics().userCorrections;
    }

    const ACTED: readonly string[] = ['Edit'];
    const TALKED: readonly string[] = [];

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
      // Up to two leading interjections or conjunctions, with or without punctuation after them.
      "Yeah that won't work.",
      "Yeah, that won't work.",
      "Hmm that won't work",
      "But that won't work.",
      "Hmm, no, that won't work.",
      // No subject at all after the interjection.
      "Nah, won't work — the value can be undefined too.",
      // A first-person report that running the assistant's output fails now.
      "I tried it and it won't work.",
      "I just tried it and it won't work.",
      "I tried it. It won't work.",
      "I tried it, it won't work.",
      "Tried it, won't work.",
      "Tried it and it won't work.",
      // A leading word may end in a question mark or a colon, and "now" and "wait" lead like fillers.
      "Huh? That won't work.",
      "Argh: that won't work.",
      "Wait? That won't work.",
      "Wait that won't work.",
      "Now it won't work.",
      // A pronoun and something built is a pronoun too.
      "That fix won't work.",
      "This change won't work.",
      "These changes won't work.",
      // A curly apostrophe reads like a straight one.
      'That won’t work.',
    ];

    /**
     * Corrections next to a proposal, which doesn't change the verdict: each counts through a
     * bare-pronoun opener or a reference to the assistant's output. The bare-pronoun pairs only run
     * reject-first: put the proposal first and the pronoun points at it ("Let's use a map instead.
     * That won't work."), which is design discussion.
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

    /** Constraints with no proposal, or with the proposal out of reach, read as design discussion too. */
    const WONT_WORK_DESIGN_DISCUSSION_SINGLE = [
      "Let's query the DB. A cache won't work here.",
      "Let's query the DB, a cache won't work here.",
      "A global lock won't work at scale. The point you made about contention holds, so let's shard by key.",
      "Your solution won't work here, instead we should shard by key.",
      "That approach won't work for production.",
      "A cache won't work here. We need fresh reads. Let's query the DB.",
      "Polling won't work on Windows, use fs.watch.",
      // A leading conjunction doesn't stand in for a named subject.
      "But a cache won't work here since we need fresh reads.",
      "So polling won't work on Windows, let's use fs.watch.",
    ];

    // Known residuals, pinned to the current verdict so a rule change that
    // fixes or reopens one shows up here.
    const KNOWN_FALSE_POSITIVES = [
      // A bare-pronoun opener may point at a proposal rather than code; the text can't tell which.
      "It won't work on Windows, so we should use fs.watch.",
      // "still won't work" marks a repeat failure of the assistant's attempt; a concessive "even with X" reads the same.
      "Even with the polyfill, polling still won't work on Windows, so let's use fs.watch.",
      // Any word followed by punctuation can lead the opener, so agreeing with the assistant's caveat reads the same.
      "Agreed, that won't work, let's go with option B.",
      // "you have" plus an adjective in -ed reads as a perfect ("you have limited the retries").
      "Since you have limited memory, an in-memory cache won't work.",
      // "your version" is the assistant's code as often as the user's environment.
      "Top-level await won't work in your version of Node.",
      // The window reaches the sentence before, which here closes an earlier topic.
      "Thanks, you fixed the login bug. Next, a cache won't work here since we need fresh reads.",
      // A "when you" or "once you" with a past form is a reference as often as a condition.
      "When you set a TTL, the cache won't work for live data.",
      "Once you set a TTL, the cache won't work for live data.",
      // A named subject followed by punctuation leads the opener like an interjection does.
      "Websockets, no, won't work behind the firewall, we'll poll.",
      // A leading filler before a bare-pronoun opener, same as "It won't work on Windows, ...".
      "So this won't work on Windows, let's use fs.watch.",
      // A noun ending in "-ly" fills the adverb slot of the opener.
      "This assembly won't work on ARM.",
      // A progressive "you're <verb>ing" after a temporal "when" or a causal "since" reads as a reference.
      "Polling won't work when you're running on Windows, let's use fs.watch.",
      "Since you're using Windows, symlinks won't work.",
      // "your" plus "test" reads as the assistant's test, here in the sentence before.
      "Your test environment has a single node. A cache won't work at our write volume.",
      // A question mark after a named subject closes a leading word like it does after "Huh".
      "Redis? That won't work for us.",
    ];

    const KNOWN_MISSES = [
      // Each names the option or the code and gives a reason without pointing back at the assistant,
      // which reads the same as a constraint on an option.
      "That approach won't work because there's a race condition.",
      "That approach won't work because we can't lock the table.",
      "The migration won't work, it drops the index instead of renaming it.",
      "The migration won't work, it drops the index rather than renaming it.",
      "The null check won't work, we need to handle undefined too.",
      // A dash after the filler, or a leading adverb outside the list, isn't a leading word.
      "Yeah — that won't work.",
      "Honestly that won't work.",
      "Hold on, that won't work.",
      // A negated past verb ("didn't") isn't one of the past forms a "you" reference takes.
      "The cache won't work. You didn't invalidate it.",
      // A past form with an auxiliary ("had created", "been caching") isn't one a "you" reference takes.
      "The index you had created won't work.",
      "You've been caching the response, so the cache won't work.",
      // A contraction can't be a leading word.
      "You're wrong, it won't work.",
      // The opener is read only at the start of the message, not after pasted output.
      "Ran npm test:\nFAIL src/auth.test.ts\nThat won't work.",
      // "your approach" can name a plan, like "your proposal" and "your solution", so it isn't a built artifact.
      "Your approach won't work for us, let's go back.",
    ];

    /** Second person that points back at the assistant's output, in the "won't work" sentence or next to it. */
    const WONT_WORK_YOU_REFERENCES = [
      "A cache won't work here, you're reading from the replica.",
      "Polling won't work on Windows. You've hardcoded the path separator.",
      "You already removed the watcher. Polling won't work now.",
      "The regex won't work for unicode, you only allowed ASCII.",
      "The command you ran won't work in CI.",
      // A causal "since you" or a past "when you" is about the assistant's output, unlike a conditional "if you".
      "Since you removed the null check, the parser won't work.",
      "When you renamed the env var, the deploy script won't work anymore.",
      "When you added the retry, the tests won't work.",
      "It broke when you changed the config. Now the parser won't work.",
      // Plural artifacts.
      "Your fixes won't work.",
      "Your patches won't work on Windows.",
      "Your queries won't work against the replica.",
      'Your fix won’t work.',
      // "raised" and "pointed" are edits here, not ways of making a point.
      "The timeout you raised won't work, the gateway still cuts at 30s.",
      "You pointed the client at the replica, so the migration won't work.",
      // "At this point" is an idiom, not a remark the assistant made.
      "At this point you've broken the build, so the deploy won't work.",
    ];

    /** Second person that is about an idea, a hypothetical or anyone, not the assistant's output. */
    const WONT_WORK_YOU_NOT_ABOUT_OUTPUT = [
      "The cache you suggested won't work, we need fresh reads.",
      "A cache won't work the way you're describing.",
      "That idea won't work, you're going to need a queue.",
      "Polling won't work, you can't hold connections on serverless.",
      "A lock won't work, you need a queue.",
      "If you added a cache it won't work across pods.",
      "You're right that a cache won't work here.",
      "The plan you made won't work for us.",
      "As you explained, a cache won't work here.",
      "The approach you floated won't work at scale, let's shard by key.",
      "Suppose you added a cache, it won't work across pods.",
      "Assuming you added a cache, it won't work across pods.",
      // An inverted "have you" asks or suggests rather than reporting what the assistant did.
      "Have you tried Redis? Polling won't work on Windows.",
    ];

    it.each([
      ...WONT_WORK_CORRECTIONS,
      ...WONT_WORK_CORRECTIONS_WITH_PROPOSAL,
      ...WONT_WORK_YOU_REFERENCES,
    ])('detects a correction for %j', (text) => {
      expect(countCorrections(text)).toBe(1);
    });

    it.each([
      ...WONT_WORK_DESIGN_DISCUSSION,
      ...WONT_WORK_DESIGN_DISCUSSION_SINGLE,
      ...WONT_WORK_YOU_NOT_ABOUT_OUTPUT,
    ])('does not count %j as a correction', (text) => {
      expect(countCorrections(text)).toBe(0);
    });

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

    it("counts a reference to the assistant's output in the next sentence", () => {
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

    // The lists above classify the text alone, as when no assistant entry came before it. The
    // lists below classify it after a turn that acted (called a tool in MUTATING_TOOLS) or talked
    // (called none).

    /** After a turn that changed something, "won't work" rejects what it changed, whatever its subject. */
    const ACTED_CORRECTIONS = [
      "That won't work if the list is empty.",
      // "going to" is future tense here, not a report of an idea.
      "That won't work, you're going to need a lock around it.",
      "That terraform plan won't work, you're creating the bucket and its policy in one apply.",
      "A singleton won't work here, every request needs its own client.",
      "Your approach won't work for us, let's go back.",
    ];

    /** A hypothetical option, agreement with the assistant, or an idea it proposed is design discussion after a turn that acted too. */
    const ACTED_DESIGN = [
      "If you added a cache it won't work across pods.",
      "If we do it that way it won't work offline, so let's cache the manifest.",
      "Suppose you added a cache, it won't work across pods.",
      "You're right that a cache won't work here.",
      "Agreed, that won't work, let's go with option B.",
      "You're right. That won't work on Windows, let's add a fallback.",
      "The cache you suggested won't work, we need fresh reads.",
      "As you explained, a cache won't work here.",
      "The approach you floated won't work at scale, let's shard by key.",
      "That idea won't work, you're going to need a queue.",
      "Your proposal won't work here, instead we should shard by key.",
      "Your plan won't work for us.",
      "A cache won't work the way you're describing.",
    ];

    /** After a turn that acted, design talk about an option the turn didn't touch reads as rejecting the change. */
    const ACTED_KNOWN_FALSE_POSITIVES = [
      "Redis won't work for us, let's use SQLite.",
      "Have you tried Redis? Polling won't work on Windows.",
      "Polling won't work, you can't hold connections on serverless.",
      // An idea named in the sentence before doesn't count, only one in the "won't work" sentence.
      "A global lock won't work at scale. The point you made about contention holds, so let's shard by key.",
      // "plan" names an idea only after "your", since "the plan" is also a Terraform plan.
      "The plan you made won't work for us.",
    ];

    /** After a turn that only answered, "won't work" counts when it points back at something built earlier. */
    const TALKED_CORRECTIONS = [
      "The migration you wrote still won't work.",
      "Your fix from earlier won't work on Windows.",
      "It still won't work.",
      "When you renamed the env var, the deploy script won't work anymore.",
      "The regex you added yesterday won't work for unicode.",
      "That approach won't work. Your migration drops the index, let's add it back.",
      "At this point you've broken the build, so the deploy won't work.",
    ];

    /** After a turn that only answered or proposed, a "won't work" that doesn't point back rejects the proposal. */
    const TALKED_DESIGN = [
      "That won't work.",
      "That won't work, let's use a map instead.",
      "Nah, won't work — the value can be undefined too.",
      "That approach won't work because there's a race condition.",
      // The user ran an option the assistant only proposed.
      "I tried it and it won't work.",
      // After a proposal, a present progressive describes the proposal as often as the code.
      "A cache won't work here, you're reading from the replica.",
    ];

    const TALKED_KNOWN_FALSE_POSITIVES = [
      // "still won't work" marks a repeat failure; a concessive "even with X" reads the same.
      "Even with the polyfill, polling still won't work on Windows, so let's use fs.watch.",
      // "your" plus "test" reads as the assistant's test.
      "Your test environment has a single node. A cache won't work at our write volume.",
    ];

    const TALKED_KNOWN_MISSES = [
      // Names output built earlier without pointing back at it, which reads like rejecting a proposal.
      "The migration won't work, it drops the index instead of renaming it.",
    ];

    it.each([
      ...ACTED_CORRECTIONS,
      // Every text-alone correction, and every text-alone miss.
      ...WONT_WORK_CORRECTIONS,
      ...WONT_WORK_CORRECTIONS_WITH_PROPOSAL,
      ...WONT_WORK_YOU_REFERENCES,
      ...KNOWN_MISSES,
    ])('counts %j after a turn that acted', (text) => {
      expect(countCorrectionsAfterTurn(text, ACTED)).toBe(1);
    });

    it.each(ACTED_DESIGN)('does not count %j after a turn that acted', (text) => {
      expect(countCorrectionsAfterTurn(text, ACTED)).toBe(0);
    });

    it.each(ACTED_KNOWN_FALSE_POSITIVES)(
      'counts %j after a turn that acted (known false positive)',
      (text) => {
        expect(countCorrectionsAfterTurn(text, ACTED)).toBe(1);
      },
    );

    it.each(TALKED_CORRECTIONS)('counts %j after a turn that talked', (text) => {
      expect(countCorrectionsAfterTurn(text, TALKED)).toBe(1);
    });

    it.each([
      ...TALKED_DESIGN,
      // Every text-alone design row, since a turn that talked counts a subset of what the text alone does.
      ...WONT_WORK_DESIGN_DISCUSSION,
      ...WONT_WORK_DESIGN_DISCUSSION_SINGLE,
      ...WONT_WORK_YOU_NOT_ABOUT_OUTPUT,
    ])('does not count %j after a turn that talked', (text) => {
      expect(countCorrectionsAfterTurn(text, TALKED)).toBe(0);
    });

    it.each(TALKED_KNOWN_FALSE_POSITIVES)(
      'counts %j after a turn that talked (known false positive)',
      (text) => {
        expect(countCorrectionsAfterTurn(text, TALKED)).toBe(1);
      },
    );

    it.each(TALKED_KNOWN_MISSES)(
      'does not count %j after a turn that talked (known miss)',
      (text) => {
        expect(countCorrectionsAfterTurn(text, TALKED)).toBe(0);
      },
    );

    it.each([
      ['That approach won’t work because there’s a race condition.', 0, 1, 0],
      ['You’re right that a cache won’t work here.', 0, 0, 0],
      ['The migration you wrote still won’t work.', 1, 1, 1],
      // The apostrophe matters outside "won't work" too.
      ['Don’t do that.', 1, 1, 1],
      ['No, that’s fine, it’s only a draft.', 0, 0, 0],
    ])(
      'reads curly apostrophes like straight ones in %j',
      (text, textAlone, afterActing, afterTalking) => {
        const straight = text.replace(/\u2019/g, "'");
        expect([
          countCorrections(text),
          countCorrectionsAfterTurn(text, ACTED),
          countCorrectionsAfterTurn(text, TALKED),
        ]).toEqual([textAlone, afterActing, afterTalking]);
        expect([
          countCorrections(straight),
          countCorrectionsAfterTurn(straight, ACTED),
          countCorrectionsAfterTurn(straight, TALKED),
        ]).toEqual([textAlone, afterActing, afterTalking]);
      },
    );

    interface HeldOutRow {
      readonly text: string;
      readonly label: 'correction' | 'design';
    }

    interface HeldOutSet<Row extends HeldOutRow> {
      readonly source: string;
      readonly rows: readonly Row[];
    }

    /** Sets A, B and C describe the assistant's previous turn in prose. */
    type ContextRow = HeldOutRow & { readonly context: string };

    /** Set D lists the tools the assistant called in its previous turn, and summarises its reply. */
    type ToolRow = HeldOutRow & {
      readonly assistantTools: readonly string[];
      readonly assistantText: string;
    };

    const readSets = <Row extends HeldOutRow>(
      file: string,
    ): Readonly<Record<string, HeldOutSet<Row>>> =>
      (
        JSON.parse(readFileSync(resolve(__dirname, `../../test/fixtures/${file}`), 'utf-8')) as {
          sets: Record<string, HeldOutSet<Row>>;
        }
      ).sets;

    interface Score {
      readonly corrections: number;
      readonly design: number;
      readonly missed: readonly number[];
      readonly flagged: readonly number[];
    }

    function score<Row extends HeldOutRow>(
      rows: readonly Row[],
      count: (row: Row) => number,
    ): Score {
      const indexed = rows.map((row, index) => ({ row, index }));
      const corrections = indexed.filter(({ row }) => row.label === 'correction');
      const design = indexed.filter(({ row }) => row.label === 'design');
      return {
        corrections: corrections.length,
        design: design.length,
        missed: corrections.filter(({ row }) => count(row) === 0).map(({ index }) => index),
        flagged: design.filter(({ row }) => count(row) === 1).map(({ index }) => index),
      };
    }

    /** The ceiling is checked first, so a recall drop fails even after the pinned indices are updated. */
    function expectScore(actual: Score, expected: Score, maxMissed: number): void {
      expect(actual.missed.length).toBeLessThanOrEqual(maxMissed);
      expect(actual).toEqual(expected);
    }

    /**
     * The first verb of a set A, B or C `context` says whether the assistant built or did something
     * in its previous turn, or only answered. A verb missing here fails the test rather than
     * defaulting to either state.
     */
    const CONTEXT_VERB_TURN = new Map<string, readonly string[]>([
      // Built or did something: an Edit stands in for the turn.
      ...[
        'added',
        'applied',
        'called',
        'changed',
        'configured',
        'edited',
        'generated',
        'implemented',
        'mocked',
        'optimized',
        'produced',
        'ran',
        'refactored',
        'renamed',
        'rewrote',
        'set',
        'simplified',
        'used',
        'wrote',
      ].map((verb): [string, readonly string[]] => [verb, ACTED]),
      // Only answered: asked, proposed or weighed an option ("was weighing", "was discussing").
      ...['asked', 'proposed', 'recommended', 'suggested', 'was'].map(
        (verb): [string, readonly string[]] => [verb, TALKED],
      ),
    ]);

    function contextTurn(context: string): readonly string[] {
      const verb = /^(?:the )?assistant (\w+)/i.exec(context)?.[1] ?? '';
      const tools = CONTEXT_VERB_TURN.get(verb);
      if (tools === undefined) throw new Error(`No turn for context verb ${JSON.stringify(verb)}`);
      return tools;
    }

    // Model-written sets. A, B and C were read while writing the turn-state rule, so they are
    // development data. D was written and committed (0cf775d) before that rule, which was frozen at
    // 3dd6853 and then scored on D once, so D is the estimate of how it generalises. C played that
    // part for the text-alone rule, first scored at b241f1b. The
    // results are pinned measurements, not targets: a rule change updates them, and only a fresh set
    // can say whether the change generalises. Each set pins the row indices of the corrections it
    // misses and the design rows it flags, so a change that swaps which rows pass at the same totals
    // shows up too. Each also caps its misses at the recall the rule was accepted at, so a recall drop
    // fails even when the indices are re-pinned. Raising a cap is a decision to lose recall.
    const CONTEXT_SETS: Readonly<Record<string, HeldOutSet<ContextRow>>> = {
      ...readSets<ContextRow>('wont-work-held-out.json'),
      ...readSets<ContextRow>('wont-work-held-out-c.json'),
    };

    it.each([
      ['A', 1, { corrections: 25, design: 25, missed: [48], flagged: [26, 43] }],
      [
        'B',
        17,
        {
          corrections: 25,
          design: 25,
          missed: [0, 1, 5, 7, 9, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 24],
          flagged: [],
        },
      ],
      ['C', 4, { corrections: 40, design: 40, missed: [21, 37, 45, 70], flagged: [22, 62, 79] }],
    ] as const)('scores held-out set %s on its text alone', (name, maxMissed, expected) => {
      expectScore(
        score(CONTEXT_SETS[name].rows, (row) => countCorrections(row.text)),
        expected,
        maxMissed,
      );
    });

    it.each([
      ['A', 0, { corrections: 25, design: 25, missed: [], flagged: [] }],
      // The four rows B's source note counts as rejecting a suggestion, which its context says was only proposed.
      ['B', 4, { corrections: 25, design: 25, missed: [7, 16, 18, 24], flagged: [] }],
      ['C', 0, { corrections: 40, design: 40, missed: [], flagged: [] }],
    ] as const)(
      'scores held-out set %s with the turn its context describes',
      (name, maxMissed, expected) => {
        expectScore(
          score(CONTEXT_SETS[name].rows, (row) =>
            countCorrectionsAfterTurn(row.text, contextTurn(row.context)),
          ),
          expected,
          maxMissed,
        );
      },
    );

    const TOOL_SETS = readSets<ToolRow>('wont-work-held-out-d.json');

    it('scores held-out set D on its text alone', () => {
      expectScore(
        score(TOOL_SETS.D.rows, (row) => countCorrections(row.text)),
        {
          corrections: 40,
          design: 40,
          missed: [0, 29, 38, 39, 57, 59, 65],
          flagged: [
            1, 6, 13, 16, 23, 26, 27, 30, 31, 34, 37, 40, 51, 67, 71, 73, 74, 75, 76, 77, 79,
          ],
        },
        7,
      );
    });

    it('scores held-out set D with the tools its assistant called', () => {
      expectScore(
        score(TOOL_SETS.D.rows, (row) => countCorrectionsAfterTurn(row.text, row.assistantTools)),
        { corrections: 40, design: 40, missed: [], flagged: [15, 41, 43, 44, 64, 78, 79] },
        0,
      );
    });

    // Fake timers freeze Date.now(), so they can't time a regex. Each input is
    // sized so a backtracking pattern takes seconds while the linear one takes
    // about a millisecond, which keeps the budget far from the line. Each runs
    // in every turn state, since each state reads the message with other patterns.
    const ADVERSARIAL_MESSAGES: ReadonlyArray<readonly [string, string]> = [
      [
        'repeated phrase with no punctuation',
        `${"won't work ".repeat(5_000)}${'x '.repeat(50_000)}let's`,
      ],
      ['long run of sentence punctuation', `A cache won't work ${'.'.repeat(50_000)}x let's`],
      ['long run of mixed punctuation', `A cache won't work ${'.!?'.repeat(20_000)}x let's`],
      ['long whitespace inside the sentence', `A cache won't work, we can${' '.repeat(100_000)}x`],
      ['long word after "you"', `A cache won't work, you ${'e'.repeat(400_000)}x`],
      ['long word after "you\'re"', `A cache won't work, you're ${'i'.repeat(400_000)}x`],
      ['repeated "you" with an adverb', `A cache won't work ${'you just '.repeat(44_000)}`],
      ['repeated hypothetical "you"', `A cache won't work ${'if you unless you '.repeat(22_000)}`],
      ['repeated hypothetical before the phrase', `${'if you '.repeat(60_000)}won't work`],
      ['repeated idea source', `A cache won't work ${'you just suggested '.repeat(20_000)}`],
      ['repeated "at this point you"', `A cache won't work ${'at this point you '.repeat(22_000)}`],
      ['long letter run before the phrase', `${'a'.repeat(400_000)} won't work`],
      ['repeated leading filler', `${'hmm, '.repeat(80_000)}won't work`],
      ['repeated agreement', `${'agreed, '.repeat(50_000)}that won't work`],
      ['long letter run in a filler', `h${'m'.repeat(400_000)}x won't work`],
      ['long punctuation run after a filler', `Hmm${','.repeat(400_000)}x won't work`],
      ['long question-mark run after a word', `Huh${'?'.repeat(400_000)}x won't work`],
      ['long whitespace after a filler', `Hmm${' '.repeat(400_000)}x won't work`],
      ['long whitespace after "I tried it"', `I tried it,${' '.repeat(400_000)}x won't work`],
      ['long whitespace after "Tried it."', `Tried it.${' '.repeat(400_000)}x won't work`],
      [
        'repeated "when you" in the reference scan',
        `A cache won't work ${'when you '.repeat(44_000)}`,
      ],
    ];

    /** The entries before the message, and how many real user messages they hold. */
    const TURNS: ReadonlyArray<readonly [string, readonly string[], number]> = [
      ['no turn', [], 0],
      ['a turn that acted', [toolUseLine('Read'), userLine('go ahead'), toolUseLine('Edit')], 1],
      ['a turn that talked', [toolUseLine('Read'), userLine('go ahead'), assistantLine()], 1],
    ];

    it.each(
      ADVERSARIAL_MESSAGES.flatMap(([label, text]) =>
        TURNS.map(
          ([turn, lines, earlierMessages]) => [label, turn, text, lines, earlierMessages] as const,
        ),
      ),
    )(
      'stays fast on a long adversarial message: %s, after %s',
      (_label, _turn, text, lines, earlierMessages) => {
        writeLines([...lines, userLine(text)]);
        const tracker = new TranscriptMessageTracker();
        tracker.observeTranscriptPath(transcriptPath);
        const start = Date.now();
        tracker.refresh();
        expect(Date.now() - start).toBeLessThan(1_000);
        // A line over the read cap is skipped unread, which would pass the timing for free.
        expect(tracker.getMetrics().userMessages).toBe(earlierMessages + 1);
      },
    );
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
