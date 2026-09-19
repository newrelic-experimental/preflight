import { openSync, closeSync, readSync, statSync, constants as fsConstants } from 'node:fs';

import { isRealAssistantTurn } from '../lib/subagent-transcript-parser.js';

import type { RawTranscriptEntry } from '../lib/transcript-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptMessageMetrics {
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly userCorrections: number;
}

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

/** Correction phrasing that doesn't require a trigger word at the start of the message. `won't work` is handled by `isWontWorkCorrection` so forward-looking design talk is not counted. */
const EMBEDDED_CORRECTION_RE =
  /\b(you (missed|forgot|broke)|that'?s (not (right|correct|what)|wrong|incorrect)|not what (i|you)'?d? (meant|asked|wanted|said)|this is the (\d+|second|third|fourth|fifth|\w+th) time)\b/i;

/** The phrase itself — intended to mean "your prior output doesn't work". */
const WONT_WORK_RE = /\bwon'?t work\b/i;

/** Causal / completed-action cues: the user is explaining why prior output failed. Always win. */
const WONT_WORK_COMPLETED_CUE_RE = /\b(because|since)\b/i;

/**
 * Planning / alternative-proposal cues. Alone they do not veto a match ("That
 * won't work, let's try again" is still a correction). They only veto when
 * they dominate a constraint-framed `won't work for …` clause.
 */
const WONT_WORK_FORWARD_CUE_RE = /\b(let'?s|we should|instead)\b/i;

/** `won't work for X` frames a future constraint, not "your last output failed". */
const WONT_WORK_CONSTRAINT_RE = /\bwon'?t work\b\s+for\b/i;

/**
 * `won't work` is a correction when it rejects prior output, but the same
 * phrase is also used in forward-looking design talk.
 *
 * Chosen rule (#677): count it as a correction unless it is constraint-framed
 * (`won't work for …`) *and* a forward-looking planning cue (`let's` /
 * `we should` / `instead`) is present, with no causal cue (`because` /
 * `since`). Causal cues always win so "That approach won't work because
 * there's a race condition." still matches. Bare "That won't work." still
 * matches to keep recall.
 *
 * Residual FP accepted: constraint-framed `won't work for …` without a
 * planning cue still counts. Residual FN accepted: a genuine correction that
 * uses both `won't work for` and a planning cue without `because`/`since` is
 * dropped (same shape as the issue's negative example). The regex is not
 * widened to chase those leftovers.
 */
function isWontWorkCorrection(text: string): boolean {
  if (!WONT_WORK_RE.test(text)) return false;
  if (WONT_WORK_COMPLETED_CUE_RE.test(text)) return true;
  if (WONT_WORK_CONSTRAINT_RE.test(text) && WONT_WORK_FORWARD_CUE_RE.test(text)) {
    return false;
  }
  return true;
}

function isCorrectionMessage(text: string): boolean {
  return (
    LEADING_NO_RE.test(text) ||
    BARE_REJECTION_RE.test(text) ||
    EXPLICIT_REJECTION_RE.test(text) ||
    LEADING_INTERJECTION_RE.test(text) ||
    TARGETED_UNDO_RE.test(text) ||
    isWontWorkCorrection(text) ||
    EMBEDDED_CORRECTION_RE.test(text)
  );
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
      // File was rotated/truncated — restart from the beginning.
      this.offset = 0;
      this.skippingOversizedLine = false;
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
        if (isCorrectionMessage(text.trim())) {
          this.userCorrections++;
        }
      }
    } else if (entry.type === 'assistant') {
      if (isRealAssistantTurn(entry)) {
        this.assistantMessages++;
      }
    }
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
  }
}
