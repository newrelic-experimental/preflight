import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../storage/local-store.js';
import { CopilotUsageWatcher } from './copilot-usage-watcher.js';

const STDERR_WRITE = process.stderr.write;

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'copilot-usage-watcher-test-'));
}

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE_HASH = '25108083c218e7e7032f161e4f9e5162';

/**
 * Build a VS Code Copilot debug-log `llm_request` line — the shape observed
 * in a real main.jsonl (see copilot-usage-watcher.ts header for provenance).
 */
function makeLlmRequestLine(opts: {
  responseId?: string;
  sid?: string;
  ts?: number;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  type?: string;
}): string {
  const attrs: Record<string, unknown> = {
    debugName: 'panel/editAgent',
    ttft: 5000,
    maxTokens: 64000,
    copilotUsageNanoAiu: 80337250000,
  };
  if (opts.model !== null) attrs.model = opts.model ?? 'claude-opus-4-7';
  if (opts.inputTokens !== undefined || true) attrs.inputTokens = opts.inputTokens ?? 62362;
  attrs.outputTokens = opts.outputTokens ?? 477;
  attrs.cachedTokens = opts.cachedTokens ?? 0;
  if (opts.responseId !== null) attrs.responseId = opts.responseId ?? 'resp_1';
  return JSON.stringify({
    ts: opts.ts ?? 1786151170779,
    dur: 10911,
    sid: opts.sid ?? SESSION_ID,
    type: opts.type ?? 'llm_request',
    name: 'chat:claude-opus-4-7',
    spanId: 'b062b7d0471b2a66',
    status: 'ok',
    attrs,
  });
}

