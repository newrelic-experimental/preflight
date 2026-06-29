import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDeployAlerts,
  loadDefinitions,
  loadPersonalDefinitions,
  buildConditionInput,
} from './deploy-alerts.js';
import type { PersonalAlertThresholds } from '../alerts/types.js';

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

type FetchCall = {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
};

function makeFetchMock(responses: Array<unknown>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const next = responses[i++] ?? { data: {} };
    const mock: MockResponse = {
      ok: true,
      status: 200,
      json: async () => next,
      text: async () => JSON.stringify(next),
    };
    return mock as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

class CapturedStdout {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  text(): string {
    return this.chunks.join('');
  }
}

const SAMPLE_POLICY = {
  name: 'Test Alerts',
  incidentPreference: 'PER_CONDITION' as const,
};

const SAMPLE_CONDITION = {
  name: 'Test Condition',
  description: 'Test',
  enabled: true,
  nrqlQuery: 'SELECT count(*) FROM AiToolCall',
  aggregationMethod: 'EVENT_FLOW' as const,
  aggregationWindow: 60,
  aggregationDelay: 30,
  thresholdOperator: 'ABOVE' as const,
  thresholdCritical: {
    value: 5,
    duration: 60,
    occurrences: 'ALL' as const,
  },
  violationTimeLimitSeconds: 86400,
};

const PERSONAL_THRESHOLDS: PersonalAlertThresholds = {
  dailyCostUsd: 2,
  sessionCostUsd: 0.5,
  efficiencyScoreMin: 0.4,
  stuckLoopCountMax: 2,
  antiPatternCountMax: 5,
};

function buildAlertsFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-alerts-test-'));
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(SAMPLE_POLICY));
  mkdirSync(join(dir, 'conditions'));
  writeFileSync(join(dir, 'conditions', '01-test.json'), JSON.stringify(SAMPLE_CONDITION));
  mkdirSync(join(dir, 'conditions-personal'));
  // Personal conditions use {{developer}} and threshold placeholders.
  const personalCondition = {
    ...SAMPLE_CONDITION,
    name: 'Personal Condition for {{developer}}',
    nrqlQuery: "SELECT count(*) FROM AiToolCall WHERE developer = '{{developer}}'",
    thresholdCritical: {
      value: '__dailyCostUsd__',
      duration: 60,
      occurrences: 'ALL',
    },
  };
  writeFileSync(
    join(dir, 'conditions-personal', '01-personal.json'),
    JSON.stringify(personalCondition),
  );
  return dir;
}

describe('loadDefinitions', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = buildAlertsFixture();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads policy.json + every JSON in conditions/', () => {
    const { policy, conditions } = loadDefinitions(dataDir);
    expect(policy.name).toBe('Test Alerts');
    expect(conditions).toHaveLength(1);
    expect(conditions[0].name).toBe('Test Condition');
  });
});

describe('loadPersonalDefinitions', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = buildAlertsFixture();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('substitutes developer + threshold placeholders', () => {
    const { policy, conditions } = loadPersonalDefinitions(dataDir, 'alice', PERSONAL_THRESHOLDS);
    expect(policy.name).toBe('AI Coding — Personal — alice');
    expect(conditions[0].name).toBe('Personal Condition for alice');
    expect(conditions[0].nrqlQuery).toContain("developer = 'alice'");
    expect(conditions[0].thresholdCritical.value).toBe(2);
  });
});

describe('buildConditionInput', () => {
  it('translates AlertConditionDefinition to NerdGraph input', () => {
    const input = buildConditionInput(SAMPLE_CONDITION);
    expect(input.name).toBe('Test Condition');
    expect((input.signal as Record<string, unknown>).aggregationMethod).toBe('EVENT_FLOW');
    const terms = input.terms as Array<Record<string, unknown>>;
    expect(terms).toHaveLength(1);
    expect(terms[0].priority).toBe('CRITICAL');
    expect(terms[0].threshold).toBe(5);
  });

  it('appends a WARNING term when thresholdWarning is set', () => {
    const cond = {
      ...SAMPLE_CONDITION,
      thresholdWarning: { value: 3, duration: 60, occurrences: 'ALL' as const },
    };
    const input = buildConditionInput(cond);
    const terms = input.terms as Array<Record<string, unknown>>;
    expect(terms).toHaveLength(2);
    expect(terms[1].priority).toBe('WARNING');
    expect(terms[1].threshold).toBe(3);
  });
});

