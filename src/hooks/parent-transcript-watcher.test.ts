import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ParentTranscriptWatcher,
  buildParentTranscriptCursorPath,
} from './parent-transcript-watcher.js';
import { LocalStore } from '../storage/local-store.js';

const STDERR_WRITE = process.stderr.write;

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'parent-transcript-watcher-test-'));
}

function makeAssistantLine(opts: {
  messageId?: string;
  timestamp?: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  isSidechain?: boolean;
  /** Pad the line with a string of this many bytes, for byte-boundary tests. */
  padBytes?: number;
}): string {
  const usage: Record<string, unknown> = {
    input_tokens: opts.inputTokens ?? 100,
    output_tokens: opts.outputTokens ?? 50,
    cache_read_input_tokens: opts.cacheRead ?? 1000,
    cache_creation_input_tokens: opts.cacheCreation ?? 200,
  };
  const content: Array<Record<string, unknown>> = [{ type: 'text' }];
  if (opts.padBytes && opts.padBytes > 0) {
    content.push({ type: 'text', text: 'a'.repeat(opts.padBytes) });
  }
  const message: Record<string, unknown> = {
    id: opts.messageId ?? 'msg_1',
    role: 'assistant',
    content,
    usage,
  };
  if (opts.model !== null) {
    message.model = opts.model ?? 'claude-opus-4-7';
  }
  return JSON.stringify({
    type: 'assistant',
    uuid: 'turn-uuid-1',
    timestamp: opts.timestamp ?? '2026-06-15T12:00:00.000Z',
    isSidechain: opts.isSidechain ?? false,
    message,
  });
}

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('ParentTranscriptWatcher', () => {
  let storagePath: string;
  let projectsDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    storagePath = mkTmp();
    projectsDir = mkTmp();
    transcriptPath = join(projectsDir, 'project-slug', `${SESSION_ID}.jsonl`);
    mkdirSync(join(projectsDir, 'project-slug'), { recursive: true });
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function readTokenEvents(): Record<string, unknown>[] {
    const bufPath = join(storagePath, `buffer-${SESSION_ID}.jsonl`);
    if (!existsSync(bufPath)) return [];
    return readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'token');
  }

  it('emits a token line for each assistant turn', () => {
    writeFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mode: 'token',
      sessionId: SESSION_ID,
      messageId: 'msg_1',
      model: 'claude-opus-4-7',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
    });
  });

  it('does not re-emit on a second poll with no new data', () => {
    writeFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(1);
  });

  it('emits new lines that arrive after the cursor', () => {
    writeFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    appendFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_2' }) + '\n');
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.messageId).toBe('msg_2');
  });

  it('REGRESSION: dedupes one sessionId across two project dirs, reading only the newest copy', () => {
    // Repo-rename scenario: Claude Code creates a new project-slug dir when a
    // repo moves, leaving the old dir's <sessionId>.jsonl behind with divergent
    // content. The byte cursor is keyed by sessionId alone, so reading BOTH
    // copies applies one file's offset to the other's unrelated bytes and
    // double-counts token/cost totals. Unfiltered (--local) discovery must keep
    // only the newest-mtime (active) copy.
    const dirOld = join(projectsDir, 'project-old-slug');
    const dirNew = join(projectsDir, 'project-new-slug');
    mkdirSync(dirOld, { recursive: true });
    mkdirSync(dirNew, { recursive: true });
    const fileOld = join(dirOld, `${SESSION_ID}.jsonl`);
    const fileNew = join(dirNew, `${SESSION_ID}.jsonl`);
    writeFileSync(fileOld, makeAssistantLine({ messageId: 'msg_STALE', inputTokens: 9 }) + '\n');
    writeFileSync(fileNew, makeAssistantLine({ messageId: 'msg_ACTIVE', inputTokens: 111 }) + '\n');
    // Force the "new" slug's copy to be strictly newer than the stale one.
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(fileOld, older, older);
    utimesSync(fileNew, newer, newer);

    // Unfiltered mode (no parentSessionId) — the --local dashboard path.
    const watcher = new ParentTranscriptWatcher({ storagePath, projectsDir });
    watcher.poll();
    const events = readTokenEvents();
    // Exactly one turn, from the active copy — the stale copy is never read.
    expect(events).toHaveLength(1);
    expect(events[0]!.messageId).toBe('msg_ACTIVE');
    expect(events[0]!.inputTokens).toBe(111);
  });

  it('REGRESSION: resets the sessionId-keyed cursor when the canonical copy switches project dirs mid-stream', () => {
    // Poll 1 tails a LARGE transcript under the old slug (cursor advances to a
    // large bytePos, path=old). A repo rename then makes a SMALLER transcript
    // under a new slug the newest copy. Without a path-aware cursor reset, the
    // stale large bytePos is >= the new file's size, so processFile early-returns
    // (`startCursor.bytePos >= size`) and silently drops ALL post-rename turns.
    const dirOld = join(projectsDir, 'project-old-slug');
    const dirNew = join(projectsDir, 'project-new-slug');
    mkdirSync(dirOld, { recursive: true });
    mkdirSync(dirNew, { recursive: true });
    const fileOld = join(dirOld, `${SESSION_ID}.jsonl`);
    const fileNew = join(dirNew, `${SESSION_ID}.jsonl`);

    // Old copy is large (padded) so its cursor bytePos exceeds the new copy's size.
    writeFileSync(fileOld, makeAssistantLine({ messageId: 'msg_OLD', padBytes: 4096 }) + '\n');
    const t0 = new Date(Date.now() - 60_000);
    utimesSync(fileOld, t0, t0);

    const watcher = new ParentTranscriptWatcher({ storagePath, projectsDir });
    watcher.poll();
    expect(readTokenEvents().map((e) => e.messageId)).toEqual(['msg_OLD']);

    // Rename: new slug's copy is small and strictly newer.
    writeFileSync(fileNew, makeAssistantLine({ messageId: 'msg_AFTER_RENAME' }) + '\n');
    const t1 = new Date();
    utimesSync(fileNew, t1, t1);

    watcher.poll();
    const ids = readTokenEvents().map((e) => e.messageId);
    // The post-rename turn is captured (cursor reset to 0 for the new file),
    // not dropped by a stale large offset.
    expect(ids).toContain('msg_AFTER_RENAME');
  });

  it('REGRESSION: captures every turn in a tool-call / text-only / tool-call sequence, not just the last', () => {
    // This is the exact bug this watcher replaces: the old hook-triggered
    // scanner only ever captured the single most recent assistant turn at
    // the moment a tool-call hook fired, silently dropping any turn that
    // produced no tool call (like the middle one here) if it was superseded
    // before the next hook fired. This watcher has no concept of "tool call
    // adjacency" at all — it must capture every turn regardless.
    writeFileSync(
      transcriptPath,
      [
        makeAssistantLine({ messageId: 'msg_toolcall_1', outputTokens: 20 }),
        makeAssistantLine({ messageId: 'msg_textonly', outputTokens: 8888 }),
        makeAssistantLine({ messageId: 'msg_toolcall_2', outputTokens: 60 }),
      ].join('\n') + '\n',
    );
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events.map((e) => e.messageId)).toEqual([
      'msg_toolcall_1',
      'msg_textonly',
      'msg_toolcall_2',
    ]);
  });

  it('skips isSidechain entries (subagent turns inlined into the main transcript)', () => {
    writeFileSync(
      transcriptPath,
      [
        makeAssistantLine({ messageId: 'msg_subagent', isSidechain: true }),
        makeAssistantLine({ messageId: 'msg_real', isSidechain: false }),
      ].join('\n') + '\n',
    );
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.messageId).toBe('msg_real');
  });

  it('skips synthetic model entries', () => {
    writeFileSync(
      transcriptPath,
      [
        makeAssistantLine({ messageId: 'msg_synth', model: '<synthetic>' }),
        makeAssistantLine({ messageId: 'msg_real' }),
      ].join('\n') + '\n',
    );
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.messageId).toBe('msg_real');
  });

  it('skips entries with no model field', () => {
    writeFileSync(
      transcriptPath,
      [
        makeAssistantLine({ messageId: 'msg_nomodel', model: null }),
        makeAssistantLine({ messageId: 'msg_real' }),
      ].join('\n') + '\n',
    );
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.messageId).toBe('msg_real');
  });

  it('skips entries with no message.id (cannot dedupe)', () => {
    const noId = JSON.stringify({
      type: 'assistant',
      uuid: 'turn-uuid-x',
      timestamp: '2026-06-15T12:00:00.000Z',
      isSidechain: false,
      message: {
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [{ type: 'text' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    writeFileSync(
      transcriptPath,
      [noId, makeAssistantLine({ messageId: 'msg_real' })].join('\n') + '\n',
    );
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.messageId).toBe('msg_real');
  });

  it('increments parseErrors and does not throw on a malformed JSON line', () => {
    writeFileSync(
      transcriptPath,
      ['not valid json {{{', makeAssistantLine({ messageId: 'msg_real' })].join('\n') + '\n',
    );
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    expect(() => watcher.poll()).not.toThrow();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(watcher.getHealthStats().parseErrors).toBeGreaterThan(0);
  });

  it('resumes from a saved cursor on restart (cursor durability)', () => {
    writeFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_first' }) + '\n');
    const watcher1 = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher1.poll();

    const cursorPath = buildParentTranscriptCursorPath(storagePath, SESSION_ID);
    expect(existsSync(cursorPath)).toBe(true);
    const cursorState = JSON.parse(readFileSync(cursorPath, 'utf-8'));
    expect(cursorState.bytePos).toBeGreaterThan(0);

    appendFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_second' }) + '\n');

    // A freshly constructed instance sharing the same storagePath must resume
    // from the persisted cursor, not re-emit msg_first.
    const watcher2 = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher2.poll();

    const events = readTokenEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.messageId).toBe('msg_first');
    expect(events[1]!.messageId).toBe('msg_second');
  });

  it('finds the transcript regardless of the project-dir name (worktree safety — no cwd derivation)', () => {
    // A worktree's cwd-derived dashed dir name would never match this
    // arbitrarily-named project dir; scoped discovery must not depend on it.
    const oddProjectDir = join(projectsDir, 'totally-unrelated-worktree-dir-name');
    mkdirSync(oddProjectDir, { recursive: true });
    const oddTranscriptPath = join(oddProjectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(oddTranscriptPath, makeAssistantLine({ messageId: 'msg_1' }) + '\n');

    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    // Both the original (empty) project-slug dir's absence of a transcript
    // and the odd dir's presence of one are exercised; only the latter exists.
    expect(readTokenEvents()).toHaveLength(1);
  });

  it('does not emit for a line with no trailing newline yet (partial line held over)', () => {
    const line = makeAssistantLine({ messageId: 'msg_partial' });
    writeFileSync(transcriptPath, line); // no trailing \n
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(0);

    appendFileSync(transcriptPath, '\n');
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(1);
  });

  describe('unfiltered discovery (--local mode, no parentSessionId)', () => {
    it('discovers every session transcript when no parentSessionId filter is set', () => {
      writeFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
      const watcher = new ParentTranscriptWatcher({ storagePath, projectsDir });
      watcher.poll();
      expect(readTokenEvents()).toHaveLength(1);
    });

    it("skips a session whose --stdio owner is alive, so it doesn't race that session's own scoped watcher over the same cursor file", () => {
      writeFileSync(transcriptPath, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
      writeFileSync(join(storagePath, `active-${SESSION_ID}.pid`), String(process.pid));

      const watcher = new ParentTranscriptWatcher({
        storagePath,
        projectsDir,
        localStore: new LocalStore(storagePath),
      });
      watcher.poll();

      expect(readTokenEvents()).toHaveLength(0);
    });
  });
});
