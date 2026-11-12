import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParentTranscriptWatcher } from './parent-transcript-watcher.js';
import { HookEventProcessor } from './event-processor.js';
import type { TokenEvent } from '../storage/types.js';
import { LocalStore } from '../storage/local-store.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import { buildCostTrackerSeed } from '../metrics/cost-tracker-seed.js';
import type { FullSessionSummary } from '../storage/session-store.js';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STDERR_WRITE = process.stderr.write;

function assistantLine(messageId: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `uuid-${messageId}`,
    timestamp: '2026-06-15T12:00:00.000Z',
    isSidechain: false,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cost double count across restart + repo rename', () => {
  let storagePath: string;
  let projectsDir: string;
  let oldPath: string;
  let newPath: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    storagePath = mkdtempSync(join(tmpdir(), 'cdc-storage-'));
    projectsDir = mkdtempSync(join(tmpdir(), 'cdc-projects-'));
    mkdirSync(join(projectsDir, 'old-slug'));
    mkdirSync(join(projectsDir, 'new-slug'));
    oldPath = join(projectsDir, 'old-slug', `${SESSION_ID}.jsonl`);
    newPath = join(projectsDir, 'new-slug', `${SESSION_ID}.jsonl`);
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function makeProcess(costTracker: CostTracker) {
    const events: TokenEvent[] = [];
    const processor = new HookEventProcessor({
      store: new LocalStore(storagePath, SESSION_ID),
      pollIntervalMs: 10,
      onRecord: () => {},
      onTokenEvent: (e) => {
        events.push(e);
        costTracker.recordTokenUsage(
          {
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            thinkingTokens: 0,
            cacheReadTokens: e.cacheReadTokens,
            cacheCreationTokens: e.cacheCreationTokens,
            totalTokens: e.inputTokens + e.outputTokens,
          },
          e.model,
          { timestampMs: e.timestamp, replacesEstimates: true },
        );
      },
    });
    const watcher = new ParentTranscriptWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
    });
    return { processor, watcher, events };
  }

  async function pump(p: ReturnType<typeof makeProcess>): Promise<void> {
    p.watcher.poll();
    p.processor.start();
    await sleep(100);
    p.processor.stop();
  }

  function setMtime(path: string, secondsAgo: number): void {
    const t = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, t, t);
  }

  function persistedSummary(ct: CostTracker): FullSessionSummary {
    const m = ct.getMetrics();
    const now = Date.now();
    const modelBreakdown: Record<string, unknown> = {};
    for (const [model, usd] of Object.entries(m.costByModel)) {
      modelBreakdown[model] = { totalCostUsd: usd };
    }
    return {
      startTime: now - 60_000,
      endTime: now,
      estimatedCostUsd: m.sessionTotalCostUsd,
      subagentCostUsd: m.subagentCostUsd,
      tokensInput: m.totalInputTokens,
      tokensOutput: m.totalOutputTokens,
      tokensThinking: m.totalThinkingTokens,
      tokensCacheRead: m.totalCacheReadTokens,
      tokensCacheCreation: m.totalCacheCreationTokens,
      cacheSavingsUsd: m.totalCacheSavingsUsd,
      modelBreakdown,
      costByWorkflowRunId: {},
    } as unknown as FullSessionSummary;
  }

  it('restart: process B must not re-count t1 from the renamed project dir', async () => {
    mkdirSync(storagePath, { recursive: true });
    writeFileSync(oldPath, assistantLine('msg_X') + '\n');
    setMtime(oldPath, 100);
    const costA = new CostTracker();
    const a = makeProcess(costA);
    await pump(a);
    expect(a.events).toHaveLength(1);
    const t1Cost = costA.getMetrics().sessionTotalCostUsd!;
    expect(t1Cost).toBeGreaterThan(0);
    const persisted = persistedSummary(costA);
    writeFileSync(newPath, assistantLine('msg_X') + '\n');
    setMtime(newPath, 1);

    const costB = new CostTracker();
    costB.seedFromPersisted(buildCostTrackerSeed(persisted));
    expect(costB.getMetrics().sessionTotalCostUsd).toBeCloseTo(t1Cost, 10);
    const b = makeProcess(costB);
    await pump(b);

    expect(costB.getMetrics().sessionTotalCostUsd).toBeCloseTo(t1Cost, 10);
    expect(b.events.filter((e) => e.sessionId === SESSION_ID)).toHaveLength(0);
  });

  it('control (no restart): same processor across the rename does not re-count t1', async () => {
    writeFileSync(oldPath, assistantLine('msg_X') + '\n');
    setMtime(oldPath, 100);
    const cost = new CostTracker();
    const p = makeProcess(cost);
    await pump(p);
    const t1Cost = cost.getMetrics().sessionTotalCostUsd!;
    expect(p.events).toHaveLength(1);

    writeFileSync(newPath, assistantLine('msg_X') + '\n');
    setMtime(newPath, 1);
    await pump(p);

    expect(p.events).toHaveLength(1);
    expect(cost.getMetrics().sessionTotalCostUsd).toBeCloseTo(t1Cost, 10);
  });
});
