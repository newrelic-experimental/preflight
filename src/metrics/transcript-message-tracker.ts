import { openSync, closeSync, readSync, statSync, constants as fsConstants } from 'node:fs';

import type { RawTranscriptEntry, RawAssistantMessage } from '../hooks/transcript-types.js';

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

const CORRECTION_RE =
  /^(no|nope|not\b|stop|don't|wrong|incorrect|actually|that's not|that's wrong|undo|revert)\b/i;

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

function isRealAssistantEntry(entry: RawTranscriptEntry): boolean {
  if (entry.isSidechain === true) return false;
  const message = entry.message as RawAssistantMessage | undefined;
  return message?.model !== '<synthetic>';
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
        if (CORRECTION_RE.test(text.trim())) {
          this.userCorrections++;
        }
      }
    } else if (entry.type === 'assistant') {
      if (isRealAssistantEntry(entry)) {
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
