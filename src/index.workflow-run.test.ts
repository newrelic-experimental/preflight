import { beforeAll, describe, it, expect } from '@jest/globals';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CAPTURE_FETCH = `
import { appendFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
globalThis.fetch = async (url, init = {}) => {
  let body = null;
  try { body = JSON.parse(gunzipSync(Buffer.from(init.body)).toString()); } catch {}
  appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({ url: String(url), body }) + '\\n');
  return new Response('{}', { status: 202 });
};
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface WorkflowRunEvent {
  eventType: string;
  workflow_run_id: string;
  started_at: number;
  tool_call_count: number;
  child_agent_count: number;
}

function workflowRuns(captureFile: string): WorkflowRunEvent[] {
  const runs: WorkflowRunEvent[] = [];
  if (!existsSync(captureFile)) return runs;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj.eventType === 'AiWorkflowRun') runs.push(obj as unknown as WorkflowRunEvent);
      else Object.values(obj).forEach(visit);
    }
  };
  for (const line of readFileSync(captureFile, 'utf8').split('\n')) {
    if (line) visit((JSON.parse(line) as { body: unknown }).body);
  }
  return runs;
}

describe('stdio engine AiWorkflowRun events', () => {
  const dist = resolve(__dirname, '..', 'dist');

  beforeAll(() => {
    if (!existsSync(join(dist, 'index.js'))) {
      execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
    }
  }, 120_000);

  it("starts the run at the Agent call's PreToolUse and counts the subagent's calls", async () => {
    const root = mkdtempSync(join(tmpdir(), 'nr-workflow-run-'));
    const home = join(root, 'home');
    const sid = randomUUID();
    const outer = 'a1111111111111111';
    const projectDir = join(home, '.claude', 'projects', '-tmp-workflow-run');
    const subagentsDir = join(projectDir, sid, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(join(root, 'store'), { recursive: true });
    mkdirSync(join(root, 'job'), { recursive: true });
    writeFileSync(
      join(root, 'job', 'state.json'),
      JSON.stringify({ linkScanPath: join(projectDir, `${sid}.jsonl`) }),
    );
    // The nested Agent call's hooks carry no agent_id, so only this
    // transcript line ties it to the outer subagent.
    writeFileSync(
      join(subagentsDir, `agent-${outer}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        sessionId: sid,
        agentId: outer,
        isSidechain: true,
        uuid: 'uuid-outer-1',
        timestamp: new Date().toISOString(),
        message: {
          id: 'msg_outer_1',
          model: 'claude-sonnet-4-5-20250929',
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Agent', input: {} }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }) + '\n',
    );
    writeFileSync(join(root, 'capture-fetch.mjs'), CAPTURE_FETCH);
    const captureFile = join(root, 'capture.jsonl');

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      NEW_RELIC_AI_MCP_STORAGE_PATH: join(root, 'store'),
      DOTENV_CONFIG_PATH: join(root, '.env'),
      NR_AI_MODE: 'cloud',
      NEW_RELIC_LICENSE_KEY: `${'a'.repeat(40)}NRAL`,
      NEW_RELIC_ACCOUNT_ID: '1234567',
      NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS: '300',
      NR_AI_DASHBOARD_PORT: '0',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_JOB_DIR: join(root, 'job'),
    };
    const hook = (
      event: 'PreToolUse' | 'PostToolUse',
      tool: string,
      toolUseId: string,
      extra: Record<string, unknown> = {},
    ): void => {
      const payload = {
        hook_event_name: event,
        session_id: sid,
        tool_name: tool,
        tool_input: tool === 'Agent' ? { description: 'research', prompt: 'go' } : {},
        tool_use_id: toolUseId,
        cwd: '/tmp/workflow-run',
        permission_mode: 'default',
        ...extra,
      };
      const r = spawnSync(process.execPath, [join(dist, 'hooks', 'collector-script.js')], {
        input: JSON.stringify(payload),
        env,
      });
      expect(r.status).toBe(0);
    };

    const child = spawn(
      process.execPath,
      ['--import', join(root, 'capture-fetch.mjs'), join(dist, 'index.js'), '--stdio'],
      { env: { ...env, CAPTURE_FILE: captureFile }, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'workflow-run-test', version: '1' },
          },
        }) + '\n',
      );
      await sleep(4000);

      const beforePre = Date.now();
      hook('PreToolUse', 'Agent', 'toolu_outer');
      const afterPre = Date.now();
      await sleep(300);
      hook('PreToolUse', 'Read', 'toolu_read', { agent_id: outer });
      hook('PostToolUse', 'Read', 'toolu_read', { agent_id: outer, tool_response: {} });
      hook('PreToolUse', 'Agent', 'toolu_inner');
      hook('PostToolUse', 'Agent', 'toolu_inner', {
        tool_response: { agentId: 'a2222222222222222', content: [{ type: 'text', text: 'ok' }] },
      });
      await sleep(300);
      hook('PostToolUse', 'Agent', 'toolu_outer', {
        tool_response: { agentId: outer, content: [{ type: 'text', text: 'done' }] },
      });

      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        !workflowRuns(captureFile).some((r) => r.workflow_run_id === 'toolu_outer')
      ) {
        await sleep(250);
      }
      await sleep(1000);

      const outerRuns = workflowRuns(captureFile).filter(
        (r) => r.workflow_run_id === 'toolu_outer',
      );
      expect(outerRuns).toHaveLength(1);
      expect(outerRuns[0]?.tool_call_count).toBe(1);
      expect(outerRuns[0]?.child_agent_count).toBe(1);
      expect(outerRuns[0]?.started_at).toBeGreaterThanOrEqual(beforePre);
      expect(outerRuns[0]?.started_at).toBeLessThanOrEqual(afterPre);
    } finally {
      child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
