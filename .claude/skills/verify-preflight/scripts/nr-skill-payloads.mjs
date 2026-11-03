// Prints the AiToolCall and AiTurnCost bodies the built emitters produce for a
// Skill call, a Read inside its run, a slash run, and a call after the run ends.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const { SkillActivationTracker } = await import(`${dist}/metrics/skill-activation-tracker.js`);
const { TurnCostAttributor } = await import(`${dist}/metrics/turn-cost-attributor.js`);
const { toolCallToNrEvent, turnCostToNrEvents } = await import(`${dist}/transport/nr-ingest.js`);

const skills = new SkillActivationTracker();
const attributor = new TurnCostAttributor();
const attrs = { developer: 'dev', appName: 'app' };
const sessionId = 'sess-1';
const events = [];

function call(toolName, timestamp, extra = {}) {
  const raw = {
    id: `r${timestamp}`,
    sessionId,
    toolName,
    toolUseId: `tu${timestamp}`,
    timestamp,
    durationMs: 10,
    success: true,
    ...extra,
  };
  const activeSkill = skills.recordToolCall(raw);
  const record = activeSkill ? { ...raw, activeSkill } : raw;
  attributor.recordToolCall(record);
  events.push(toolCallToNrEvent(record, attrs));
}

function tokens(timestamp) {
  const turn = attributor.recordTokenEvent({
    mode: 'token',
    sessionId,
    timestamp,
    inputTokens: 10000,
    outputTokens: 2000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: 'claude-sonnet-4-5-20250929',
  });
  events.push(...turnCostToNrEvents(turn, attrs));
}

skills.recordPrompt(sessionId, null);
call('Skill', 1000, { skillName: 'code-review', skillArgsLength: 1 });
call('Read', 1500, { filePath: '/x' });
tokens(2000);
skills.recordPrompt(sessionId, 'simplify');
call('Edit', 10000);
tokens(11000);
skills.recordPrompt(sessionId, null);
call('Bash', 20000, { command: 'npm test' });
tokens(21000);

const pick = (e) => ({
  eventType: e.eventType,
  tool: e.tool,
  skill_name: e.skill_name,
  skill_source: e.skill_source,
  skill_run_id: e.skill_run_id,
  cost_usd: e.cost_usd,
  has_skillName: 'skillName' in e,
});
for (const e of events) console.log(JSON.stringify(pick(e)));

const byTool = (type, tool) => events.find((e) => e.eventType === type && e.tool === tool);
assert.equal(
  byTool('AiToolCall', 'Read').skill_name,
  'code-review',
  'Read inside the run carries the skill',
);
assert.equal(
  byTool('AiToolCall', 'Read').skill_run_id,
  byTool('AiToolCall', 'Skill').skill_run_id,
  'Skill and Read share one run',
);
assert.equal(byTool('AiTurnCost', 'Edit').skill_source, 'slash', 'slash run reaches AiTurnCost');
assert.equal(byTool('AiToolCall', 'Bash').skill_name, undefined, 'run closes on the next prompt');
assert.ok(
  events.every((e) => !('skillName' in e)),
  'camelCase skillName is gone from every event',
);
console.log('ok all assertions');
