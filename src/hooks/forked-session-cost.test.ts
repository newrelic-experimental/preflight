import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParentTranscriptWatcher } from './parent-transcript-watcher.js';
import { HookEventProcessor } from './event-processor.js';
import { LocalStore } from '../storage/local-store.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import { localDateKey } from '../lib/date.js';
import type { HookEvent, TokenEvent } from '../storage/types.js';

/**
 * Replays the shape of a real `claude -p --resume <sid> --fork-session` run
 * (Claude Code 2.1.312): the fork transcript copies the parent's assistant
 * lines verbatim (same message.id, same original timestamp, same usage), only
 * rewriting sessionId, then appends its own new turn.
 */
const PARENT_SID = 'c0ac675e-9be7-48e9-87b8-86394606f2dc';
const FORK_SID = '5634b9b2-8fa1-42c8-aff0-a4b50a704343';
const MODEL = 'claude-sonnet-4-5';

// The recorded offsets between lines, replayed from a moment shortly before
// now: CostTracker drops token events older than 48 hours.
const RUN_START_MS = Date.now() - 60_000;
const at = (offsetMs: number): string => new Date(RUN_START_MS + offsetMs).toISOString();

const TURN_A = { id: 'msg_011CgXKYDaTjjpaQ19vpq5o3', ts: at(1_900) };
const TURN_B = { id: 'msg_011CgXKYXPnCVvSB6xYVwER9', ts: at(6_533) };
const TURN_C = { id: 'msg_011CgXKbDkTSNdWe2zWjjrhv', ts: at(42_761) };
const USER_1_TS = at(0);
const USER_2_TS = at(4_186);
const USER_3_TS = at(40_670);

function assistantLine(sessionId: string, turn: { id: string; ts: string }): string {
  return JSON.stringify({
    parentUuid: 'u',
    isSidechain: false,
    type: 'assistant',
    sessionId,
    timestamp: turn.ts,
    message: {
      model: MODEL,
      id: turn.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text' }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 23432,
        cache_read_input_tokens: 11382,
        output_tokens: 3,
      },
    },
  });
}

function userLine(sessionId: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    sessionId,
    timestamp: ts,
    message: { role: 'user', content: 'hi' },
  });
}

describe('forked session transcript cost accounting', () => {
  let storagePath: string;
  let projectsDir: string;

  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    storagePath = mkdtempSync(join(tmpdir(), 'fork-cost-storage-'));
    projectsDir = mkdtempSync(join(tmpdir(), 'fork-cost-projects-'));
    mkdirSync(join(projectsDir, 'repoA'));
    mkdirSync(join(projectsDir, 'repoB'));
    writeFileSync(
      join(projectsDir, 'repoA', `${PARENT_SID}.jsonl`),
      [
        userLine(PARENT_SID, USER_1_TS),
        assistantLine(PARENT_SID, TURN_A),
        userLine(PARENT_SID, USER_2_TS),
        assistantLine(PARENT_SID, TURN_B),
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(projectsDir, 'repoB', `${FORK_SID}.jsonl`),
      [
        userLine(FORK_SID, USER_1_TS),
        assistantLine(FORK_SID, TURN_A),
        userLine(FORK_SID, USER_2_TS),
        assistantLine(FORK_SID, TURN_B),
        userLine(FORK_SID, USER_3_TS),
        assistantLine(FORK_SID, TURN_C),
      ].join('\n') + '\n',
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('costs each unique message id once across the parent and its fork', () => {
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      discoveryHours: 24 * 365,
    });
    watcher.poll();

    const buffered: HookEvent[] = [];
    for (const f of readdirSync(storagePath).filter((n) => /^buffer-.*\.jsonl$/.test(n))) {
      for (const l of readFileSync(join(storagePath, f), 'utf-8').split('\n').filter(Boolean)) {
        buffered.push(JSON.parse(l) as HookEvent);
      }
    }
    expect(buffered.map((e) => (e as { sessionId?: string }).sessionId).sort()).toContain(FORK_SID);

    const costTracker = new CostTracker();
    const tokenEvents: TokenEvent[] = [];
    const costBySession = new Map<string, number>();
    const processor = new HookEventProcessor({
      store: new LocalStore(storagePath),
      onRecord: () => undefined,
      onTokenEvent: (te) => {
        tokenEvents.push(te);
        const b = costTracker.recordTokenUsage(
          {
            inputTokens: te.inputTokens,
            outputTokens: te.outputTokens,
            thinkingTokens: 0,
            cacheReadTokens: te.cacheReadTokens,
            cacheCreationTokens: te.cacheCreationTokens,
            totalTokens: te.inputTokens + te.outputTokens,
          },
          te.model,
          { timestampMs: te.timestamp },
        );
        costBySession.set(
          te.sessionId ?? '',
          (costBySession.get(te.sessionId ?? '') ?? 0) + b.totalUsd,
        );
      },
    });
    processor.processEvents(buffered);

    const uniqueIds = new Set([TURN_A.id, TURN_B.id, TURN_C.id]);
    const perTurnUsd = (costBySession.get(PARENT_SID) ?? 0) / 2;
    const dayKey = localDateKey(Date.parse(TURN_A.ts));
    expect(tokenEvents).toHaveLength(uniqueIds.size);
    expect(costTracker.getCostForDay(dayKey)).toBeCloseTo(perTurnUsd * uniqueIds.size, 10);
  });
});
