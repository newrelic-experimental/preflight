import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { WorkflowStore } from './workflow-store.js';

const STDERR_WRITE = process.stderr.write;
const PARENT_SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'workflow-store-test-'));
}

function makeWfJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: 'wf_abc12345-6dd',
    timestamp: '2026-06-16T12:00:00.000Z',
    taskId: 'task-1',
    workflowName: 'sample',
    status: 'completed',
    startTime: 1781652144959,
    durationMs: 745892,
    defaultModel: 'claude-opus-4-7',
    agentCount: 2,
    totalTokens: 826463,
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Investigate' },
      {
        type: 'workflow_agent',
        agentId: 'a45d96d201bf2f1ef',
        label: 'investigate:hooks-coverage',
        phaseIndex: 1,
        phaseTitle: 'Investigate',
        model: 'claude-opus-4-7',
        state: 'done',
        attempt: 1,
        startedAt: 1,
        durationMs: 222186,
        tokens: 137810,
        toolCalls: 35,
        // user-content fields the store MUST NOT expose:
        promptPreview: 'secret-prompt',
        lastToolSummary: 'sensitive summary',
        resultPreview: 'private result',
      },
    ],
    ...overrides,
  });
}

describe('WorkflowStore', () => {
  let projectsDir: string;
  let wfDir: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    projectsDir = mkTmp();
    wfDir = join(projectsDir, 'project-slug', PARENT_SESSION, 'workflows');
    mkdirSync(wfDir, { recursive: true });
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it('listRuns returns rows for wf_*.json files in the window', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson());
    const store = new WorkflowStore({ projectsDir });
    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0].workflow_run_id).toBe('wf_abc12345-6dd');
    expect(rows[0].run_source).toBe('script');
    expect(rows[0].agent_count).toBe(2);
  });

  it('list view does NOT include the per-agent payload', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson());
    const store = new WorkflowStore({ projectsDir });
    const rows = store.listRuns();
    expect(rows[0].agents).toBeUndefined();
  });

  it('getRun returns a detail row with the agents array', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson());
    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');
    expect(row).not.toBeNull();
    expect(row!.agents).toBeDefined();
    expect(row!.agents).toHaveLength(1);
    expect(row!.agents![0].agent_id).toBe('a45d96d201bf2f1ef');
  });

  it('never exposes user-content fields on agent rows', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson());
    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');
    const agent = row!.agents![0] as unknown as Record<string, unknown>;
    expect(agent.promptPreview).toBeUndefined();
    expect(agent.prompt_preview).toBeUndefined();
    expect(agent.lastToolSummary).toBeUndefined();
    expect(agent.last_tool_summary).toBeUndefined();
    expect(agent.resultPreview).toBeUndefined();
    expect(agent.result_preview).toBeUndefined();
  });

  it('filters by status=incomplete', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson({ status: 'completed' }));
    writeFileSync(
      join(wfDir, 'wf_def98765-1aa.json'),
      makeWfJson({ runId: 'wf_def98765-1aa', status: 'killed' }),
    );
    const store = new WorkflowStore({ projectsDir });
    const incomplete = store.listRuns({ status: 'incomplete' });
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].status).toBe('killed');
    const complete = store.listRuns({ status: 'complete' });
    expect(complete).toHaveLength(1);
    expect(complete[0].status).toBe('completed');
  });

  it('integrates getCostForRun for total_usd', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson());
    const store = new WorkflowStore({
      projectsDir,
      getCostForRun: () => 4.56,
    });
    const rows = store.listRuns();
    expect(rows[0].total_usd).toBeCloseTo(4.56, 2);
  });

  it('returns null when run not found', () => {
    const store = new WorkflowStore({ projectsDir });
    expect(store.getRun('wf_nonexistent')).toBeNull();
  });

  it('refuses to read a scriptPath that escapes projectsDir (path traversal)', () => {
    // A well-formed, parseable script living OUTSIDE projectsDir. If the
    // containment guard were missing, its meta.name would leak into
    // topology.workflowName — proving the guard, not just "parsing failed".
    const outsideDir = mkTmp();
    const evilScript = join(outsideDir, 'evil.js');
    writeFileSync(
      evilScript,
      `export const meta = { name: 'exfiltrated-name', phases: [] }\nphase('x')`,
    );
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson({ scriptPath: evilScript }));

    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');

    expect(row?.topology).toBeNull();
    expect(row?.workflow_name).not.toBe('exfiltrated-name');
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('path.win32.relative + isAbsolute correctly signals containment for backslash-style paths', () => {
    // Regression pin for the Windows path-containment fix: the inlined check
    // in readRow() is `path.relative(root, resolved)` + a `..`/isAbsolute
    // test. This test proves that check's underlying stdlib contract holds
    // for Windows-style (backslash) paths — the actual containment logic
    // can't be unit-tested directly without extracting a helper, which would
    // break CodeQL's path-injection sanitizer recognition (see the comment
    // at the fix site).
    const root = 'C:\\Users\\dev\\.claude\\projects';

    // Contained: relative() yields a plain descendant path, no leading '..'.
    const containedRel = win32.relative(root, `${root}\\proj\\sess\\workflows\\scripts\\a.js`);
    expect(containedRel.startsWith('..')).toBe(false);
    expect(win32.isAbsolute(containedRel)).toBe(false);

    // Escaping via sibling traversal: relative() yields a leading '..'.
    const escapingRel = win32.relative(root, 'C:\\Users\\dev\\.ssh\\id_rsa');
    expect(escapingRel.startsWith('..')).toBe(true);

    // Escaping via a different drive letter: relative() yields an absolute
    // path on win32 (there's no relative path across drives).
    const crossDriveRel = win32.relative(root, 'D:\\secret\\evil.js');
    expect(win32.isAbsolute(crossDriveRel)).toBe(true);
  });

  it('rejects malformed runId on getRun', () => {
    const store = new WorkflowStore({ projectsDir });
    expect(store.getRun('../etc/passwd')).toBeNull();
  });

  it('derives error_reason as the FIRST LINE of a failed run, no stack frames', () => {
    const multiLineError =
      'Error: agent stalled on all 6 attempts (no progress for 180000ms each)\n' +
      '    at S (/$bunfs/root/src/entrypoints/cli.js:3566:2437)\n' +
      '    at processTicksAndRejections (native:7:39)';
    writeFileSync(
      join(wfDir, 'wf_abc12345-6dd.json'),
      makeWfJson({ status: 'failed', error: multiLineError }),
    );
    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');
    expect(row).not.toBeNull();
    expect(row!.error_reason).toBe(
      'Error: agent stalled on all 6 attempts (no progress for 180000ms each)',
    );
    // No stack frames leaked through.
    expect(row!.error_reason).not.toContain('    at ');
    expect(row!.error_reason).not.toContain('/$bunfs/');
    expect(row!.error_reason!.length).toBeLessThanOrEqual(200);
  });

  it('strips a stack frame that leaks onto the first line (defensive)', () => {
    writeFileSync(
      join(wfDir, 'wf_abc12345-6dd.json'),
      makeWfJson({
        status: 'failed',
        error: 'Error: boom    at S (/$bunfs/root/src/cli.js:1:1)',
      }),
    );
    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');
    expect(row!.error_reason).toBe('Error: boom');
  });

  it('error_reason is null for a completed run with no error', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson());
    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');
    expect(row!.status).toBe('completed');
    expect(row!.error_reason).toBeNull();
  });

  it('error_reason is null for a failed run with NO error field', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson({ status: 'failed' }));
    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');
    expect(row!.status).toBe('failed');
    expect(row!.error_reason).toBeNull();
  });

  it('caps a very long error line at 200 chars', () => {
    const longReason = 'Error: ' + 'x'.repeat(500);
    writeFileSync(
      join(wfDir, 'wf_abc12345-6dd.json'),
      makeWfJson({ status: 'failed', error: longReason }),
    );
    const store = new WorkflowStore({ projectsDir });
    const row = store.getRun('wf_abc12345-6dd');
    expect(row!.error_reason).not.toBeNull();
    expect(row!.error_reason!.length).toBe(200);
  });

  // WorkflowStore's readRow() currently hardcodes run_source: 'script' for
  // every wf_*.json it reads (there is no on-disk producer of 'agent_tool'
  // rows yet), so this pins the query-filtering branch itself (lines
  // ~161-167) in both directions rather than asserting on an unfiltered row:
  // filtering FOR the value every row actually has must include it,
  // filtering for the OTHER value must exclude it, and 'all'/omitted must
  // never filter.
  it('listRuns() filters by runSource, excluding non-matching values', () => {
    writeFileSync(join(wfDir, 'wf_abc12345-6dd.json'), makeWfJson());
    const store = new WorkflowStore({ projectsDir });
    const scriptOnly = store.listRuns({ runSource: 'script' });
    expect(scriptOnly).toHaveLength(1);
    expect(scriptOnly[0].run_source).toBe('script');

    const agentToolOnly = store.listRuns({ runSource: 'agent_tool' });
    expect(agentToolOnly).toHaveLength(0);

    const all = store.listRuns({ runSource: 'all' });
    expect(all).toHaveLength(1);

    const omitted = store.listRuns();
    expect(omitted).toHaveLength(1);
  });

  it('caps listRuns() at MAX_RUNS, keeping the most recent runs', () => {
    const TOTAL = 520; // exceeds the planned MAX_RUNS = 500 cap
    for (let i = 0; i < TOTAL; i++) {
      writeFileSync(
        join(wfDir, `wf_run${String(i).padStart(4, '0')}.json`),
        makeWfJson({ runId: `wf_run${String(i).padStart(4, '0')}`, startTime: 1_000_000 + i }),
      );
    }
    const store = new WorkflowStore({ projectsDir });
    const rows = store.listRuns({ since: 0 });
    expect(rows.length).toBeLessThanOrEqual(500);
    // Most-recent-first: the highest startTime (i = TOTAL - 1) must survive
    // the cap; an early-arrival run (i = 0) must not.
    expect(rows[0]!.workflow_run_id).toBe(`wf_run${String(TOTAL - 1).padStart(4, '0')}`);
    expect(rows.some((r) => r.workflow_run_id === 'wf_run0000')).toBe(false);
  });
});
