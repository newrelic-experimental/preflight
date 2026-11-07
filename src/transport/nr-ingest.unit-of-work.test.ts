import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SkillActivationTracker } from '../metrics/skill-activation-tracker.js';
import { TurnCostAttributor } from '../metrics/turn-cost-attributor.js';
import type { WorkflowRunMetrics } from '../metrics/workflow-run-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';
import {
  subagentTurnToNrEvent,
  toolCallToNrEvent,
  turnCostToNrEvents,
  workflowRunToNrEvent,
} from './nr-ingest.js';

const DOC = readFileSync(join(process.cwd(), 'docs/UNIT_OF_WORK_SCHEMA.md'), 'utf8');
const TEAM_ATTRIBUTION = new Set(['team_id', 'project_id', 'org_id']);
const NRQL_WORDS = new Set(
  'select from where facet since until limit max join on and or not is null as days ago'.split(' '),
);
const ATTRS = {
  developer: 'dev',
  appName: 'app',
  sessionTraceId: 'sess-1',
  teamId: 'team',
  projectId: 'project',
  orgId: 'org',
};

interface CatalogRow {
  readonly event: string;
  readonly attribute: string;
  readonly stability: string;
}

function parseCatalog(): CatalogRow[] {
  const rows = DOC.matchAll(/^\| `(Ai\w+)` +\| `(\w+)` +\| (\w+) +\|$/gm);
  return [...rows].map(([, event, attribute, stability]) => ({ event, attribute, stability }));
}

function makeRecord(toolName: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: `id-${toolName}`,
    sessionId: 'sess-1',
    toolName,
    toolUseId: `tu-${toolName}`,
    timestamp: 1000,
    durationMs: 10,
    success: true,
    ...overrides,
  } as ToolCallRecord;
}

function makeTokenEvent(timestamp: number) {
  return {
    mode: 'token' as const,
    sessionId: 'sess-1',
    timestamp,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheCreationTokens: 5,
    model: 'claude-sonnet-4-5-20250929',
  };
}

function nestedSkillStamp() {
  const skills = new SkillActivationTracker();
  skills.recordToolCall(makeRecord('Skill', { skillName: 'outer' }));
  const inner = skills.recordToolCall(makeRecord('Skill', { skillName: 'inner' }));
  if (!inner) throw new Error('a successful Skill call opens a run');
  return inner;
}

function emittedEvents(): Record<string, Record<string, unknown>> {
  const activeSkill = nestedSkillStamp();
  const record = makeRecord('Read', { agentId: 'agent-1', activeSkill });
  const attributor = new TurnCostAttributor();
  attributor.recordToolCall(record);
  const [turnCost] = turnCostToNrEvents(attributor.recordTokenEvent(makeTokenEvent(2000)), ATTRS);
  return {
    AiToolCall: toolCallToNrEvent(record, ATTRS),
    AiTurnCost: turnCost,
    AiSubagentTurn: subagentTurnToNrEvent(
      {
        workflow_run_id: 'wf-1',
        agent_id: 'agent-1',
        agent_type: 'Explore',
        parent_session_id: 'sess-1',
        message_id: 'msg-1',
        turn_uuid: 'turn-1',
        timestamp_ms: 2000,
        model: 'claude-sonnet-4-5-20250929',
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_tokens: 1,
        cache_read_tokens: 1,
        reasoning_tokens: 1,
        usd: 0.01,
        stop_reason: null,
        schema_fingerprint: '',
      },
      ATTRS,
    ),
    AiWorkflowRun: workflowRunToNrEvent(
      {
        workflow_run_id: 'toolu_1',
        run_source: 'agent_tool',
        session_id: 'sess-1',
        subagent_type: 'Explore',
        agent_model: 'haiku',
        run_in_background: false,
        duration_ms: 10,
        started_at: 1000,
        tool_call_count: 0,
        child_agent_count: 0,
        status: 'completed',
      } as unknown as WorkflowRunMetrics,
      ATTRS,
    ),
  };
}