describe('runDeployAlerts', () => {
  let dataDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    dataDir = buildAlertsFixture();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('--dry-run prints policy + conditions without hitting the API', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    delete process.env.NEW_RELIC_API_KEY;
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: true,
      teardown: false,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      stdout: out,
    });
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain('--- Dry run: would create policy ---');
    expect(text).toContain('Test Alerts');
    expect(text).toContain('Test Condition');
  });

  it('errors when NEW_RELIC_ACCOUNT_ID is missing', async () => {
    delete process.env.NEW_RELIC_ACCOUNT_ID;
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('NEW_RELIC_ACCOUNT_ID');
  });

  it('rejects negative NEW_RELIC_ACCOUNT_ID', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '-1';
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/account/i);
  });

  it('rejects partial-parse NEW_RELIC_ACCOUNT_ID (123abc)', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '123abc';
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/account/i);
  });

  it('errors when NEW_RELIC_API_KEY is missing (non-dry-run)', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    delete process.env.NEW_RELIC_API_KEY;
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('NEW_RELIC_API_KEY');
  });

  it('rejects --dry-run + --teardown', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: true,
      teardown: true,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('mutually exclusive');
  });

  it('creates policy + conditions on first deploy', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      // policiesSearch — none exist
      {
        data: {
          actor: {
            account: { alerts: { policiesSearch: { policies: [] } } },
          },
        },
      },
      // policyCreate
      { data: { alertsPolicyCreate: { id: 'POL-1', name: 'Test Alerts' } } },
      // condition create
      {
        data: {
          alertsNrqlConditionStaticCreate: {
            id: 'COND-1',
            name: 'Test Condition',
            enabled: true,
          },
        },
      },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[1].body.query).toContain('alertsPolicyCreate');
    expect(calls[2].body.query).toContain('alertsNrqlConditionStaticCreate');
    expect(out.text()).toContain('Created policy');
    expect(out.text()).toContain('Created condition');
  });

  it('skips when policy already exists (idempotent deploy)', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      {
        data: {
          actor: {
            account: {
              alerts: {
                policiesSearch: {
                  policies: [{ id: 'POL-EXISTING', name: 'Test Alerts' }],
                },
              },
            },
          },
        },
      },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out.text()).toContain('already exists');
  });

  it('--teardown deletes the policy', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      {
        data: {
          actor: {
            account: {
              alerts: {
                policiesSearch: {
                  policies: [{ id: 'POL-X', name: 'Test Alerts' }],
                },
              },
            },
          },
        },
      },
      { data: { alertsPolicyDelete: { id: 'POL-X' } } },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: true,
      update: false,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.query).toContain('alertsPolicyDelete');
    expect(out.text()).toContain('Deleted policy');
  });

  it('--developer creates a personal policy with substituted thresholds', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      {
        data: {
          actor: {
            account: { alerts: { policiesSearch: { policies: [] } } },
          },
        },
      },
      {
        data: {
          alertsPolicyCreate: {
            id: 'POL-PERSONAL',
            name: 'AI Coding — Personal — alice',
          },
        },
      },
      {
        data: {
          alertsNrqlConditionStaticCreate: {
            id: 'COND-A',
            name: 'Personal Condition for alice',
            enabled: true,
          },
        },
      },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: false,
      developer: 'alice',
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(calls[1].body.variables.name).toBe('AI Coding — Personal — alice');
    expect(out.text()).toContain('Personal — alice');
  });

  it('--update on missing policy returns error', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl } = makeFetchMock([
      {
        data: {
          actor: {
            account: { alerts: { policiesSearch: { policies: [] } } },
          },
        },
      },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: true,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('No policy named');
  });

  it('--update syncs existing conditions in place', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      // policiesSearch
      {
        data: {
          actor: {
            account: {
              alerts: {
                policiesSearch: {
                  policies: [{ id: 'POL-1', name: 'Test Alerts' }],
                },
              },
            },
          },
        },
      },
      // listConditions: existing condition by same name
      {
        data: {
          actor: {
            account: {
              alerts: {
                nrqlConditionsSearch: {
                  nrqlConditions: [{ id: 'C-EXISTING', name: 'Test Condition' }],
                },
              },
            },
          },
        },
      },
      // conditionUpdate
      {
        data: {
          alertsNrqlConditionStaticUpdate: {
            id: 'C-EXISTING',
            name: 'Test Condition',
            enabled: true,
          },
        },
      },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: true,
      eu: false,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[2].body.query).toContain('alertsNrqlConditionStaticUpdate');
    expect(out.text()).toContain('Updating condition');
  });

  it('--eu targets EU API URL', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      {
        data: {
          actor: {
            account: { alerts: { policiesSearch: { policies: [] } } },
          },
        },
      },
      { data: { alertsPolicyCreate: { id: 'POL-1', name: 'Test Alerts' } } },
      {
        data: {
          alertsNrqlConditionStaticCreate: {
            id: 'C',
            name: 'Test Condition',
            enabled: true,
          },
        },
      },
    ]);
    const out = new CapturedStdout();
    await runDeployAlerts({
      dryRun: false,
      teardown: false,
      update: false,
      eu: true,
      developer: null,
      dataDir,
      personalThresholdsOverride: PERSONAL_THRESHOLDS,
      fetchImpl,
      stdout: out,
    });
    expect(calls[0].url).toBe('https://api.eu.newrelic.com/graphql');
  });
});
