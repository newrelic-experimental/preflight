import { describe, it, expect } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
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

function retryMetricNames(captureFile: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(captureFile)) return names;
  for (const line of readFileSync(captureFile, 'utf8').split('\n')) {
    if (!line) continue;
    const { url, body } = JSON.parse(line) as { url: string; body: unknown };
    if (!url.includes('/metric/v1') || !Array.isArray(body)) continue;
    for (const group of body as Array<{ metrics: Array<{ name: string }> }>) {
      for (const m of group.metrics) if (m.name.startsWith('ai.retry.')) names.add(m.name);
    }
  }
  return names;
}

describe('stdio engine in cloud mode', () => {
  it.each([
    ['a session known at launch', true],
    ['a session adopted after launch', false],
  ])(
    'sends ai.retry.* metrics to the Metric API after repeated identical tool calls (%s)',
    async (_label, knownAtLaunch) => {
      const dist = resolve(__dirname, '..', 'dist');
      const root = mkdtempSync(join(tmpdir(), 'nr-retry-metrics-'));
      const home = join(root, 'home');
      const sid = randomUUID();
      mkdirSync(join(home, '.claude', 'projects', '-tmp-retry-metrics'), { recursive: true });
      mkdirSync(join(root, 'store'), { recursive: true });
      mkdirSync(join(root, 'job'), { recursive: true });
      writeFileSync(
        join(root, 'job', 'state.json'),
        JSON.stringify({
          linkScanPath: join(home, '.claude', 'projects', '-tmp-retry-metrics', `${sid}.jsonl`),
        }),
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
        NEW_RELIC_AI_MCP_HARVEST_METRICS_MS: '300',
        NR_AI_DASHBOARD_PORT: '0',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      };
      if (knownAtLaunch) env.CLAUDE_JOB_DIR = join(root, 'job');

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
              clientInfo: { name: 'retry-metrics-test', version: '1' },
            },
          }) + '\n',
        );
        await sleep(4000);

        for (let i = 0; i < 4; i++) {
          for (const event of ['PreToolUse', 'PostToolUse']) {
            const payload = {
              hook_event_name: event,
              session_id: sid,
              tool_name: 'Bash',
              tool_input: { command: 'npm test -- --grep flaky' },
              tool_use_id: `toolu_${sid}_${i}`,
              cwd: '/tmp/retry-metrics',
              permission_mode: 'default',
              ...(event === 'PostToolUse'
                ? { tool_response: { success: true, stdout: '', exit_code: 0 } }
                : {}),
            };
            const r = spawnSync(process.execPath, [join(dist, 'hooks', 'collector-script.js')], {
              input: JSON.stringify(payload),
              env,
            });
            expect(r.status).toBe(0);
          }
          await sleep(300);
        }

        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && retryMetricNames(captureFile).size < 2) await sleep(250);

        expect([...retryMetricNames(captureFile)].sort()).toEqual([
          'ai.retry.alerts_total',
          'ai.retry.tokens_wasted',
        ]);
      } finally {
        child.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
