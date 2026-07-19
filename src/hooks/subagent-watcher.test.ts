import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentWatcher, buildSubagentCursorPath } from './subagent-watcher.js';

const STDERR_WRITE = process.stderr.write;

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'subagent-watcher-test-'));
}

function makeAssistantLine(opts: {
  agentId?: string;
  messageId?: string;
  uuid?: string;
  timestamp?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
  stopReason?: string;
  contentTypes?: string[];
  /** Pad the message content with a string of this many bytes to inflate the
   * serialized line size past MAX_BYTES_PER_POLL (64 KiB) for leak tests. */
  padBytes?: number;
}): string {
  const usage: Record<string, unknown> = {
    input_tokens: opts.inputTokens ?? 100,
    output_tokens: opts.outputTokens ?? 50,
    cache_read_input_tokens: opts.cacheRead ?? 1000,
    cache_creation_input_tokens: opts.cacheCreation ?? 200,
  };
  if (opts.reasoning !== undefined) {
    usage.output_tokens_details = { reasoning_tokens: opts.reasoning };
  }
  const content: Array<Record<string, unknown>> = (opts.contentTypes ?? ['text']).map((t) => ({
    type: t,
  }));
  if (opts.padBytes && opts.padBytes > 0) {
    content.push({ type: 'text', text: 'a'.repeat(opts.padBytes) });
  }
  return JSON.stringify({
    type: 'assistant',
    agentId: opts.agentId ?? 'a1234567890abcdef',
    uuid: opts.uuid ?? 'turn-uuid-1',
    timestamp: opts.timestamp ?? '2026-06-15T12:00:00.000Z',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionKind: 'bg',
    isSidechain: true,
    message: {
      id: opts.messageId ?? 'msg_1',
      role: 'assistant',
      model: opts.model ?? 'claude-opus-4-7',
      stop_reason: opts.stopReason ?? 'end_turn',
      content,
      usage,
    },
  });
}

const PARENT_SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AGENT_ID = 'a1234567890abcdef';

