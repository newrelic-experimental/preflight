import { describe, expect, it, afterEach, jest } from '@jest/globals';
import type { ToolCallRecord } from '../storage/types.js';
import type { WorkflowRunEvent } from './workflow-run-tracker.js';
import { WorkflowRunTracker } from './workflow-run-tracker.js';

const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => {
  stderrSpy.mockClear();
  consoleErrorSpy.mockClear();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: 1_700_000_000_000,
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

function makeAgentRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return makeRecord({
    toolName: 'Agent',
    toolUseId: 'toolu_agent_001',
    durationMs: 1_000,
    timestamp: 1_700_000_001_000,
    subagentType: 'general-purpose',
    agentName: 'researcher',
    agentModel: 'claude-opus-4-7',
    agentDescription: 'do the thing',
    runInBackground: false,
    ...overrides,
  });
}

function makeWorkflowRunEvent(overrides?: Partial<WorkflowRunEvent>): WorkflowRunEvent {
  return {
    mode: 'workflow_run',
    timestamp: 1_700_000_010_000,
    workflowRunId: 'wf_abc123-def456',
    status: 'completed',
    durationMs: 5_000,
    totalTokens: 12_000,
    agentCount: 3,
    workflowName: 'deep-research',
    phases: ['Seed queries', 'Fetch sources', 'Synthesize'],
    workflowProgress: [
      { type: 'phase', state: 'done', agentId: 'ag-1' },
      { type: 'agent', state: 'done', agentId: 'ag-2' },
    ],
    parentSessionId: 'sess-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRunTracker', () => {
  it('opens and drains a completed run from a single Agent record', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(makeAgentRecord());

    const drained = tracker.drainCompleted();
    expect(drained).toHaveLength(1);
    const run = drained[0];
    expect(run.workflow_run_id).toBe('toolu_agent_001');
    expect(run.session_id).toBe('sess-001');
    expect(run.subagent_type).toBe('general-purpose');
    expect(run.agent_name).toBe('researcher');
    expect(run.agent_model).toBe('claude-opus-4-7');
    expect(run.agent_description).toBe('do the thing');
    expect(run.run_in_background).toBe(false);
    expect(run.duration_ms).toBe(1_000);
    expect(run.started_at).toBe(1_700_000_001_000 - 1_000);
    expect(run.status).toBe('completed');
    expect(run.exit_error).toBeNull();
    expect(run.tool_call_count).toBe(0);
    expect(run.child_agent_count).toBe(0);
  });

  it('marks a failed Agent record as errored and captures the error', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(
      makeAgentRecord({
        success: false,
        error: 'agent_interrupted',
      }),
    );

    const [run] = tracker.drainCompleted();
    expect(run.status).toBe('errored');
    expect(run.exit_error).toBe('agent_interrupted');
  });

  it('drainCompleted returns runs in arrival order and clears the buffer', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'a', timestamp: 1_000, durationMs: 10 }));
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'b', timestamp: 2_000, durationMs: 10 }));

    const first = tracker.drainCompleted();
    expect(first.map((r) => r.workflow_run_id)).toEqual(['a', 'b']);
    expect(tracker.drainCompleted()).toEqual([]);
  });

  it('attributes non-Agent tool calls to the enclosing run via recency window', () => {
    const tracker = new WorkflowRunTracker();
    // Agent ran from 1000 .. 1500 (started_at=1000, duration_ms=500, timestamp=1500)
    tracker.recordToolCall(
      makeAgentRecord({ toolUseId: 'parent', timestamp: 1_500, durationMs: 500 }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', timestamp: 1_200, toolUseId: 'child_read_1' }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Bash', timestamp: 1_400, toolUseId: 'child_bash_1' }),
    );

    const [run] = tracker.drainCompleted();
    expect(run.tool_call_count).toBe(2);
  });

  it('does not attribute tool calls outside the enclosing window', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(
      makeAgentRecord({ toolUseId: 'parent', timestamp: 1_500, durationMs: 500 }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', timestamp: 5_000, toolUseId: 'late_read' }),
    );
    tracker.recordToolCall(makeRecord({ toolName: 'Read', timestamp: 100, toolUseId: 'pre_read' }));

    const [run] = tracker.drainCompleted();
    expect(run.tool_call_count).toBe(0);
  });

  it('counts nested Agent calls as child_agent_count of their parent', () => {
    const tracker = new WorkflowRunTracker();
    // Outer agent: started_at=0 (timestamp=10000, durationMs=10000), window [0..10000]
    tracker.recordToolCall(
      makeAgentRecord({ toolUseId: 'outer', timestamp: 10_000, durationMs: 10_000 }),
    );
    // Inner agent #1: started_at=2000 (timestamp=3000, durationMs=1000)
    tracker.recordToolCall(
      makeAgentRecord({ toolUseId: 'inner_1', timestamp: 3_000, durationMs: 1_000 }),
    );
    // Inner agent #2: started_at=5000 (timestamp=6000, durationMs=1000)
    tracker.recordToolCall(
      makeAgentRecord({ toolUseId: 'inner_2', timestamp: 6_000, durationMs: 1_000 }),
    );

    const all = tracker.drainCompleted();
    const byId = new Map(all.map((r) => [r.workflow_run_id, r]));
    expect(byId.get('outer')?.child_agent_count).toBe(2);
    expect(byId.get('inner_1')?.child_agent_count).toBe(0);
    expect(byId.get('inner_2')?.child_agent_count).toBe(0);
  });

  it('does not attribute child tool calls across sessions', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(
      makeAgentRecord({
        sessionId: 'sess-A',
        toolUseId: 'parent_a',
        timestamp: 1_500,
        durationMs: 500,
      }),
    );
    tracker.recordToolCall(
      makeRecord({
        sessionId: 'sess-B',
        toolName: 'Read',
        timestamp: 1_200,
        toolUseId: 'child_other_session',
      }),
    );

    const [run] = tracker.drainCompleted();
    expect(run.tool_call_count).toBe(0);
  });

  it('truncates agent_description to descriptionMaxLength', () => {
    const tracker = new WorkflowRunTracker({ descriptionMaxLength: 8 });
    tracker.recordToolCall(
      makeAgentRecord({ agentDescription: 'this is a very long description string' }),
    );

    const [run] = tracker.drainCompleted();
    expect(run.agent_description).toHaveLength(8);
    expect(run.agent_description).toBe('this is ');
  });

  it('skips Agent records that lack a toolUseId', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(makeAgentRecord({ toolUseId: '' }));
    expect(tracker.drainCompleted()).toEqual([]);
  });

  it('reset clears open and completed runs', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(makeAgentRecord());
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'second' }));

    tracker.reset('new-session');

    expect(tracker.drainCompleted()).toEqual([]);
    expect(tracker.getMetrics()).toEqual([]);
  });

  it('caps completed runs at maxCompletedRuns by dropping the oldest', () => {
    const tracker = new WorkflowRunTracker({ maxCompletedRuns: 2 });
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'a', timestamp: 1_000, durationMs: 10 }));
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'b', timestamp: 2_000, durationMs: 10 }));
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'c', timestamp: 3_000, durationMs: 10 }));

    const drained = tracker.drainCompleted();
    expect(drained.map((r) => r.workflow_run_id)).toEqual(['b', 'c']);
  });

  it('enforceOpenRunsCap evicts the oldest open run once maxOpenRuns is exceeded', () => {
    const tracker = new WorkflowRunTracker({ maxOpenRuns: 2 });

    // Three non-overlapping run windows: a=[1000,1100], b=[2000,2100], c=[3000,3100].
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'a', timestamp: 1_100, durationMs: 100 }));
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'b', timestamp: 2_100, durationMs: 100 }));
    tracker.recordToolCall(makeAgentRecord({ toolUseId: 'c', timestamp: 3_100, durationMs: 100 }));

    // Drain so `completed` no longer holds these runs -- only openRuns (now
    // capped to the 2 most-recently-opened) can serve attribution below.
    tracker.drainCompleted();

    // A child call inside the evicted run 'a's window finds no enclosing run.
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', timestamp: 1_050, toolUseId: 'child_a' }),
    );
    // Child calls inside the two retained runs' windows still attribute correctly.
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', timestamp: 2_050, toolUseId: 'child_b' }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Bash', timestamp: 3_050, toolUseId: 'child_c' }),
    );

    const byId = new Map(tracker.getMetrics().map((r) => [r.workflow_run_id, r]));
    expect(byId.has('a')).toBe(false);
    expect(byId.get('b')?.tool_call_count).toBe(1);
    expect(byId.get('c')?.tool_call_count).toBe(1);
  });

  it('getMetrics returns a snapshot without clearing', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(makeAgentRecord());

    const snapshot = tracker.getMetrics();
    expect(snapshot).toHaveLength(1);
    // Same data still drainable
    expect(tracker.drainCompleted()).toHaveLength(1);
  });

  it('attributes a child tool call that arrives after the run is drained (e.g. a background agent)', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordToolCall(makeAgentRecord({ runInBackground: true }));

    // Simulate the immediate NR emission right after the Agent call's own
    // record is processed — this used to permanently zero out attribution
    // for anything arriving afterward (the run was deleted from openRuns).
    const [drained] = tracker.drainCompleted();
    expect(drained?.tool_call_count).toBe(0);

    // A child tool call within the agent's window, arriving after drain.
    tracker.recordToolCall(
      makeRecord({ sessionId: 'sess-001', toolName: 'Read', timestamp: 1_700_000_000_500 }),
    );

    const [run] = tracker.getMetrics();
    expect(run?.tool_call_count).toBe(1);
    // The run is not double-counted despite living in both openRuns and
    // completed until it's next drained.
    expect(tracker.getMetrics()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // recordAgentToolCall direct entry point
  // ---------------------------------------------------------------------------

  it('recordAgentToolCall with Agent toolName creates a run with run_source=agent_tool', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordAgentToolCall(makeAgentRecord({ toolUseId: 'toolu_direct_001' }));

    const drained = tracker.drainCompleted();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.run_source).toBe('agent_tool');
    expect(drained[0]?.workflow_run_id).toBe('toolu_direct_001');
  });

  it('recordAgentToolCall with non-Agent toolName is ignored', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordAgentToolCall(makeRecord({ toolName: 'Read', toolUseId: 'toolu_read_001' }));
    tracker.recordAgentToolCall(makeRecord({ toolName: 'Bash', toolUseId: 'toolu_bash_001' }));

    expect(tracker.drainCompleted()).toEqual([]);
    expect(tracker.getMetrics()).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // recordScriptRun — 'script' source
  // ---------------------------------------------------------------------------

  it('recordScriptRun creates a run with run_source=script and correct field mapping', () => {
    const tracker = new WorkflowRunTracker();
    const event = makeWorkflowRunEvent();
    tracker.recordScriptRun(event);

    const drained = tracker.drainCompleted();
    expect(drained).toHaveLength(1);
    const run = drained[0];
    expect(run?.run_source).toBe('script');
    expect(run?.workflow_run_id).toBe('wf_abc123-def456');
    expect(run?.workflow_name).toBe('deep-research');
    expect(run?.status).toBe('completed');
    expect(run?.duration_ms).toBe(5_000);
    expect(run?.started_at).toBe(1_700_000_010_000 - 5_000);
    expect(run?.total_tokens).toBe(12_000);
    expect(run?.agent_count).toBe(3);
    expect(run?.incomplete).toBe(false);
    // script-source runs have null for agent_tool-only fields
    expect(run?.subagent_type).toBeNull();
    expect(run?.agent_name).toBeNull();
    expect(run?.agent_model).toBeNull();
    expect(run?.agent_description).toBeNull();
    expect(run?.run_in_background).toBeNull();
    expect(run?.exit_error).toBeNull();
  });

  it('recordScriptRun sets declared_phases from phases array length', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordScriptRun(makeWorkflowRunEvent({ phases: ['A', 'B', 'C'] }));

    const [run] = tracker.drainCompleted();
    expect(run?.declared_phases).toBe(3);
  });

  it('recordScriptRun sets declared_phases to null when phases array is empty', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordScriptRun(makeWorkflowRunEvent({ phases: [] }));

    const [run] = tracker.drainCompleted();
    expect(run?.declared_phases).toBeNull();
  });

  it('recordScriptRun with status=killed marks run as incomplete', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordScriptRun(makeWorkflowRunEvent({ status: 'killed' }));

    const [run] = tracker.drainCompleted();
    expect(run?.status).toBe('killed');
    expect(run?.incomplete).toBe(true);
  });

  it('recordScriptRun with status=progress marks run as incomplete', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordScriptRun(makeWorkflowRunEvent({ status: 'progress' }));

    const [run] = tracker.drainCompleted();
    expect(run?.incomplete).toBe(true);
  });

  it('recordScriptRun counts distinct type values in workflowProgress as observed_phases', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordScriptRun(
      makeWorkflowRunEvent({
        workflowProgress: [
          { type: 'phase', state: 'done' },
          { type: 'agent', state: 'done' },
          { type: 'phase', state: 'done' },
          { type: 'agent', state: 'done' },
        ],
      }),
    );

    const [run] = tracker.drainCompleted();
    // Two distinct types: 'phase' and 'agent'
    expect(run?.observed_phases).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // run_source discriminator — id namespaces must not collide
  // ---------------------------------------------------------------------------

  it('agent_tool ids (toolu_*) and script ids (wf_*) never share a workflow_run_id', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordAgentToolCall(makeAgentRecord({ toolUseId: 'toolu_aaa' }));
    tracker.recordScriptRun(makeWorkflowRunEvent({ workflowRunId: 'wf_bbb-ccc' }));

    const drained = tracker.drainCompleted();
    expect(drained).toHaveLength(2);

    const agentRun = drained.find((r) => r.run_source === 'agent_tool');
    const scriptRun = drained.find((r) => r.run_source === 'script');

    expect(agentRun?.workflow_run_id).toBe('toolu_aaa');
    expect(scriptRun?.workflow_run_id).toBe('wf_bbb-ccc');
    expect(agentRun?.workflow_run_id).not.toBe(scriptRun?.workflow_run_id);
  });

  it('reset clears runs from both agent_tool and script sources', () => {
    const tracker = new WorkflowRunTracker();
    tracker.recordAgentToolCall(makeAgentRecord());
    tracker.recordScriptRun(makeWorkflowRunEvent());

    tracker.reset('new-session');

    expect(tracker.drainCompleted()).toEqual([]);
    expect(tracker.getMetrics()).toEqual([]);
  });
});
