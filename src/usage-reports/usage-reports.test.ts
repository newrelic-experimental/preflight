import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  EVENT_PROPERTIES,
  EVENTS,
  FEATURES,
  MAX_UNANSWERED_PROMPTS,
  NEVER_SENT,
  REPORT_SUMMARY,
  SHOW_COMMAND,
} from './constants.js';
import { buildPreview } from './preview.js';
import { UsageCounters } from './counters.js';
import { buildEvent } from './events.js';
import { runReportTick, type ReportInputs } from './reporter.js';
import { resolveUsageReports } from './resolve.js';
import { UsageReportSender, type FetchFn } from './sender.js';
import {
  getOrCreateInstallId,
  mayPrompt,
  readConsent,
  readInstallId,
  recordAnswer,
  recordDismissed,
} from './state.js';
import { ANSWER_MESSAGES, askInTerminal, terminalSummary } from './wizard.js';
import { runUsageReportsCli } from './cli.js';
import { UsageReportsService } from './service.js';
import type { McpServerConfig } from '../config.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { consentSelect } from './consent-prompt.js';

const CANCEL = Symbol('clack:cancel');
jest.mock('@clack/prompts', () => ({
  note: jest.fn(),
  isCancel: (v: unknown) => v === CANCEL,
}));
jest.mock('./consent-prompt.js', () => ({ consentSelect: jest.fn() }));
const mockSelect = consentSelect as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

