import { closeSync, openSync, readSync, statSync, constants as fsConstants } from 'node:fs';

import { redactSensitive } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Duplicated from src/hooks/collector-script.ts's TRANSCRIPT_TAIL_BYTES --
// intentional, matching that file's own precedent of duplicating small
// platform-specific constants rather than importing across the
// collector-script/server boundary.
const TRANSCRIPT_TAIL_BYTES = 16_384;

// Safety cap on how far back a single logical turn's content blocks can
// span, guarding against malformed data producing an unbounded walk.
const MAX_GROUP_WALK_BACK_LINES = 20;

const WINDOWS_DRIVE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranscriptContentBlock {
  readonly type?: string;
  readonly id?: string;
  readonly text?: string;
  readonly thinking?: string;
}

interface TranscriptLine {
  readonly type?: string;
  readonly message?: {
    readonly id?: string;
    readonly content?: readonly TranscriptContentBlock[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Duplicated from src/hooks/collector-script.ts's translateWslPath -- same
// WSL-path-fixup precedent, needed because this module tail-reads the same
// transcript file independently of the collector.
function translateWslPath(path: string): string {
  if (process.platform !== 'linux') return path;
  const match = WINDOWS_DRIVE_PATH_RE.exec(path);
  if (!match) return path;
  const [, drive, rest] = match;
  return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
}

function parseTranscriptLine(line: string): TranscriptLine | null {
  try {
    return JSON.parse(line) as TranscriptLine;
  } catch {
    return null;
  }
}

function readTranscriptTail(transcriptPath: string): string[] {
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return [];

    const fd = openSync(transcriptPath, fsConstants.O_RDONLY);
    try {
      const readSize = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(readSize);
      const bytesRead = readSync(fd, buffer, 0, readSize, stat.size - readSize);
      return buffer.toString('utf-8', 0, bytesRead).split('\n').filter(Boolean);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Finds the model's own reasoning (thinking text, falling back to visible
 * text) for the turn that produced a given tool_use block. Returns null on
 * any miss -- id not found in the tail window, file gone, malformed JSON --
 * never throws. Callers must gate on `recordContent` themselves; this
 * function always attempts the read.
 */
export function extractReasoningForToolUse(
  transcriptPath: string,
  toolUseId: string,
): string | null {
  const lines = readTranscriptTail(translateWslPath(transcriptPath));
  if (lines.length === 0) return null;

  let targetLine = -1;
  let groupId: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseTranscriptLine(lines[i]!);
    if (!entry || entry.type !== 'assistant' || !entry.message?.content) continue;
    const matched = entry.message.content.some(
      (block) => block.type === 'tool_use' && block.id === toolUseId,
    );
    if (matched) {
      targetLine = i;
      groupId = entry.message.id;
      break;
    }
  }

  if (targetLine === -1 || !groupId) return null;

  const thinkingParts: string[] = [];
  const textParts: string[] = [];

  for (let i = targetLine, steps = 0; i >= 0 && steps < MAX_GROUP_WALK_BACK_LINES; i--, steps++) {
    const entry = parseTranscriptLine(lines[i]!);
    if (!entry) continue; // skip malformed/partial lines silently
    if (entry.type !== 'assistant' || entry.message?.id !== groupId) break;
    for (const block of entry.message?.content ?? []) {
      if (block.type === 'thinking' && block.thinking) {
        thinkingParts.unshift(block.thinking);
      } else if (block.type === 'text' && block.text) {
        textParts.unshift(block.text);
      }
    }
  }

  const reasoning = thinkingParts.join('\n').trim() || textParts.join('\n').trim();
  return reasoning.length > 0 ? redactSensitive(reasoning) : null;
}