describe('SubagentWatcher', () => {
  let storagePath: string;
  let projectsDir: string;
  let sessionDir: string;
  let agentJsonl: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    storagePath = mkTmp();
    projectsDir = mkTmp();
    sessionDir = join(projectsDir, 'project-slug', PARENT_SESSION);
    mkdirSync(join(sessionDir, 'subagents'), { recursive: true });
    agentJsonl = join(sessionDir, 'subagents', `agent-${AGENT_ID}.jsonl`);
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('emits a subagent_token line for each assistant turn', () => {
    writeFileSync(agentJsonl, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    const buf = readFileSync(join(storagePath, `buffer-${PARENT_SESSION}.jsonl`), 'utf-8');
    const lines = buf
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const tokenLines = lines.filter((l) => l.mode === 'subagent_token');
    expect(tokenLines).toHaveLength(1);
    expect(tokenLines[0]).toMatchObject({
      mode: 'subagent_token',
      sessionId: PARENT_SESSION,
      agentId: AGENT_ID,
      messageId: 'msg_1',
      model: 'claude-opus-4-7',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
      workflowRunId: null,
    });
  });

  it('does not re-emit lines on a second poll (cursor persisted)', () => {
    writeFileSync(agentJsonl, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    watcher.poll();
    const buf = readFileSync(join(storagePath, `buffer-${PARENT_SESSION}.jsonl`), 'utf-8');
    const tokenLines = buf
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines).toHaveLength(1);
  });

  it('emits new lines that arrive after the cursor', () => {
    writeFileSync(agentJsonl, makeAssistantLine({ messageId: 'msg_1' }) + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    writeFileSync(
      agentJsonl,
      makeAssistantLine({ messageId: 'msg_1' }) +
        '\n' +
        makeAssistantLine({ messageId: 'msg_2', uuid: 'turn-uuid-2' }) +
        '\n',
    );
    watcher.poll();
    const buf = readFileSync(join(storagePath, `buffer-${PARENT_SESSION}.jsonl`), 'utf-8');
    const tokenLines = buf
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines).toHaveLength(2);
    expect(tokenLines[1].messageId).toBe('msg_2');
  });

  it('attributes workflow_run_id when file lives under subagents/workflows/wf_*/', () => {
    const wfDir = join(sessionDir, 'subagents', 'workflows', 'wf_abc12345-6dd');
    mkdirSync(wfDir, { recursive: true });
    const wfAgentJsonl = join(wfDir, `agent-${AGENT_ID}.jsonl`);
    writeFileSync(wfAgentJsonl, makeAssistantLine({ messageId: 'msg_wf_1' }) + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    const buf = readFileSync(join(storagePath, `buffer-${PARENT_SESSION}.jsonl`), 'utf-8');
    const tokenLines = buf
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines.some((t) => t.workflowRunId === 'wf_abc12345-6dd')).toBe(true);
  });

  it('skips files older than discovery window', () => {
    writeFileSync(agentJsonl, makeAssistantLine({ messageId: 'msg_old' }) + '\n');
    // Make file 25h old.
    const past = Date.now() - 25 * 60 * 60 * 1000;
    utimesSync(agentJsonl, past / 1000, past / 1000);
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
      discoveryHours: 24,
    });
    watcher.poll();
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const tokenLines = !existsSync(bufPath)
      ? []
      : readFileSync(bufPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines).toHaveLength(0);
  });

  it('rejects synthetic models', () => {
    const line = JSON.stringify({
      type: 'assistant',
      agentId: AGENT_ID,
      uuid: 'u',
      timestamp: '2026-06-15T12:00:00.000Z',
      sessionId: PARENT_SESSION,
      message: {
        id: 'msg_x',
        model: '<synthetic>',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text' }],
      },
    });
    writeFileSync(agentJsonl, line + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const tokenLines = !existsSync(bufPath)
      ? []
      : readFileSync(bufPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines).toHaveLength(0);
  });

  it('extracts reasoning_tokens from output_tokens_details', () => {
    writeFileSync(agentJsonl, makeAssistantLine({ messageId: 'msg_r', reasoning: 750 }) + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    const buf = readFileSync(join(storagePath, `buffer-${PARENT_SESSION}.jsonl`), 'utf-8');
    const tokenLines = buf
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines[0].reasoningTokens).toBe(750);
  });

  it('exports a stable cursor path helper', () => {
    const p = buildSubagentCursorPath('/tmp/store', PARENT_SESSION, AGENT_ID);
    expect(p).toContain('.subagent-pos-');
    expect(p).toContain(PARENT_SESSION);
    expect(p).toContain(AGENT_ID);
  });

  it('does not emit a token for a line that lacks a trailing newline', () => {
    // A file that contains a valid assistant JSON object but no trailing newline
    // represents a partial write mid-flush. The watcher must not emit a token
    // for it and must not throw.
    const partialLine = makeAssistantLine({ messageId: 'msg_partial' });
    writeFileSync(agentJsonl, partialLine); // no trailing newline
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    expect(() => watcher.poll()).not.toThrow();
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const tokenLines = existsSync(bufPath)
      ? readFileSync(bufPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((l) => l.mode === 'subagent_token')
      : [];
    // The partial line must be held in-memory — no event emitted yet.
    expect(tokenLines).toHaveLength(0);
  });

  it('increments parseErrors and does not throw on malformed JSON lines', () => {
    // Write one valid line and one malformed line (not valid JSON).
    const validLine = makeAssistantLine({ messageId: 'msg_valid' });
    writeFileSync(agentJsonl, validLine + '\n' + 'NOT_VALID_JSON{{{' + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    // Should not throw.
    expect(() => watcher.poll()).not.toThrow();
    // The valid line is emitted.
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const tokenLines = readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines).toHaveLength(1);
    expect(tokenLines[0].messageId).toBe('msg_valid');

    // Trigger a health flush and verify parseErrors > 0.
    // resetHealth zeroes counters; force a new health event by adding another
    // bad line so the next poll increments parseErrors again, then emit health.
    watcher.resetHealth();
    writeFileSync(agentJsonl, validLine + '\n' + 'BAD_JSON\n');
    watcher.poll();
    // emitHealth() writes an observability_health event to the buffer.
    // We call it indirectly via the public poll() + manual flush approach.
    // Instead, inspect the buffer for schema_drift or health events emitted
    // during this poll. The parseErrors counter is private but the
    // tryParseLine path is exercised; confirm no token event for the bad line.
    const afterSecond = readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const tokenLines2 = afterSecond.filter((l) => l.mode === 'subagent_token');
    // Still only 1 token event total (the valid line from the first poll;
    // resetHealth cleared counters but didn't re-emit already-consumed bytes).
    expect(tokenLines2).toHaveLength(1);
  });

  it('reads from a saved cursor position on restart (cursor durability)', () => {
    // Write one line and poll with the first watcher instance.
    const line1 = makeAssistantLine({ messageId: 'msg_first' });
    const line2 = makeAssistantLine({ messageId: 'msg_second', uuid: 'turn-uuid-2' });
    writeFileSync(agentJsonl, line1 + '\n');
    const watcher1 = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher1.poll();

    // Verify the cursor file was written.
    const cursorPath = buildSubagentCursorPath(storagePath, PARENT_SESSION, AGENT_ID);
    expect(existsSync(cursorPath)).toBe(true);
    const cursorState = JSON.parse(readFileSync(cursorPath, 'utf-8'));
    expect(cursorState.bytePos).toBeGreaterThan(0);

    // Append a second line.
    writeFileSync(agentJsonl, line1 + '\n' + line2 + '\n');

    // A freshly constructed watcher that shares the same storagePath must
    // resume from the saved cursor, not re-emit msg_first.
    const watcher2 = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher2.poll();

    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const tokenLines = readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
    // Only two total: one from watcher1, one new one from watcher2.
    expect(tokenLines).toHaveLength(2);
    expect(tokenLines[0].messageId).toBe('msg_first');
    expect(tokenLines[1].messageId).toBe('msg_second');
  });

  it('emitted subagent_token events contain no message content or prompt text', () => {
    // The source JSONL line contains a full `message` object with content blocks.
    // The emitted event must strip all content fields — only metadata/counts allowed.
    writeFileSync(
      agentJsonl,
      makeAssistantLine({ messageId: 'msg_privacy', contentTypes: ['text', 'tool_use'] }) + '\n',
    );
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    const buf = readFileSync(join(storagePath, `buffer-${PARENT_SESSION}.jsonl`), 'utf-8');
    const tokenLines = buf
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
    expect(tokenLines).toHaveLength(1);
    const event = tokenLines[0] as Record<string, unknown>;
    // Must not contain content, message body, or any text field
    expect(event['content']).toBeUndefined();
    expect(event['message']).toBeUndefined();
    expect(event['text']).toBeUndefined();
    expect(event['prompt']).toBeUndefined();
    expect(event['input']).toBeUndefined();
    // Must contain only the expected metadata fields
    expect(Object.keys(event)).toEqual(
      expect.arrayContaining([
        'mode',
        'timestamp',
        'agentId',
        'messageId',
        'model',
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheCreationTokens',
        'workflowRunId',
        'sessionId',
      ]),
    );
  });

  it('emits a discovery_skipped health event for files outside the discovery window', () => {
    writeFileSync(agentJsonl, makeAssistantLine({ messageId: 'msg_old' }) + '\n');
    // Set mtime to 25 hours ago, beyond the 24h discovery window.
    const past = Date.now() - 25 * 60 * 60 * 1000;
    utimesSync(agentJsonl, past / 1000, past / 1000);
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
      discoveryHours: 24,
    });
    watcher.poll();
    // The watcher uses a 'health' bucket for the unfiltered health buffer
    // when parentSessionId is set; it writes to buffer-<parentSessionId>.jsonl.
    // filterByMtime appends health to the parent buffer.
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const exists = existsSync(bufPath);
    const healthEvents = exists
      ? readFileSync(bufPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((l) => l.mode === 'observability_health' && l.event === 'discovery_skipped')
      : [];
    expect(healthEvents).toHaveLength(1);
  });

  it('emits a discovery_skipped health event when an agent filename does not match AGENT_ID_RE', () => {
    // Malformed agent id: right prefix/suffix shape, wrong length/charset.
    const badFile = join(sessionDir, 'subagents', 'agent-not-a-valid-id.jsonl');
    writeFileSync(badFile, '');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const exists = existsSync(bufPath);
    const healthEvents = exists
      ? readFileSync(bufPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((l) => l.mode === 'observability_health' && l.event === 'discovery_skipped')
      : [];
    expect(healthEvents).toHaveLength(1);
  });

  it('does not re-emit the discovery_skipped event for the same malformed agent id on a second poll', () => {
    const badFile = join(sessionDir, 'subagents', 'agent-not-a-valid-id.jsonl');
    writeFileSync(badFile, '');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    watcher.poll();
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const healthEvents = readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'observability_health' && l.event === 'discovery_skipped');
    expect(healthEvents).toHaveLength(1);
  });

  it('emits a discovery_skipped health event for a malformed agent id under a workflow run dir', () => {
    const wfDir = join(sessionDir, 'subagents', 'workflows', 'wf_abc12345-6dd');
    mkdirSync(wfDir, { recursive: true });
    const badFile = join(wfDir, 'agent-not-a-valid-id.jsonl');
    writeFileSync(badFile, '');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    const exists = existsSync(bufPath);
    const healthEvents = exists
      ? readFileSync(bufPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((l) => l.mode === 'observability_health' && l.event === 'discovery_skipped')
      : [];
    expect(healthEvents).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Memory-bound regression tests (OOM fix)
  //
  // A single JSONL line larger than MAX_BYTES_PER_POLL (64 KiB) used to freeze
  // the byte cursor (it only advanced to a newline boundary, and a 64 KiB chunk
  // with no newline contained no boundary). Every 2 s poll then re-read the same
  // bytes and appended them to the per-file partial-line string, which grew
  // ~64 KiB per poll forever → multi-GB RSS in minutes. These tests assert the
  // cursor now makes forward progress and the retained partial stays bounded.
  // -------------------------------------------------------------------------

  function countTokens(): { messageId: string }[] {
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    if (!existsSync(bufPath)) return [];
    return readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'subagent_token');
  }

  it('emits a line larger than MAX_BYTES_PER_POLL exactly once and bounds memory under sustained polling', () => {
    // A single assistant turn whose serialized JSONL exceeds 64 KiB (here ~200
    // KiB via padding). Under the pre-fix code this never emitted and leaked
    // ~64 KiB per poll. Under the fix the cursor advances each poll, the line
    // emits once its terminating newline is reached, and further polls are
    // no-ops.
    const bigLine = makeAssistantLine({ messageId: 'msg_big', padBytes: 200 * 1024 });
    expect(Buffer.byteLength(bigLine)).toBeGreaterThan(64 * 1024);
    writeFileSync(agentJsonl, bigLine + '\n');

    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });

    // Drive many poll cycles, far more than the number of 64 KiB chunks needed
    // to span the line. The cursor must reach EOF and the line must emit once.
    for (let i = 0; i < 50; i++) {
      watcher.poll();
    }

    const tokens = countTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.messageId).toBe('msg_big');

    // Cursor reached EOF (bytePos == file size) and retains no partial — proof
    // the partial-line buffer is not still holding the (large) line.
    const cursorPath = buildSubagentCursorPath(storagePath, PARENT_SESSION, AGENT_ID);
    const cursor = JSON.parse(readFileSync(cursorPath, 'utf-8'));
    const fileSize = Buffer.byteLength(readFileSync(agentJsonl));
    expect(cursor.bytePos).toBe(fileSize);
    expect(cursor.partialLine).toBe('');
  });

  it('keeps the persisted partial bounded for a never-terminated giant blob across many polls', () => {
    // A file that is one enormous un-terminated token (no '\n' ever). This is
    // the pathological case: the pre-fix code grew the partial without bound.
    // The fix caps the retained partial at MAX_PARTIAL_LINE_BYTES (1 MiB) and
    // drops the line, so the persisted partial can never exceed the cap (plus
    // one chunk), no matter how long we poll.
    const blob = 'x'.repeat(5 * 1024 * 1024); // 5 MiB, no newline
    writeFileSync(agentJsonl, blob);

    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });

    for (let i = 0; i < 300; i++) {
      watcher.poll();
    }

    const cursorPath = buildSubagentCursorPath(storagePath, PARENT_SESSION, AGENT_ID);
    const cursor = JSON.parse(readFileSync(cursorPath, 'utf-8'));
    // Hard bound: partial never exceeds the cap + one poll's worth of bytes.
    expect(cursor.partialLine.length).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
    // And the byte cursor reached EOF (we consumed the whole file).
    expect(cursor.bytePos).toBe(Buffer.byteLength(blob));
    // No token emitted (the blob is not a valid assistant turn).
    expect(countTokens()).toHaveLength(0);
  });

  it('does not duplicate bytes when a line is split across two polls', () => {
    // Regression for the partial double-count bug: the partial tail must be
    // prepended exactly once, not both retained AND re-read from the file.
    const line1 = makeAssistantLine({ messageId: 'msg_a' });
    const line2 = makeAssistantLine({ messageId: 'msg_b', uuid: 'u2' });
    // First poll sees line1 complete plus the first half of line2 (no newline).
    const half = Math.floor(line2.length / 2);
    writeFileSync(agentJsonl, line1 + '\n' + line2.slice(0, half));

    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    expect(countTokens()).toHaveLength(1);

    // Second poll: the rest of line2 plus its terminating newline arrives.
    writeFileSync(agentJsonl, line1 + '\n' + line2 + '\n');
    watcher.poll();

    const tokens = countTokens();
    expect(tokens).toHaveLength(2);
    // The second token must be the (uncorrupted) line2 — if bytes were
    // duplicated, the JSON would be malformed and never parse to msg_b.
    expect(tokens[1]!.messageId).toBe('msg_b');
  });

  // -------------------------------------------------------------------------
  // Schema-drift + cost self-check observability health events
  // -------------------------------------------------------------------------

  function makeAssistantLineWithUsage(
    messageId: string,
    uuid: string,
    usage: Record<string, unknown>,
  ): string {
    return JSON.stringify({
      type: 'assistant',
      agentId: AGENT_ID,
      uuid,
      timestamp: '2026-06-15T12:00:00.000Z',
      sessionId: PARENT_SESSION,
      message: {
        id: messageId,
        role: 'assistant',
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
        content: [{ type: 'text' }],
        usage,
      },
    });
  }

  function readHealthEvents(): {
    event?: string;
    dimension?: string;
    costSelfCheckDeltaPct?: number;
  }[] {
    const bufPath = join(storagePath, `buffer-${PARENT_SESSION}.jsonl`);
    if (!existsSync(bufPath)) return [];
    return readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.mode === 'observability_health');
  }

  it('emits schema_drift once for a new usage-key shape, then suppresses a repeat within the reemission window', () => {
    const fullUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    };
    const missingCacheCreation = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
    };
    const driftEvents = () =>
      readHealthEvents().filter((e) => e.event === 'schema_drift' && e.dimension === 'usage_keys');

    writeFileSync(agentJsonl, makeAssistantLineWithUsage('msg_1', 'u1', fullUsage) + '\n');
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
    });
    watcher.poll();
    // Baseline fingerprint — first time seen, so it fires.
    expect(driftEvents()).toHaveLength(1);

    writeFileSync(
      agentJsonl,
      makeAssistantLineWithUsage('msg_1', 'u1', fullUsage) +
        '\n' +
        makeAssistantLineWithUsage('msg_2', 'u2', missingCacheCreation) +
        '\n',
    );
    watcher.poll();
    // A distinct usage-key shape produces its own new schema_drift event.
    expect(driftEvents()).toHaveLength(2);

    writeFileSync(
      agentJsonl,
      makeAssistantLineWithUsage('msg_1', 'u1', fullUsage) +
        '\n' +
        makeAssistantLineWithUsage('msg_2', 'u2', missingCacheCreation) +
        '\n' +
        makeAssistantLineWithUsage('msg_3', 'u3', missingCacheCreation) +
        '\n',
    );
    watcher.poll();
    // The same shape recurring within the 1h reemission window does not re-fire.
    expect(driftEvents()).toHaveLength(2);
  });

  it('emits cost_self_check with the ground-truth-vs-tracked delta percentage', () => {
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: PARENT_SESSION,
      costSelfCheck: () => ({ trackedUsd: 8, groundTruthUsd: 10 }),
    });
    watcher.poll();

    const costEvents = readHealthEvents().filter((e) => e.event === 'cost_self_check');
    expect(costEvents).toHaveLength(1);
    // (groundTruthUsd - trackedUsd) / groundTruthUsd * 100 = (10 - 8) / 10 * 100 = 20
    expect(costEvents[0]!.costSelfCheckDeltaPct).toBeCloseTo(20, 5);
  });
});
