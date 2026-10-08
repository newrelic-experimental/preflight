import { openSync, closeSync, readSync, statSync, constants as fsConstants } from 'node:fs';

import { isRealAssistantTurn } from '../lib/subagent-transcript-parser.js';
import { splitShellChain } from './git-event-classifier.js';

import type { RawTranscriptEntry } from '../lib/transcript-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptMessageMetrics {
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly userCorrections: number;
}

/**
 * What the assistant did between the last user entry that ended its turn (`endsAssistantTurn`) and
 * the next real user message: `acted` when it called a tool that changes something
 * (`isMutatingToolUse`), `talked` when its entries called none, and `unknown` when no assistant
 * entry came between them (the first message, or two user messages in a row). It is also `unknown`
 * until the transcript has shown a tool call at all, since a format that doesn't record tool calls
 * makes a turn that acted look like one that talked.
 */
export type AssistantTurnState = 'acted' | 'talked' | 'unknown';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Content-prefix markers for synthetic `type: 'user'` entries that carry no
 * structural field (isMeta/isCompactSummary/origin/toolUseResult) to key off
 * of. Best-effort and non-exhaustive — new harness-injected message shapes
 * may need to be added here as they're discovered.
 */
const SYNTHETIC_TEXT_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<task-notification>',
  '<system-reminder>',
  'Another Claude session sent a message:',
];

/** "actually" alone is a refinement filler ("actually, let's also add tests"), not a rejection signal. */
const OPTIONAL_ACTUALLY = '(?:actually,?\\s+)?';

/** Leading "no"/"nope", guarded against reassurance phrases and acknowledgments that aren't corrections. */
const LEADING_NO_RE = new RegExp(
  `^${OPTIONAL_ACTUALLY}(no|nope)\\b(?!,?\\s*(rush|worries|problem|prob\\b|biggie|need|thanks|that'?s (fine|ok|okay)))`,
  'i',
);

/** "wrong"/"incorrect" leading a message are rarely anything but a rejection. */
const BARE_REJECTION_RE = /^(wrong|incorrect)\b/i;

/** Explicit rejection of the assistant's last output, optionally softened by "actually". */
const EXPLICIT_REJECTION_RE = new RegExp(
  `^${OPTIONAL_ACTUALLY}(that'?s|this is) (not|wrong|incorrect)\\b`,
  'i',
);

/** A trigger word immediately followed by punctuation reads as an interjection, not a task instruction ("Stop the dev server" has no punctuation there). "no"/"nope" are handled by LEADING_NO_RE instead, so its reassurance/acknowledgment guard isn't bypassed. */
const LEADING_INTERJECTION_RE = /^(stop|wait|undo|revert)[.,!]/i;

/** Common adverbs that can trail a standalone undo pronoun ("undo it now", "don't do that again") without turning it into a noun-phrase modifier. Not exhaustive — hand-picked, not data-derived. Deliberately excludes "first": it's an ordinal adjective as often as an adverb ("revert that first commit"), so allowing it would reopen the exact noun-phrase false positive this regex exists to close. */
const UNDO_TRAILING_ADVERBS = 'again|now|already|please|instead';

/** Undo verbs only count as a correction when they target the assistant's own action as a standalone object ("undo that", "don't do that", "undo it now") — a pronoun followed by any other word is modifying that noun ("revert that commit", "don't push to that branch"), not standing in for the assistant's prior action. */
const TARGETED_UNDO_RE = new RegExp(
  `^(stop|undo|revert|don'?t)\\b[^.!?]{0,20}\\b(that|it|this)\\b(?!\\s+(?!(?:${UNDO_TRAILING_ADVERBS})\\b)\\S)`,
  'i',
);

/** Correction phrasing that doesn't require a trigger word at the start of the message. */
const EMBEDDED_CORRECTION_RE =
  /\b(you (missed|forgot|broke)|that'?s (not (right|correct|what)|wrong|incorrect)|not what (i|you)'?d? (meant|asked|wanted|said)|this is the (\d+|second|third|fourth|fifth|\w+th) time)\b/i;