let dir: string;
let home: string;
const ENV_KEYS = [
  'HOME',
  'NEW_RELIC_AI_MCP_STORAGE_PATH',
  'CI',
  'GITHUB_ACTIONS',
  'DO_NOT_TRACK',
  'NEW_RELIC_AI_USAGE_REPORTS',
  'CLAUDE_CODE_ENTRYPOINT',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  home = mkdtempSync(join(tmpdir(), 'usage-reports-'));
  dir = join(home, '.newrelic-preflight', 'usage-reports');
  for (const k of ENV_KEYS) delete process.env[k];
  // Jest's process.env doesn't reach os.homedir(), so point storage here explicitly.
  process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = join(home, '.newrelic-preflight');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const unasked = () => readConsent(dir);

function makeInputs(): ReportInputs {
  return {
    install: {
      version: '1.0.0',
      os: 'darwin',
      arch: 'arm64',
      node_major: 22,
      adapter: 'claude-code',
      install_channel: 'npm',
      mode: 'local',
      hooks_installed: true,
    },
    features: Object.fromEntries(FEATURES.map((f) => [f, false])) as ReportInputs['features'],
  };
}

function makeSender(fetchFn: FetchFn, debug = false): UsageReportSender {
  return new UsageReportSender({ dir, debug, fetchFn, stderr: () => undefined });
}

const identity = () => ({
  installId: getOrCreateInstallId(dir),
  sessionId: '00000000-0000-4000-8000-000000000000',
  fieldListVersion: 1,
});

describe('resolveUsageReports', () => {
  it('is unasked and off with nothing set', () => {
    expect(
      resolveUsageReports({
        highSecurity: false,
        configValue: undefined,
        consent: unasked(),
        env: {},
      }),
    ).toEqual({
      enabled: false,
      reason: 'unasked',
    });
  });

  it('applies the rules in order', () => {
    recordAnswer(dir, 'yes', 'cli_enable');
    const consent = readConsent(dir);
    const r = (env: NodeJS.ProcessEnv, highSecurity = false, configValue?: boolean) =>
      resolveUsageReports({ highSecurity, configValue, consent, env }).reason;
    expect(r({ NEW_RELIC_AI_USAGE_REPORTS: 'true' }, true)).toBe('high_security');
    expect(r({ DO_NOT_TRACK: '1', NEW_RELIC_AI_USAGE_REPORTS: 'true' })).toBe('do_not_track');
    expect(r({ NEW_RELIC_AI_USAGE_REPORTS: 'true', CI: 'true' })).toBe('env');
    expect(r({ GITHUB_ACTIONS: 'true' }, false, true)).toBe('ci');
    expect(r({}, false, false)).toBe('config');
    expect(r({})).toBe('answer');
  });
});

describe('consent state', () => {
  it('creates the install ID only on yes, and "no" deletes it, queued data and the sent log', () => {
    expect(readInstallId(dir)).toBeNull();
    recordAnswer(dir, 'yes', 'setup_wizard');
    expect(readInstallId(dir)).toMatch(/^[0-9a-f-]{36}$/);
    mkdirSync(join(dir, 'pending'), { recursive: true });
    writeFileSync(join(dir, 'pending', 'x.json'), '{}');
    writeFileSync(join(dir, 'sent.log'), '{"event":{"anonymousId":"x"}}\n');
    recordAnswer(dir, 'no', 'dashboard_banner');
    expect(readInstallId(dir)).toBeNull();
    expect(existsSync(join(dir, 'pending'))).toBe(false);
    expect(existsSync(join(dir, 'sent.log'))).toBe(false);
    expect(readConsent(dir)).toMatchObject({ answer: 'no', answerSurface: 'dashboard_banner' });
  });

  it('stops asking after the unanswered-prompt limit', () => {
    for (let i = 0; i < MAX_UNANSWERED_PROMPTS; i++) {
      expect(mayPrompt(readConsent(dir))).toBe(true);
      recordDismissed(dir, 'tool_call_form');
    }
    expect(mayPrompt(readConsent(dir))).toBe(false);
  });
});

describe('buildEvent', () => {
  it('keeps only listed properties and never adds context', () => {
    const e = buildEvent(
      EVENTS.tool,
      {
        preflight_usage_date: '2026-11-01',
        preflight_tool_name: 'x',
        preflight_call_count: 2,
        path: '/etc',
        secret: 'nope',
      },
      identity(),
    );
    expect(e).not.toHaveProperty('context');
    expect(Object.keys(e.properties).sort()).toEqual(
      [
        'preflight_call_count',
        'event_type',
        'path',
        'platform',
        'section',
        'session_id',
        'preflight_tool_name',
        'preflight_usage_date',
      ].sort(),
    );
    expect(e.properties.path).toBe('/preflight/usage-reports');
  });

  it('drops fields newer than the consented field list', () => {
    const e = buildEvent(
      EVENTS.usage,
      { preflight_usage_date: '2026-11-01', preflight_sessions_observed: 1 },
      { ...identity(), fieldListVersion: 0 },
    );
    expect(e.properties).not.toHaveProperty('preflight_sessions_observed');
  });

  it('lists properties for every event', () => {
    for (const name of Object.values(EVENTS))
      expect(Object.keys(EVENT_PROPERTIES[name]).length).toBeGreaterThan(0);
  });
});

describe('runReportTick', () => {
  const ok: FetchFn = async () => ({ ok: true, status: 200 });

  it('sends the start report once a day across processes', async () => {
    recordAnswer(dir, 'yes', 'cli_enable');
    const calls: string[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      calls.push(JSON.parse(String(init.body)).event);
      return { ok: true, status: 200 };
    };
    const now = new Date('2026-11-02T12:00:00Z');
    const a = await runReportTick(dir, makeSender(fetchFn), makeInputs(), identity(), { now });
    const b = await runReportTick(dir, makeSender(fetchFn), makeInputs(), identity(), { now });
    expect(a.startReportSent).toBe(true);
    expect(b.startReportSent).toBe(false);
    expect(calls.filter((c) => c === EVENTS.install)).toHaveLength(1);
    expect(calls.filter((c) => c === EVENTS.feature)).toHaveLength(FEATURES.length);
  });

  it('summarizes a completed day from every process and deletes its pending files', async () => {
    recordAnswer(dir, 'yes', 'cli_enable');
    const day = () => new Date('2026-11-01T10:00:00Z');
    for (const sid of [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]) {
      const c = new UsageCounters(dir, sid, false, day);
      c.recordToolCall('nr_observe_health');
      c.recordPageLoad();
      c.flush();
    }
    const bodies: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200 };
    };
    const r = await runReportTick(dir, makeSender(fetchFn), makeInputs(), identity(), {
      now: new Date('2026-11-02T01:00:00Z'),
    });
    expect(r.summariesSent).toEqual(['2026-11-01']);
    expect(
      bodies.find((b) => b.event === EVENTS.usage)?.properties.preflight_sessions_observed,
    ).toBe(2);
    expect(bodies.find((b) => b.event === EVENTS.tool)?.properties.preflight_call_count).toBe(2);
    expect(bodies.find((b) => b.event === EVENTS.dashboard)?.properties.preflight_page_loads).toBe(
      2,
    );
    expect(
      existsSync(join(dir, 'pending', '2026-11-01-11111111-1111-4111-8111-111111111111.json')),
    ).toBe(false);
  });

  it('releases the claim when a send fails so the next pass retries', async () => {
    recordAnswer(dir, 'yes', 'cli_enable');
    const now = new Date('2026-11-02T12:00:00Z');
    const fail: FetchFn = async () => ({ ok: false, status: 503 });
    expect(
      (await runReportTick(dir, makeSender(fail), makeInputs(), identity(), { now }))
        .startReportSent,
    ).toBe(false);
    expect(
      (await runReportTick(dir, makeSender(ok), makeInputs(), identity(), { now })).startReportSent,
    ).toBe(true);
  });

  it('debug mode sends nothing and leaves the real report to go out', async () => {
    recordAnswer(dir, 'yes', 'cli_enable');
    const fetchFn = jest.fn(ok);
    const now = new Date('2026-11-02T12:00:00Z');
    await runReportTick(dir, makeSender(fetchFn, true), makeInputs(), identity(), { now });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      (await runReportTick(dir, makeSender(ok), makeInputs(), identity(), { now })).startReportSent,
    ).toBe(true);
    expect(readFileSync(join(dir, 'sent.log'), 'utf-8')).toContain(EVENTS.install);
  });
});