describe('CopilotUsageWatcher', () => {
  let storagePath: string;
  let workspaceStorageRoot: string;
  let logPath: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    storagePath = mkTmp();
    workspaceStorageRoot = mkTmp();
    const logDir = join(
      workspaceStorageRoot,
      WORKSPACE_HASH,
      'GitHub.copilot-chat',
      'debug-logs',
      SESSION_ID,
    );
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, 'main.jsonl');
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(workspaceStorageRoot, { recursive: true, force: true });
  });

  function readTokenEvents(sessionId = SESSION_ID): Record<string, unknown>[] {
    const bufPath = join(storagePath, `buffer-${sessionId}.jsonl`);
    if (!existsSync(bufPath)) return [];
    return readFileSync(bufPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.mode === 'token');
  }

  function makeWatcher(overrides?: { parentSessionId?: string }): CopilotUsageWatcher {
    return new CopilotUsageWatcher({
      storagePath,
      workspaceStorageRoots: [workspaceStorageRoot],
      parentSessionId: overrides?.parentSessionId ?? SESSION_ID,
    });
  }

  it('emits a token line for each llm_request record', () => {
    writeFileSync(logPath, makeLlmRequestLine({ responseId: 'resp_1' }) + '\n');
    const watcher = makeWatcher();
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mode: 'token',
      sessionId: SESSION_ID,
      messageId: 'resp_1',
      model: 'claude-opus-4-7',
      inputTokens: 62362,
      outputTokens: 477,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      timestamp: 1786151170779,
    });
  });

  it('subtracts cachedTokens from inputTokens (VS Code inputTokens is cache-inclusive)', () => {
    // Real observed record shape: inputTokens 65016, cachedTokens 62361 —
    // only the difference is genuinely new (uncached) input.
    writeFileSync(logPath, makeLlmRequestLine({ inputTokens: 65016, cachedTokens: 62361 }) + '\n');
    makeWatcher().poll();
    expect(readTokenEvents()[0]).toMatchObject({
      inputTokens: 65016 - 62361,
      cacheReadTokens: 62361,
    });
  });

  it('clamps input to 0 if cachedTokens somehow exceeds inputTokens', () => {
    writeFileSync(logPath, makeLlmRequestLine({ inputTokens: 100, cachedTokens: 500 }) + '\n');
    makeWatcher().poll();
    expect(readTokenEvents()[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 500 });
  });

  it('maps cachedTokens to cacheReadTokens', () => {
    writeFileSync(logPath, makeLlmRequestLine({ cachedTokens: 5000 }) + '\n');
    makeWatcher().poll();
    expect(readTokenEvents()[0]).toMatchObject({ cacheReadTokens: 5000 });
  });

  it('ignores records that are not llm_request', () => {
    writeFileSync(
      logPath,
      makeLlmRequestLine({ type: 'tool_call' }) +
        '\n' +
        makeLlmRequestLine({ type: 'span' }) +
        '\n',
    );
    makeWatcher().poll();
    expect(readTokenEvents()).toHaveLength(0);
  });

  it('skips llm_request records with no model', () => {
    writeFileSync(logPath, makeLlmRequestLine({ model: null }) + '\n');
    makeWatcher().poll();
    expect(readTokenEvents()).toHaveLength(0);
  });

  it('does not re-emit already-processed records across polls (byte cursor)', () => {
    writeFileSync(logPath, makeLlmRequestLine({ responseId: 'resp_1' }) + '\n');
    const watcher = makeWatcher();
    watcher.poll();
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(1);
  });

  it('picks up records appended after the first poll', () => {
    writeFileSync(logPath, makeLlmRequestLine({ responseId: 'resp_1' }) + '\n');
    const watcher = makeWatcher();
    watcher.poll();
    writeFileSync(
      logPath,
      makeLlmRequestLine({ responseId: 'resp_1' }) +
        '\n' +
        makeLlmRequestLine({ responseId: 'resp_2', ts: 1786151180000 }) +
        '\n',
    );
    watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ messageId: 'resp_2' });
  });

  it('cursor survives watcher restart', () => {
    writeFileSync(logPath, makeLlmRequestLine({ responseId: 'resp_1' }) + '\n');
    makeWatcher().poll();
    makeWatcher().poll();
    expect(readTokenEvents()).toHaveLength(1);
  });

  it('scoped mode ignores other sessions', () => {
    const otherId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const otherDir = join(
      workspaceStorageRoot,
      WORKSPACE_HASH,
      'GitHub.copilot-chat',
      'debug-logs',
      otherId,
    );
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'main.jsonl'), makeLlmRequestLine({ sid: otherId }) + '\n');
    makeWatcher().poll();
    expect(readTokenEvents(otherId)).toHaveLength(0);
  });

  it('unscoped mode discovers all recent session logs', () => {
    const otherId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const otherDir = join(
      workspaceStorageRoot,
      WORKSPACE_HASH,
      'GitHub.copilot-chat',
      'debug-logs',
      otherId,
    );
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(logPath, makeLlmRequestLine({ responseId: 'resp_a' }) + '\n');
    writeFileSync(
      join(otherDir, 'main.jsonl'),
      makeLlmRequestLine({ sid: otherId, responseId: 'resp_b' }) + '\n',
    );
    const watcher = new CopilotUsageWatcher({
      storagePath,
      workspaceStorageRoots: [workspaceStorageRoot],
    });
    watcher.poll();
    expect(readTokenEvents(SESSION_ID)).toHaveLength(1);
    expect(readTokenEvents(otherId)).toHaveLength(1);
  });

  it('attributes events to the record sid, falling back to the directory session id', () => {
    // sid present but different from dir name — record sid wins (hook buffer
    // routing is keyed by the same session_id VS Code sends in both places).
    const recordSid = 'cccccccc-dddd-eeee-ffff-000000000000';
    writeFileSync(logPath, makeLlmRequestLine({ sid: recordSid }) + '\n');
    new CopilotUsageWatcher({ storagePath, workspaceStorageRoots: [workspaceStorageRoot] }).poll();
    expect(readTokenEvents(recordSid)).toHaveLength(1);
  });

  it('tolerates malformed JSON lines and counts them as parse errors', () => {
    writeFileSync(logPath, 'not json{{{\n' + makeLlmRequestLine({}) + '\n');
    const watcher = makeWatcher();
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(1);
    expect(watcher.getHealth().parseErrors).toBe(1);
  });

  it('handles a missing workspaceStorage root without throwing', () => {
    const watcher = new CopilotUsageWatcher({
      storagePath,
      workspaceStorageRoots: [join(workspaceStorageRoot, 'does-not-exist')],
      parentSessionId: SESSION_ID,
    });
    expect(() => watcher.poll()).not.toThrow();
    expect(readTokenEvents()).toHaveLength(0);
  });

  it('start()/stop() are idempotent', () => {
    const watcher = makeWatcher();
    watcher.start();
    watcher.start();
    watcher.stop();
    watcher.stop();
  });

  it('unscoped mode skips sessions owned by a live --stdio heartbeat', () => {
    writeFileSync(logPath, makeLlmRequestLine({ responseId: 'resp_a' }) + '\n');
    const localStore = {
      getActiveSessionIdsFromHeartbeats: () => new Set([SESSION_ID]),
    } as unknown as LocalStore;
    const watcher = new CopilotUsageWatcher({
      storagePath,
      workspaceStorageRoots: [workspaceStorageRoot],
      localStore,
    });
    watcher.poll();
    expect(readTokenEvents()).toHaveLength(0);
  });

  it('processes a record whose line exceeds one poll read window', () => {
    // Real main.jsonl lines carry full inputMessages payloads and routinely
    // exceed 64 KiB; a single record must survive multi-poll assembly.
    const bigLine = JSON.stringify({
      ts: 1786151170779,
      sid: SESSION_ID,
      type: 'llm_request',
      attrs: {
        model: 'claude-opus-4-7',
        responseId: 'resp_big',
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        inputMessages: 'x'.repeat(200 * 1024),
      },
    });
    writeFileSync(logPath, bigLine + '\n');
    const watcher = makeWatcher();
    for (let i = 0; i < 8; i++) watcher.poll();
    const events = readTokenEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ messageId: 'resp_big', inputTokens: 10 });
  });

  it('reports health counters', () => {
    writeFileSync(logPath, makeLlmRequestLine({}) + '\n');
    const watcher = makeWatcher();
    watcher.poll();
    const health = watcher.getHealth();
    expect(health.filesWatched).toBe(1);
    expect(health.linesRead).toBe(1);
    expect(health.bytesRead).toBeGreaterThan(0);
  });
});