/** "won't work", with or without the apostrophe. Text is read after `normalizeApostrophes`. */
const WONT_WORK_RE = /\bwon'?t work\b/i;

/** Interjections and conjunctions that can lead a verdict without being its subject ("Yeah that won't work", "But it won't work", "Hmm, no, won't work", "Now it won't work"). */
const LEADING_FILLER =
  'yeah|yep|yes|ok|okay|hm+|um+|uh+|ah|oh|well|so|but|and|nah|no|nope|sorry|ugh|now|wait';

/** Punctuation that can close a leading word ("Agreed,", "Huh?", "Argh:"). */
const LEADING_PUNCTUATION = '[,.!?:]';

/** A leading word: a filler with or without punctuation after it, or any other word with punctuation after it ("Agreed, ..."). The lookahead keeps the two alternatives disjoint, so the quantified group can't backtrack between them. */
const LEADING_WORD = `(?:(?:${LEADING_FILLER})\\b${LEADING_PUNCTUATION}*|(?!(?:${LEADING_FILLER})\\b)[a-z]+${LEADING_PUNCTUATION}+)\\s+`;

/** "I tried it and ...", "Tried it, ..." or "I just tried it. ..." reports that the assistant's output, which the pronoun stands in for, fails now. */
const TRIED_IT =
  '(?:i )?(?:just )?(?:tried|ran|tested) (?:it|that|this)(?:,?\\s+(?:and|but)|[,.])\\s+';

/**
 * Things the assistant builds, singular or plural. "your proposal", "your solution", "your approach"
 * and "your idea" can name a plan, which is design discussion, so they are left out. After a turn
 * that acted they count anyway, since the rule there doesn't need a reference.
 */
const ASSISTANT_ARTIFACT =
  '(?:fix|patch)(?:es)?|quer(?:y|ies)|(?:change|edit|code|version|implementation|update|commit|refactor|migration|test|script|function)s?';

/** A message that opens on "won't work" with a bare pronoun, a pronoun and something built, or no subject at all ("That won't work", "That fix won't work", "Hmm that definitely won't work, ...", "Nah, won't work —", "I tried it and it won't work"), after up to two leading words, names nothing of its own, so it points at the assistant's previous turn. */
const DEICTIC_WONT_WORK_RE = new RegExp(
  `^(?:${LEADING_WORD}){0,2}(?:${TRIED_IT})?${OPTIONAL_ACTUALLY}(?:(?:(?:that|this|these|those)(?: (?:${ASSISTANT_ARTIFACT}))?|it) (?:(?:still|just|also|even|[a-z]+ly) ){0,2})?won'?t work\\b`,
  'i',
);

/** Words that make what follows hypothetical ("if you added a cache", "suppose we shard", "assuming you cached it"). */
const HYPOTHETICAL = 'if|unless|suppose|supposing|assuming|imagine';

/**
 * A "you" that isn't about the assistant's output: a hypothetical one, an inverted question ("have you
 * tried Redis?"), or one after a remark ("the point you made", but not "at this point you've broken
 * it"). A causal "since you" or a past "when you" is left out: "since you removed the check" and
 * "when you renamed the env var" are about it.
 */
const NOT_ABOUT_OUTPUT_BEFORE_YOU = `(?<!\\b(?:${HYPOTHETICAL}|have|had|(?:argument|suggestion|proposal|plan|idea)s?|(?<!\\b(?:this|that) )points?) )`;

const ADVERB_AFTER_YOU =
  '(?:just|already|also|accidentally|only|then|now|still|again|clearly|probably|actually|never|always|not) ';

/** Stems of verbs that say where an idea came from ("the cache you suggested", "as you explained", "the approach you floated"). */
const IDEA_SOURCE_VERB =
  '(?:(?:suggest|propos|mention|recommend|describ|outlin|offer|explain|warn|note|float|pitch)\\w*|point(?:s|ed|ing)? out)\\b';

