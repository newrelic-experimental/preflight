// Prints the AiToolCall and AiTurnCost bodies the built emitters produce for a
// Skill call, a Read inside its run, a slash run, a call after the run ends,
// and text-only replies that a following prompt cuts across, in both drain
// orders (the report read before or after the prompt).
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

// Reads a token report stamped with its transcript timestamp, as index.ts does,
// so the run comes from the time the reply was written, not the drain time.
function tokens(timestamp, sid = sessionId) {
  const turn = attributor.recordTokenEvent(
    {
      mode: 'token',
      sessionId: sid,
      timestamp,
      inputTokens: 10000,
      outputTokens: 2000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'claude-sonnet-4-5-20250929',
    },
    skills.runAt(sid, timestamp),
  );
  const rows = turnCostToNrEvents(turn, attrs);
  events.push(...rows);
  return rows;
}

// A text-only reply written at replyAt, then a prompt at promptAt that closes
// its run or opens a slash run. promptDrainsFirst picks the drain order: the
// prompt is read before the reply's report (the transcript poll lags by up to
// 2 s), or after it (the usual order).
function replyThenPrompt(sid, { replyAt, promptAt, command, promptDrainsFirst }) {
  if (promptDrainsFirst) {
    skills.recordPrompt(sid, command, promptAt);
    return tokens(replyAt, sid);
  }
  const rows = tokens(replyAt, sid);
  skills.recordPrompt(sid, command, promptAt);
  return rows;
}

skills.recordPrompt(sessionId, null, 500);
call('Skill', 1000, { skillName: 'code-review', skillArgsLength: 1 });
call('Read', 1500, { filePath: '/x' });
tokens(2000);
skills.recordPrompt(sessionId, 'simplify', 9000);
call('Edit', 10000);
tokens(11000);
skills.recordPrompt(sessionId, null, 19000);
call('Bash', 20000, { command: 'npm test' });
tokens(21000);

const plainPromptFirst = 'sess-2';
skills.recordPrompt(plainPromptFirst, 'review', 30000);
const plainReplyPromptFirst = replyThenPrompt(plainPromptFirst, {
  replyAt: 31000,
  promptAt: 32000,
  command: null,
  promptDrainsFirst: true,
});
const plainAfterPromptFirst = tokens(40000, plainPromptFirst);

const plainTokenFirst = 'sess-3';
skills.recordPrompt(plainTokenFirst, 'review', 30000);
const plainReplyTokenFirst = replyThenPrompt(plainTokenFirst, {
  replyAt: 31000,
  promptAt: 32000,
  command: null,
  promptDrainsFirst: false,
});
tokens(40000, plainTokenFirst);

const slashPromptFirst = 'sess-4';
skills.recordPrompt(slashPromptFirst, null, 50000);
const slashReplyPromptFirst = replyThenPrompt(slashPromptFirst, {
  replyAt: 51000,
  promptAt: 52000,
  command: 'simplify',
  promptDrainsFirst: true,
});
const slashAfterPromptFirst = tokens(53000, slashPromptFirst);

const slashTokenFirst = 'sess-5';
skills.recordPrompt(slashTokenFirst, null, 50000);
const slashReplyTokenFirst = replyThenPrompt(slashTokenFirst, {
  replyAt: 51000,
  promptAt: 52000,
  command: 'simplify',
  promptDrainsFirst: false,
});
tokens(53000, slashTokenFirst);

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
const onlyRow = (rows) => {
  assert.equal(rows.length, 1, 'a text-only reply yields one AiTurnCost row');
  return rows[0];
};
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

const plainRows = [onlyRow(plainReplyPromptFirst), onlyRow(plainReplyTokenFirst)];
assert.deepEqual(
  plainRows.map((e) => e.skill_name),
  ['review', 'review'],
  'a reply before a plain prompt keeps the run it was written in, whichever drains first',
);
assert.ok(
  plainRows.every((e) => typeof e.skill_run_id === 'string'),
  'a stamped reply carries its run id',
);
assert.equal(
  onlyRow(plainAfterPromptFirst).skill_name,
  undefined,
  'a reply after the plain prompt has no run',
);

const slashRows = [onlyRow(slashReplyPromptFirst), onlyRow(slashReplyTokenFirst)];
assert.deepEqual(
  slashRows.map((e) => e.skill_name),
  [undefined, undefined],
  'a reply before a /simplify prompt does not take its stamp, whichever drains first',
);
assert.equal(
  onlyRow(slashAfterPromptFirst).skill_name,
  'simplify',
  'a reply after a /simplify prompt takes its run',
);
assert.equal(
  onlyRow(slashAfterPromptFirst).skill_source,
  'slash',
  'the slash run reaches the reply that follows it',
);
assert.ok(
  events.every((e) => !('skillName' in e)),
  'camelCase skillName is gone from every event',
);
console.log('ok all assertions');