describe('askInTerminal', () => {
  it('offers Yes first and records each choice', async () => {
    mockSelect.mockResolvedValueOnce('dismissed');
    expect(await askInTerminal('cli_enable', dir)).toBe('dismissed');
    expect(mockSelect.mock.calls[0]?.[0]).toMatchObject({ options: [{ value: 'yes' }, {}, {}] });
    expect(readConsent(dir)).toMatchObject({ answer: null, unansweredPrompts: 1 });

    mockSelect.mockResolvedValueOnce(CANCEL);
    expect(await askInTerminal('cli_enable', dir)).toBe('dismissed');
    expect(readConsent(dir).unansweredPrompts).toBe(2);

    mockSelect.mockResolvedValueOnce('yes');
    expect(await askInTerminal('setup_wizard', dir)).toBe('yes');
    expect(readConsent(dir)).toMatchObject({ answer: 'yes', answerSurface: 'setup_wizard' });
    expect(readInstallId(dir)).not.toBeNull();
  });
});

describe('UsageReportsService.askWithForm', () => {
  const makeService = () =>
    new UsageReportsService({
      config: {
        storagePath: join(home, '.newrelic-preflight'),
        highSecurity: false,
        usageReports: undefined,
        dashboard: { openOnStart: false },
      } as unknown as McpServerConfig,
      adapterName: () => 'claude-code',
      hooksInstalled: () => true,
    });
  const makeServer = (answer: () => Promise<{ action: string; content?: object }>) =>
    ({
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: answer,
    }) as unknown as Server;

  it("doesn't count a form the client cancelled without showing it", async () => {
    const outcome = await makeService().askWithForm(
      makeServer(async () => ({ action: 'cancel' })),
      'session_start_form',
    );
    expect(outcome).toBe('not_shown');
    expect(readConsent(dir).unansweredPrompts).toBe(0);
  });

  it('counts a cancel that took a person long enough to read the form', async () => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => t0);
    const outcome = await makeService().askWithForm(
      makeServer(async () => {
        jest.spyOn(Date, 'now').mockImplementation(() => t0 + 5_000);
        return { action: 'cancel' };
      }),
      'session_start_form',
    );
    expect(outcome).toBe('dismissed');
    expect(readConsent(dir).unansweredPrompts).toBe(1);
  });

  it('asks in four lines that fit an 80-column terminal', async () => {
    const elicit = jest.fn(async (_req: { message: string }) => ({ action: 'cancel' }));
    await makeService().askWithForm(makeServer(elicit as never), 'tool_call_form');
    const lines = elicit.mock.calls[0]?.[0].message.split('\n') ?? [];
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
    expect(lines[2]).toContain(SHOW_COMMAND);
    expect(lines[3]).toMatch(/^https:\/\/github\.com\/.+\/blob\/v[^/]+\/PRIVACY\.md$/);
  });

  it("doesn't record an instant Accept, which no one could have read", async () => {
    const outcome = await makeService().askWithForm(
      makeServer(async () => ({ action: 'accept' })),
      'tool_call_form',
    );
    expect(outcome).toBe('not_shown');
    expect(readConsent(dir).answer).toBeNull();
  });

  it.each([
    ['accept', 'yes'],
    ['decline', 'no'],
  ])('records %s as %s once a person has had time to read the form', async (action, answer) => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => t0);
    const outcome = await makeService().askWithForm(
      makeServer(async () => {
        jest.spyOn(Date, 'now').mockImplementation(() => t0 + 5_000);
        return { action };
      }),
      'tool_call_form',
    );
    expect(outcome).toBe(answer);
    expect(readConsent(dir).answer).toBe(answer);
  });

  it.each([
    [299, 'not_shown', null],
    [300, 'yes', 'yes'],
  ])('treats an Accept after %ims as %s', async (elapsedMs, outcome, answer) => {
    const t0 = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => t0);
    const result = await makeService().askWithForm(
      makeServer(async () => {
        jest.spyOn(Date, 'now').mockImplementation(() => t0 + elapsedMs);
        return { action: 'accept' };
      }),
      'tool_call_form',
    );
    expect(result).toBe(outcome);
    expect(readConsent(dir).answer).toBe(answer);
  });

  it('opens the form at startup on its own, retrying while the client cancels instantly', async () => {
    jest.useFakeTimers();
    try {
      const elicit = jest
        .fn<() => Promise<{ action: string; content?: object }>>()
        .mockResolvedValueOnce({ action: 'cancel' })
        .mockImplementationOnce(async () => {
          jest.setSystemTime(Date.now() + 5_000);
          return { action: 'decline' };
        });
      makeService().askWhenClientIsReady(makeServer(elicit), [100, 200, 300]);
      await jest.advanceTimersByTimeAsync(99);
      expect(elicit).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(elicit).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(elicit).toHaveBeenCalledTimes(2);
      expect(readConsent(dir)).toMatchObject({ answer: 'no', answerSurface: 'session_start_form' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks once per session: no startup form after a tool call opened one', async () => {
    jest.useFakeTimers();
    try {
      // Still open when the startup timer fires; a person answers after five seconds.
      const elicit = jest.fn(
        () =>
          new Promise<{ action: string }>((resolve) =>
            setTimeout(() => resolve({ action: 'accept' }), 5_000),
          ),
      );
      const service = makeService();
      const server = makeServer(elicit);
      service.maybeAskAtToolCall(server);
      service.askWhenClientIsReady(server, [100]);
      await jest.advanceTimersByTimeAsync(6_000);
      expect(elicit).toHaveBeenCalledTimes(1);
      expect(readConsent(dir).answer).toBe('yes');
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks again after a tool-call form the client cancelled without showing it', async () => {
    jest.useFakeTimers();
    try {
      const elicit = jest
        .fn<() => Promise<{ action: string; content?: object }>>()
        .mockResolvedValueOnce({ action: 'cancel' })
        .mockImplementationOnce(async () => {
          jest.setSystemTime(Date.now() + 5_000);
          return { action: 'decline' };
        });
      const service = makeService();
      const server = makeServer(elicit);
      service.maybeAskAtToolCall(server);
      await jest.advanceTimersByTimeAsync(0);
      service.askWhenClientIsReady(server, [100]);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(elicit).toHaveBeenCalledTimes(2);
      expect(readConsent(dir)).toMatchObject({ answer: 'no', answerSurface: 'session_start_form' });
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips the desktop app, which can't show forms", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop-3p';
    const elicit = jest.fn(async () => ({ action: 'cancel' }));
    expect(await makeService().askWithForm(makeServer(elicit), 'tool_call_form')).toBe(
      'unsupported',
    );
    expect(elicit).not.toHaveBeenCalled();
  });
});

describe('preflight usage-reports disable', () => {
  const run = async (args: string[]): Promise<{ code: number; out: string }> => {
    let out = '';
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    const code = await runUsageReportsCli(args);
    return { code, out };
  };

  it('turns reports off and deletes the install ID', async () => {
    recordAnswer(dir, 'yes', 'cli_enable');
    const { code } = await run(['disable']);
    expect(code).toBe(0);
    expect(readConsent(dir).answer).toBe('no');
    expect(readInstallId(dir)).toBeNull();
  });

  it('refuses when an env var turned reports on, since a "no" would be ignored', async () => {
    process.env.NEW_RELIC_AI_USAGE_REPORTS = 'true';
    const { code, out } = await run(['disable']);
    expect(code).toBe(1);
    expect(out).toContain('NEW_RELIC_AI_USAGE_REPORTS');
    expect(readConsent(dir).answer).toBeNull();
  });
});

describe('PRIVACY.md', () => {
  // PRIVACY.md promises to list every field a report can carry; this keeps it true.
  const privacy = readFileSync(join(__dirname, '..', '..', 'PRIVACY.md'), 'utf-8');

  it('lists exactly the events and fields the code can send', () => {
    const rows = privacy
      .split('\n')
      .filter((line) => /^\| `preflight\//.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()));
    const documented = Object.fromEntries(
      rows.map(([, event, fields]) => [
        event?.replace(/`/g, ''),
        // Field names are the code spans outside parentheses; spans inside are example values.
        [...(fields ?? '').replace(/\([^)]*\)/g, '').matchAll(/`([^`]+)`/g)]
          .map((m) => m[1])
          .sort(),
      ]),
    );
    const inCode = Object.fromEntries(
      Object.entries(EVENT_PROPERTIES).map(([event, props]) => [event, Object.keys(props).sort()]),
    );
    expect(documented).toEqual(inCode);
  });
});

describe('what the prompts show', () => {
  it('lists every line of the report, what is never sent, and where to check', () => {
    const text = terminalSummary('1.2.3');
    for (const line of REPORT_SUMMARY) expect(text).toContain(line);
    expect(text).toContain(NEVER_SENT);
    expect(text).toContain(
      'https://github.com/newrelic-experimental/preflight/blob/v1.2.3/PRIVACY.md#usage-reports-opt-in',
    );
    expect(text).toContain(SHOW_COMMAND);
  });

  it('has one summary line per event, plus the install ID', () => {
    expect(REPORT_SUMMARY).toHaveLength(Object.keys(EVENT_PROPERTIES).length + 1);
  });

  it('points to the show command once someone says yes', () => {
    expect(ANSWER_MESSAGES.yes).toContain(SHOW_COMMAND);
  });
});

describe('buildPreview', () => {
  it('shows the next start report, queued days and recent sends', async () => {
    recordAnswer(dir, 'yes', 'cli_enable');
    const counters = new UsageCounters(dir, identity().sessionId, false);
    counters.recordToolCall('nr_observe_health');
    counters.flush();
    await runReportTick(
      dir,
      makeSender(async () => ({ ok: true, status: 200 })),
      makeInputs(),
      identity(),
    );

    const preview = buildPreview(dir, makeInputs());
    expect(preview.start.map((e) => e.event)).toContain(EVENTS.install);
    expect(preview.start[0]?.anonymousId).toBe(readInstallId(dir));
    expect(preview.queued).toHaveLength(1);
    expect(preview.queued[0]).toMatchObject({ today: true });
    expect(preview.queued[0]?.events.map((e) => e.event)).toContain(EVENTS.tool);
    expect(preview.sentTotal).toBeGreaterThan(0);
    expect(preview.sent.at(-1)?.event.event).toBeDefined();
  });

  it('shows a placeholder install ID before reports are turned on', () => {
    const preview = buildPreview(dir, makeInputs());
    expect(preview.start[0]?.anonymousId).toBe('<created when usage reports are turned on>');
    expect(preview).toMatchObject({ queued: [], sent: [], sentTotal: 0 });
  });
});