describe('unit of agent work schema', () => {
  const catalog = parseCatalog();

  it('names a schema version and only stable or experimental attributes', () => {
    expect(DOC).toMatch(/^\*\*Schema version: \d+\.\*\*$/m);
    expect(catalog.length).toBeGreaterThan(0);
    for (const row of catalog) expect(['stable', 'experimental']).toContain(row.stability);
  });

  it('catalogs only attributes the emitters put on that event', () => {
    const events = emittedEvents();
    const missing = catalog.filter((row) => !(row.attribute in events[row.event]));
    expect(missing).toEqual([]);
  });

  it('marks an attribute stable only if a shipped dashboard reads it', () => {
    const dashboards = readdirSync('dashboards')
      .map((file) => readFileSync(join('dashboards', file), 'utf8'))
      .join('\n');
    const unread = catalog.filter(
      (row) =>
        row.stability === 'stable' &&
        !TEAM_ATTRIBUTION.has(row.attribute) &&
        !new RegExp(`\\b${row.attribute}\\b`).test(dashboards),
    );
    expect(unread).toEqual([]);
  });

  it('marks no attribute experimental that a dashboard reads from its own event', () => {
    const queries = readdirSync('dashboards').flatMap((file) =>
      [
        ...readFileSync(join('dashboards', file), 'utf8').matchAll(/"query": "((?:[^"\\]|\\.)*)"/g),
      ].map(([, query]) => query),
    );
    expect(queries.length).toBeGreaterThan(0);
    const read = catalog.filter(
      (row) =>
        row.stability === 'experimental' &&
        queries.some(
          (query) =>
            new RegExp(`\\bFROM ${row.event}\\b`).test(query) &&
            new RegExp(`\\b${row.attribute}\\b`).test(query),
        ),
    );
    expect(read).toEqual([]);
  });

  it('names only cataloged attributes in its NRQL recipes', () => {
    const known = new Set(catalog.flatMap((row) => [row.event, row.attribute]));
    const recipes = [...DOC.matchAll(/```sql\n([\s\S]*?)```/g)].map(([, query]) => query);
    expect(recipes.length).toBeGreaterThan(0);
    const unknown = recipes.flatMap((query) => {
      const aliases = [...query.matchAll(/\bAS (\w+)/g)].map(([, alias]) => alias);
      const identifiers = query
        .replace(/'[^']*'/g, '')
        .replace(/\b\w+\(/g, '(')
        .match(/\b[A-Za-z_]\w*\b/g);
      return (identifiers ?? []).filter(
        (word) =>
          !known.has(word) && !aliases.includes(word) && !NRQL_WORDS.has(word.toLowerCase()),
      );
    });
    expect(unknown).toEqual([]);
  });

  describe('documented gaps', () => {
    it('leaves a response row inside an open slash run without skill attributes', () => {
      const skills = new SkillActivationTracker();
      const attributor = new TurnCostAttributor();
      const slashRun = skills.recordPrompt('sess-1', 'my-skill');
      if (!slashRun) throw new Error('a slash prompt opens a run');
      attributor.recordSkillRun('sess-1', slashRun);
      const [row] = turnCostToNrEvents(attributor.recordTokenEvent(makeTokenEvent(2000)), ATTRS);
      expect(row.turn_tool_call_count).toBe(0);
      expect(row).not.toHaveProperty('skill_name');
      expect(row).not.toHaveProperty('skill_run_id');
    });

    it('sends no key that joins AiSubagentTurn to a skill or an Agent call', () => {
      const { AiSubagentTurn, AiWorkflowRun } = emittedEvents();
      expect(Object.keys(AiSubagentTurn).filter((key) => key.startsWith('skill_'))).toEqual([]);
      expect(AiWorkflowRun).not.toHaveProperty('agent_id');
      expect(AiWorkflowRun).not.toHaveProperty('input_tokens');
    });

    it('sends no skill revision on a skill run', () => {
      const { AiToolCall } = emittedEvents();
      const skillKeys = Object.keys(AiToolCall).filter((key) => key.startsWith('skill_'));
      expect(skillKeys.sort()).toEqual([
        'skill_name',
        'skill_parent_run_id',
        'skill_run_id',
        'skill_source',
      ]);
    });
  });
});
