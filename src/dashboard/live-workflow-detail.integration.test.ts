/**
 * End-to-end integration test for the live workflow-run detail path.
 *
 * Reproduces the exact production scenario that used to 404 ("Failed to load
 * run details"): a workflow that is STILL RUNNING has its per-agent subagent
 * transcripts on disk under `subagents/workflows/<runId>/agent-*.jsonl`, but NO
 * `workflows/<runId>.json` rollup yet (that file is written only at
 * termination). The swimlane makes the run lane clickable from those
 * transcripts, so `GET /api/workflows/:runId` must serve a running detail.
 *
 * Unlike the mocked route tests in routes/api-handler.test.ts, this wires the
 * REAL WorkflowStore + SubagentTimelineStore against a real temp
 * `~/.claude/projects` tree and drives the REAL createApiHandler route — so it
 * exercises actual filesystem discovery, transcript parsing, script/topology
 * resolution, and JSON serialization together.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';

import { createApiHandler } from './routes/api-handler.js';
import { WorkflowStore } from './workflow-store.js';
import { SubagentTimelineStore } from './subagent-timeline-store.js';

const STDERR_WRITE = process.stderr.write;
const SLUG = 'project-slug';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RUN_ID = 'wf_live1234-abc';
const AGENT_A = 'a1111111111111111';
const AGENT_B = 'a2222222222222222';
const KNOWN_MODEL = 'claude-opus-4-7';

function assistantLine(opts: { ts: string; input?: number; output?: number }): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    uuid: 'u-' + opts.ts,
    message: {
      id: 'msg-' + opts.ts,
      model: KNOWN_MODEL,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

function fakeRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
} {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    setHeader: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk) body += chunk.toString();
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

describe('live workflow-run detail (integration: real stores + real route)', () => {
  let projectsDir: string;
  let sessionDir: string;
  let wfRunTranscriptsDir: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    projectsDir = mkdtempSync(join(tmpdir(), 'live-wf-detail-'));
    sessionDir = join(projectsDir, SLUG, SESSION);
    // Live transcripts exist mid-run; the rollup (workflows/<runId>.json) does NOT.
    wfRunTranscriptsDir = join(sessionDir, 'subagents', 'workflows', RUN_ID);
    mkdirSync(wfRunTranscriptsDir, { recursive: true });
    writeFileSync(
      join(wfRunTranscriptsDir, `agent-${AGENT_A}.jsonl`),
      [
        assistantLine({ ts: '2026-07-07T12:00:00.000Z', input: 100, output: 50 }),
        assistantLine({ ts: '2026-07-07T12:00:30.000Z', input: 200, output: 80 }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(wfRunTranscriptsDir, `agent-${AGENT_B}.jsonl`),
      assistantLine({ ts: '2026-07-07T12:00:10.000Z', input: 40, output: 20 }) + '\n',
    );
    // Persisted orchestration script → declared topology + workflow name.
    const scriptsDir = join(sessionDir, 'workflows', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, `live-fix-demo-${RUN_ID}.js`),
      "export const meta = { name: 'live-fix-demo', description: 'x', " +
        "phases: [{ title: 'Scan' }, { title: 'Fix' }] }\nawait agent('go');\n",
    );
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function makeHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    // Real stores — they structurally satisfy the (minimal) dep interfaces, so
    // pass the instances directly rather than re-wrapping each method.
    const workflowStore = new WorkflowStore({ projectsDir });
    const subagentTimeline = new SubagentTimelineStore({ projectsDir });
    return createApiHandler({
      workflowStore,
      subagentTimeline,
    } as unknown as Parameters<typeof createApiHandler>[0]) as unknown as (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<void>;
  }

  it('has NO rollup on disk but DOES have live transcripts (precondition)', () => {
    const workflowStore = new WorkflowStore({ projectsDir });
    const subagentTimeline = new SubagentTimelineStore({ projectsDir });
    // The regression: getRun returns null for a still-running run …
    expect(workflowStore.getRun(RUN_ID)).toBeNull();
    // … while getRunLive can reconstruct it from the transcripts.
    const live = subagentTimeline.getRunLive(RUN_ID);
    expect(live).not.toBeNull();
    expect(live!.agentCount).toBe(2);
  });

  it('serves a running detail (200) for a live run with no rollup — the bug fix', async () => {
    const handler = makeHandler();
    const req = { method: 'GET', url: `/api/workflows/${RUN_ID}` } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);

    expect(status()).toBe(200); // was 404 before the fix
    const parsed = JSON.parse(body());
    expect(parsed.run.runId).toBe(RUN_ID);
    expect(parsed.run.status).toBe('running');
    expect(parsed.run.incomplete).toBe(true);
    expect(parsed.run.parentSessionId).toBe(SESSION);
    expect(parsed.run.workflowName).toBe('live-fix-demo'); // resolved from the script
    expect(parsed.run.workflowJsonPath).toBe(''); // no rollup file
    // Agent A: (100+50)+(200+80)=430; Agent B: (40+20)=60 → 490.
    expect(parsed.run.totalTokens).toBe(490);
    expect(parsed.run.totalUsd).toBeGreaterThan(0); // priced model
    // Agents assembled from both transcripts, sorted by start time.
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.agents[0].agentId).toBe(AGENT_A);
    expect(parsed.agents.every((a: { state: string }) => a.state === 'running')).toBe(true);
    // Declared topology surfaced from the script.
    expect(parsed.topology.declaredPhases).toBe(2);
    expect(parsed.run.declaredPhases).toBe(2);
  });

  it('prefers the on-disk rollup once the run terminates (auto-upgrade)', async () => {
    // Simulate the run finishing: write the rollup the harness emits at the end.
    writeFileSync(
      join(sessionDir, 'workflows', `${RUN_ID}.json`),
      JSON.stringify({
        runId: RUN_ID,
        workflowName: 'live-fix-demo',
        status: 'completed',
        defaultModel: KNOWN_MODEL,
        startTime: Date.parse('2026-07-07T12:00:00.000Z'),
        durationMs: 45_000,
        agentCount: 2,
        totalTokens: 590,
        workflowProgress: [],
      }),
    );

    const handler = makeHandler();
    const req = { method: 'GET', url: `/api/workflows/${RUN_ID}` } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);

    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    // Now the terminal rollup wins over the live fallback.
    expect(parsed.run.status).toBe('completed');
    expect(parsed.run.incomplete).toBe(false);
    expect(parsed.run.workflowJsonPath).not.toBe('');
  });

  it('404s for a run with neither a rollup nor live transcripts', async () => {
    const handler = makeHandler();
    const req = { method: 'GET', url: '/api/workflows/wf_ghost0000-xyz' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
    expect(JSON.parse(body())).toEqual({ error: 'not_found' });
  });
});