/** Stems of verbs that report what the assistant said, thought or planned rather than what it built ("you suggested", "you're proposing", "the way you're thinking", "you're going to need"). Rejecting those is design discussion. */
const IDEA_VERB = `(?:${IDEA_SOURCE_VERB}|(?:ask|think|plan|consider|imagin|list|want|expect|say|talk|mean|agree)\\w*\\b|going\\b)`;

/** A past tense or participle. "-eed" words ("you need", "you proceed") are present tense, so the letter before "ed" can't be "e". */
const PAST_VERB =
  '[a-z]*[a-df-z]ed|wrote|written|rewrote|rewritten|made|did|done|undid|undone|broke|broken|ran|put|set|cast|left|built|kept|sent|split|gave|given|took|taken|forgot|forgotten|hid|hidden';

const YOUR_ARTIFACT = `\\byour (?:last |latest |previous |recent |new )?(?:${ASSISTANT_ARTIFACT})\\b`;
const YOU_PAST = `\\b${NOT_ABOUT_OUTPUT_BEFORE_YOU}you(?:'ve| have)? (?:${ADVERB_AFTER_YOU})?(?!${IDEA_VERB})(?:${PAST_VERB})\\b`;
const YOU_PROGRESSIVE = `\\b${NOT_ABOUT_OUTPUT_BEFORE_YOU}you(?:'re| are) (?:${ADVERB_AFTER_YOU})?(?!${IDEA_VERB})[a-z]+ing\\b`;
const STILL_WONT_WORK = `\\bstill won'?t work\\b`;

/**
 * A reference back to something the assistant built: "your" plus a built artifact, second person plus
 * a past verb ("you wrote", "you've added"), or a repeat failure ("still won't work"). A present-tense
 * or modal "you" ("you need a lock", "you can't hold connections") is as often impersonal, so it
 * doesn't count.
 */
const BUILT_REFERENCE_RE = new RegExp([YOUR_ARTIFACT, YOU_PAST, STILL_WONT_WORK].join('|'), 'i');

/** A built reference, or a present progressive that describes the output as it stands ("you're mutating state"). */
const ASSISTANT_REFERENCE_RE = new RegExp(
  [YOUR_ARTIFACT, YOU_PAST, YOU_PROGRESSIVE, STILL_WONT_WORK].join('|'),
  'i',
);

/**
 * A "you" that names where an idea came from, a determiner plus a word for one ("that idea", "the
 * proposal"), or "your plan". "the plan" and "this option" are left out: a Terraform plan and a CLI
 * option are things the assistant builds.
 */
const IDEA_REFERENCE_RE = new RegExp(
  [
    `\\byou(?:'ve| have|'re| are)? (?:${ADVERB_AFTER_YOU})?${IDEA_SOURCE_VERB}`,
    `\\b(?:your|the|that|this|these|those) (?:idea|proposal|suggestion|recommendation)s?\\b`,
    `\\byour plans?\\b`,
  ].join('|'),
  'i',
);

/** A hypothetical about "you" or "we" ("if you added a cache", "if we do it that way"). Tested only on the text before "won't work": one after it ("that won't work if we deploy to Windows") says when the output fails. */
const HYPOTHETICAL_OPTION_RE = new RegExp(`\\b(?:${HYPOTHETICAL}) (?:you|we)\\b`, 'i');

/** Agreeing with the assistant ("You're right that a cache won't work", "Agreed, that won't work") repeats its own caveat back to it. */
const AGREEMENT_RE = new RegExp(
  `^(?:(?:${LEADING_FILLER})\\b${LEADING_PUNCTUATION}*\\s+)?(?:(?:you'?re|you are) (?:totally |absolutely |completely )?right|agreed|i agree|good (?:point|call)|fair (?:point|enough)|true)\\b`,
  'i',
);

/** Whitespace after sentence-ending punctuation, or a newline. The lookbehind keeps the split linear: a quantified punctuation run followed by a required character backtracks quadratically on a long run of dots. */
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n\s*/;

/** Runs `test` on each sentence that uses "won't work", with the sentences either side of it. */
function someWontWorkSentence(
  text: string,
  test: (sentence: string, before: string, after: string) => boolean,
): boolean {
  const sentences = text.split(SENTENCE_SPLIT_RE);
  return sentences.some(
    (sentence, i) =>
      WONT_WORK_RE.test(sentence) && test(sentence, sentences[i - 1] ?? '', sentences[i + 1] ?? ''),
  );
}

/**
 * After a turn that changed something, "won't work" rejects what it changed, unless the sentence
 * frames an option as hypothetical, agrees with the assistant, or names an idea the assistant
 * proposed rather than built.
 */
function rejectsActionOutput(sentence: string, before: string): boolean {
  const lead = sentence.slice(0, sentence.search(WONT_WORK_RE));
  return (
    !HYPOTHETICAL_OPTION_RE.test(lead) &&
    !AGREEMENT_RE.test(sentence) &&
    !AGREEMENT_RE.test(before) &&
    !IDEA_REFERENCE_RE.test(sentence)
  );
}

/**
 * Whether "won't work" in `text` rejects something the assistant built or did, given its previous turn.
 *
 * - `acted`: it rejects what the turn changed, with the exceptions in `rejectsActionOutput`.
 * - `talked`: the turn only answered or proposed, so "won't work" rejects an option or states a
 *   constraint unless the sentence, or one either side, points back at something built earlier
 *   ("the migration you wrote still won't work"). A present progressive doesn't count here: after a
 *   proposal, "you're assuming a sorted list" describes the proposal as often as the code.
 * - `unknown`: the text decides alone. The message counts when it opens on "won't work" with a bare
 *   pronoun or no subject, or when a "won't work" sentence, or one either side, points back at the
 *   assistant's output.
 */
function hasWontWorkCorrection(text: string, state: AssistantTurnState): boolean {
  if (!WONT_WORK_RE.test(text)) return false;
  switch (state) {
    case 'acted':
      return someWontWorkSentence(text, (sentence, before) =>
        rejectsActionOutput(sentence, before),
      );
    case 'talked':
      return someWontWorkSentence(text, (...nearby) =>
        nearby.some((s) => BUILT_REFERENCE_RE.test(s)),
      );
    case 'unknown':
      return (
        DEICTIC_WONT_WORK_RE.test(text) ||
        someWontWorkSentence(text, (...nearby) =>
          nearby.some((s) => ASSISTANT_REFERENCE_RE.test(s)),
        )
      );
  }
}

/** A curly apostrophe (U+2019), as macOS and phone keyboards type it, reads like a straight one in every pattern above. */
function normalizeApostrophes(text: string): string {
  return text.replace(/\u2019/g, "'");
}

function isCorrectionMessage(rawText: string, state: AssistantTurnState): boolean {
  const text = normalizeApostrophes(rawText);
  return (
    LEADING_NO_RE.test(text) ||
    BARE_REJECTION_RE.test(text) ||
    EXPLICIT_REJECTION_RE.test(text) ||
    LEADING_INTERJECTION_RE.test(text) ||
    TARGETED_UNDO_RE.test(text) ||
    EMBEDDED_CORRECTION_RE.test(text) ||
    hasWontWorkCorrection(text, state)
  );
}

/**
 * Tools whose call is something the assistant did that the user can reject.
 * - Edit, Write, MultiEdit and NotebookEdit change files.
 * - Task, and Agent as it is now named, hands work to a subagent, which often edits files. The
 *   subagent's own entries are sidechains, which this tracker skips, so the spawn is the only trace
 *   in the turn of what it did.
 * - Bash runs a command, which `isMutatingToolUse` reads as talking when every command in it only
 *   reads (`isReadOnlyCommand`). A command is output the user corrects too ("the command you ran
 *   won't work in CI"), so any other, such as `npm test` or `cd src && ls`, acts.
 * Every other tool counts as talking: Read, Grep, Glob, WebFetch and WebSearch look things up and
 * TodoWrite tracks the plan. That includes MCP tools, since the name alone doesn't say whether one
 * changed anything.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Task',
  'Agent',
]);

/** Commands that only read, apart from the arguments in `WRITING_ARGS`. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'grep',
  'rg',
  'find',
]);

/** The `find` actions that delete, run a command or write a file, and `rg --pre`, which runs one. */
const WRITING_ARGS: ReadonlyMap<string, RegExp> = new Map([
  ['find', /(?:^|[\s"'=])-(?:delete|exec|ok|fprint|fls)/],
  ['rg', /(?:^|[\s"'=])--pre\b/],
]);

/** git subcommands that only read, unless given `--output`, which writes a file. */
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'log', 'diff', 'show']);

/** Arguments that keep `git branch` listing branches. Any other creates, renames or deletes one. */
const GIT_BRANCH_LIST_ARGS: ReadonlySet<string> = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--all',
  '--remotes',
  '--verbose',
  '--list',
  '--show-current',
]);

/** A redirection, a process or command substitution, or a heredoc, anywhere in the command, quoted or not. */
const REDIRECT_OR_SUBSTITUTION_RE = /[<>`]|\$\(/;

/** Whether a git command's arguments, after `git`, only read. `--no-pager` and `-C <dir>` may lead. */
function gitOnlyReads(args: readonly string[]): boolean {
  let i = 0;
  while (args[i] === '--no-pager' || args[i] === '-C') i += args[i] === '-C' ? 2 : 1;
  const [subcommand = '', ...rest] = args.slice(i);
  if (subcommand === 'branch') return rest.every((arg) => GIT_BRANCH_LIST_ARGS.has(arg));
  return GIT_READ_SUBCOMMANDS.has(subcommand) && !rest.some((arg) => arg.startsWith('--output'));
}

/** Whether one command of a shell chain only reads. A quoted or prefixed command name isn't recognised. */
function commandOnlyReads(command: string): boolean {
  const [name = '', ...args] = command.split(/\s+/);
  if (name === 'git') return gitOnlyReads(args);
  return READ_ONLY_COMMANDS.has(name) && WRITING_ARGS.get(name)?.test(command) !== true;
}

/**
 * Whether a Bash `command` only reads: every command in the chain is in `READ_ONLY_COMMANDS` or is
 * a reading git command, with no redirection or substitution anywhere. Anything this can't read,
 * including quotes that don't balance, counts as writing.
 */
function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== 'string' || REDIRECT_OR_SUBSTITUTION_RE.test(command)) return false;
  const chain = splitShellChain(command);
  const commands = chain.segments.map((segment) => segment.trim()).filter((s) => s.length > 0);
  return chain.quotesBalanced && commands.length > 0 && commands.every(commandOnlyReads);
}

interface ToolUse {
  readonly name: string;
  readonly input: unknown;
}

/** Whether a tool call is something the assistant did that the user can reject (`MUTATING_TOOLS`). */
function isMutatingToolUse({ name, input }: ToolUse): boolean {
  if (name === 'Bash') {
    const command =
      typeof input === 'object' && input !== null
        ? (input as { command?: unknown }).command
        : undefined;
    return !isReadOnlyCommand(command);
  }
  return MUTATING_TOOLS.has(name);
}

/** The `tool_use` blocks in an assistant entry's `message.content`. */
function toolUses(message: unknown): ToolUse[] {
  if (message === null || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null) return [];
    const { type, name, input } = block as { type?: unknown; name?: unknown; input?: unknown };
    return type === 'tool_use' && typeof name === 'string' ? [{ name, input }] : [];
  });
}

/** A content block carrying a `text` field — narrows before reading `.text`. */
function hasStringText(block: unknown): block is { text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    'text' in block &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

/**
 * `message.content` is either a plain string, or an array of content blocks
 * (e.g. an attachment/paste) where the first block may carry `.text`. Returns
 * null when there's no text to classify.
 */
function getEffectiveText(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length > 0 && hasStringText(content[0])) {
    return content[0].text;
  }
  return null;
}

function isSyntheticText(text: string): boolean {
  return SYNTHETIC_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** The text Claude Code writes as a user entry when the user presses Esc, with " for tool use]" after it when a tool call was rejected. */
const INTERRUPT_MARKER = '[Request interrupted by user';

/** A tool result echoed back as a user entry: by the field Claude Code sets, or by its content block when the field is missing. */
function isToolResult(entry: RawTranscriptEntry): boolean {
  if (entry.toolUseResult !== undefined) return true;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result',
    )
  );
}

/**
 * Whether a user entry ends the assistant's turn, so the next message is read against what the
 * assistant does after it. An entry can end the turn with no text to count, and have text to count
 * without ending it.
 *
 * - The user writing something ends it, even when the entry opens on a pasted image. So does an entry
 *   marked `origin.kind: 'human'` that opens on a `SYNTHETIC_TEXT_PREFIXES` prefix: Claude Code marks
 *   a typed message with a system reminder in front of it that way, and a prompt-style slash command
 *   the assistant then answers.
 * - An interrupt doesn't. The user pressed Esc on what the assistant was doing, so their next message
 *   reacts to that.
 * - A compaction summary doesn't. Claude Code writes it, mid-turn when compaction is automatic, and it
 *   changes nothing the assistant did.
 * - A task notification doesn't. It reports a background task the assistant started, and what the
 *   assistant does about it adds to the turn the user hasn't answered yet.
 * - Any other entry that opens on a `SYNTHETIC_TEXT_PREFIXES` prefix doesn't. Most are the harness
 *   reporting something: a reminder, a notification, another session's message, a command's output.
 *   The rest echo a local slash command such as /model or /compact, which the assistant doesn't
 *   answer, so the user's next message still answers its last turn.
 * - A sidechain, meta or tool-result entry is part of the assistant's own work.
 */
function endsAssistantTurn(entry: RawTranscriptEntry): boolean {
  if (entry.isSidechain === true || entry.isMeta === true || isToolResult(entry)) return false;
  const text = getEffectiveText(entry.message);
  if (text !== null && text.startsWith(INTERRUPT_MARKER)) return false;
  if (entry.origin?.kind === 'human') return true;
  if (entry.isCompactSummary === true || entry.origin?.kind === 'task-notification') return false;
  return text === null || !isSyntheticText(text);
}

/** Returns the entry's real message text, or null if it isn't a real human-typed message. */
function classifyUserEntry(entry: RawTranscriptEntry): string | null {
  if (entry.isSidechain === true) return null;
  if (entry.toolUseResult !== undefined) return null;
  if (entry.isMeta === true) return null;
  if (entry.isCompactSummary === true) return null;
  if (entry.origin?.kind === 'task-notification') return null;

  const text = getEffectiveText(entry.message);
  if (text === null || isSyntheticText(text)) return null;
  return text;
}

// ---------------------------------------------------------------------------
// TranscriptMessageTracker
// ---------------------------------------------------------------------------

/** Cap on bytes read per refresh() call — bounds worst-case disk I/O per checkpoint. */
const READ_CAP_BYTES = 1_048_576; // 1 MB

export class TranscriptMessageTracker {
  private transcriptPath: string | null = null;
  private offset = 0;
  private skippingOversizedLine = false;
  private userMessages = 0;
  private assistantMessages = 0;
  private userCorrections = 0;
  /** What the assistant's entries did since the last user entry that ended its turn. */
  private assistantSinceUser: 'none' | 'talked' | 'acted' = 'none';
  /** Whether the transcript has shown a tool call yet, so a turn without one can be read as talking. */
  private seenToolUse = false;

  /** Cheap; captures the first non-empty path seen and ignores later calls. No I/O. */
  observeTranscriptPath(path: string | undefined): void {
    if (this.transcriptPath === null && typeof path === 'string' && path.length > 0) {
      this.transcriptPath = path;
    }
  }

  /** Incrementally reads and classifies any transcript growth since the last call. */
  refresh(): void {
    if (this.transcriptPath === null) return;

    let size: number;
    try {
      size = statSync(this.transcriptPath).size;
    } catch {
      return;
    }

    if (size < this.offset) {
      // File was rotated/truncated — restart from the beginning, with no turn carried over from
      // the old file.
      this.offset = 0;
      this.skippingOversizedLine = false;
      this.assistantSinceUser = 'none';
      this.seenToolUse = false;
    }
    if (size <= this.offset) return;

    const readSize = Math.min(size - this.offset, READ_CAP_BYTES);
    let fd: number;
    try {
      fd = openSync(this.transcriptPath, fsConstants.O_RDONLY);
    } catch {
      return;
    }

    try {
      const buffer = Buffer.alloc(readSize);
      const bytesRead = readSync(fd, buffer, 0, readSize, this.offset);
      const chunk = buffer.toString('utf-8', 0, bytesRead);

      if (this.skippingOversizedLine) {
        const lineEnd = chunk.indexOf('\n');
        if (lineEnd === -1) {
          // Still inside the oversized line — discard this chunk and keep skipping.
          this.offset += Buffer.byteLength(chunk, 'utf-8');
          return;
        }
        // Found the end of the oversized line — resume normal reads after it.
        this.offset += Buffer.byteLength(chunk.slice(0, lineEnd + 1), 'utf-8');
        this.skippingOversizedLine = false;
        return;
      }

      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline === -1) {
        if (readSize === READ_CAP_BYTES) {
          // A full read-cap's worth of data with no newline means the current
          // line is at least READ_CAP_BYTES long — discard it and skip past it
          // incrementally rather than stalling forever waiting for its end.
          this.offset += Buffer.byteLength(chunk, 'utf-8');
          this.skippingOversizedLine = true;
        }
        return; // No complete line yet — wait for more data.
      }

      const completeChunk = chunk.slice(0, lastNewline + 1);
      for (const line of completeChunk.split('\n')) {
        if (line.length > 0) this.processLine(line);
      }
      this.offset += Buffer.byteLength(completeChunk, 'utf-8');
    } catch {
      // Best-effort — leave offset unchanged so the next refresh() retries.
    } finally {
      closeSync(fd);
    }
  }

  private processLine(line: string): void {
    let entry: RawTranscriptEntry;
    try {
      entry = JSON.parse(line) as RawTranscriptEntry;
    } catch {
      return;
    }

    if (entry.type === 'user') {
      const text = classifyUserEntry(entry);
      if (text !== null) {
        this.userMessages++;
        if (isCorrectionMessage(text.trim(), this.turnState())) {
          this.userCorrections++;
        }
      }
      if (endsAssistantTurn(entry)) this.assistantSinceUser = 'none';
    } else if (entry.type === 'assistant') {
      if (isRealAssistantTurn(entry)) {
        this.assistantMessages++;
        const tools = toolUses(entry.message);
        if (tools.length > 0) this.seenToolUse = true;
        if (tools.some(isMutatingToolUse)) {
          this.assistantSinceUser = 'acted';
        } else if (this.assistantSinceUser === 'none') {
          this.assistantSinceUser = 'talked';
        }
      }
    }
  }

  private turnState(): AssistantTurnState {
    if (this.assistantSinceUser === 'acted') return 'acted';
    if (this.assistantSinceUser === 'talked' && this.seenToolUse) return 'talked';
    return 'unknown';
  }

  getMetrics(): TranscriptMessageMetrics {
    return {
      userMessages: this.userMessages,
      assistantMessages: this.assistantMessages,
      userCorrections: this.userCorrections,
    };
  }

  reset(): void {
    this.transcriptPath = null;
    this.offset = 0;
    this.skippingOversizedLine = false;
    this.userMessages = 0;
    this.assistantMessages = 0;
    this.userCorrections = 0;
    this.assistantSinceUser = 'none';
    this.seenToolUse = false;
  }
}
