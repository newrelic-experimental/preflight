import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDeployDashboards,
  injectAccountId,
  injectDeveloperDefault,
  escapeLuceneValue,
} from './deploy-dashboards.js';

describe('escapeLuceneValue', () => {
  it('escapes backslashes before single quotes', () => {
    expect(escapeLuceneValue('AI\\Coding')).toBe('AI\\\\Coding');
  });

  it('escapes single quotes', () => {
    expect(escapeLuceneValue("O'Brien")).toBe("O\\'Brien");
  });

  it('escapes backslash then single quote in the same string', () => {
    expect(escapeLuceneValue("a\\'b")).toBe("a\\\\\\'b");
  });

  it('leaves plain names unchanged', () => {
    expect(escapeLuceneValue('AI Coding Assistant')).toBe('AI Coding Assistant');
  });
});

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

type FetchCall = {
  url: string;
  body: { query: string; variables: Record<string, unknown> };
  headers: Record<string, string>;
};

function makeFetchMock(responses: Array<unknown>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
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

const SAMPLE_DASHBOARD = {
  name: 'Test Dashboard',
  description: 'Test',
  permissions: 'PRIVATE',
  variables: [
    {
      name: 'developer',
      type: 'NRQL',
      nrqlQuery: { accountIds: [0], query: 'SELECT uniques(developer) FROM AiToolCall' },
    },
  ],
  pages: [
    {
      name: 'Page 1',
      widgets: [
        {
          title: 'Widget A',
          layout: { column: 1, row: 1, width: 4, height: 3 },
          visualization: { id: 'viz.line' },
          rawConfiguration: {
            nrqlQueries: [{ accountIds: [0], query: 'SELECT count(*) FROM AiToolCall' }],
          },
        },
      ],
    },
  ],
};

describe('injectAccountId', () => {
  it('rewrites accountIds in widget queries', () => {
    const out = injectAccountId(SAMPLE_DASHBOARD, 999);
    expect(out.pages[0].widgets[0].rawConfiguration.nrqlQueries[0].accountIds).toEqual([999]);
  });

  it('rewrites accountIds in variable queries', () => {
    const out = injectAccountId(SAMPLE_DASHBOARD, 999);
    expect(out.variables?.[0].nrqlQuery?.accountIds).toEqual([999]);
  });

  it('does not mutate the input dashboard', () => {
    const before = JSON.stringify(SAMPLE_DASHBOARD);
    injectAccountId(SAMPLE_DASHBOARD, 999);
    expect(JSON.stringify(SAMPLE_DASHBOARD)).toBe(before);
  });
});

describe('injectDeveloperDefault', () => {
  it('sets the developer variable default value', () => {
    const dashboard = JSON.parse(JSON.stringify(SAMPLE_DASHBOARD));
    injectDeveloperDefault(dashboard, 'alice');
    expect(dashboard.variables?.[0].defaultValues).toEqual([{ value: { string: 'alice' } }]);
  });

  it('is a no-op when there are no variables', () => {
    const dashboard = { ...SAMPLE_DASHBOARD, variables: undefined };
    expect(() => injectDeveloperDefault(dashboard, 'alice')).not.toThrow();
  });
});

describe('runDeployDashboards', () => {
  let dataDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    dataDir = mkdtempSync(join(tmpdir(), 'deploy-dashboards-test-'));
    writeFileSync(join(dataDir, 'sample.json'), JSON.stringify(SAMPLE_DASHBOARD));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('--print outputs dashboard JSON with accountId injected', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    delete process.env.NEW_RELIC_API_KEY;
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: true,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/"accountIds":\s*\[\s*12345\s*\]/);
  });

  it('errors when NEW_RELIC_ACCOUNT_ID is missing', async () => {
    delete process.env.NEW_RELIC_ACCOUNT_ID;
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('NEW_RELIC_ACCOUNT_ID');
  });

  it('errors when NEW_RELIC_API_KEY is missing (deploy mode)', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    delete process.env.NEW_RELIC_API_KEY;
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('NEW_RELIC_API_KEY');
  });

  it('rejects --teardown + --update', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: true,
      teardown: true,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('mutually exclusive');
  });

  it('deploys a single dashboard via fetch mock', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      {
        data: {
          dashboardCreate: {
            entityResult: { guid: 'GUID-1', name: 'Test Dashboard' },
            errors: null,
          },
        },
      },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.newrelic.com/graphql');
    expect(calls[0].body.query).toContain('dashboardCreate');
    expect(out.text()).toContain('GUID: GUID-1');
  });

  it('--all reads every JSON file in the data dir', async () => {
    writeFileSync(
      join(dataDir, 'second.json'),
      JSON.stringify({ ...SAMPLE_DASHBOARD, name: 'Second' }),
    );
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl, calls } = makeFetchMock([
      { data: { dashboardCreate: { entityResult: { guid: 'G1', name: 'Test Dashboard' } } } },
      { data: { dashboardCreate: { entityResult: { guid: 'G2', name: 'Second' } } } },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: true,
      update: false,
      teardown: false,
      print: false,
      eu: false,
      developer: null,
      file: null,
      dataDir,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('--teardown skips when no matching dashboard is found', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl } = makeFetchMock([
      { data: { actor: { entitySearch: { results: { entities: [] } } } } },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: true,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain('No dashboard named');
  });

  it('throws when NerdGraph returns errors with null data (HTTP 200)', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl } = makeFetchMock([
      { data: null, errors: [{ message: 'Account 12345 not found' }] },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('Account 12345 not found');
  });

  it('throws when NerdGraph returns errors alongside data', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const { fetch: fetchImpl } = makeFetchMock([
      {
        data: {
          dashboardCreate: { entityResult: { guid: 'GUID-1', name: 'Test Dashboard' } },
        },
        errors: [{ message: 'Partial failure: schema validation' }],
      },
    ]);
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir,
      fetchImpl,
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('Partial failure: schema validation');
  });

  it('throws useful error if data dir does not exist', async () => {
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    process.env.NEW_RELIC_API_KEY = 'NRAK-test';
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: false,
      eu: false,
      developer: null,
      file: 'sample.json',
      dataDir: join(tmpdir(), 'definitely-does-not-exist-xyz'),
      stdout: out,
    });
    expect(code).toBe(1);
    // The deploy handler catches readFileSync ENOENT and prints "Failed:"
    expect(out.text().toLowerCase()).toMatch(/no such file|enoent/);
  });
});

describe('resolveDataDir (via runDeployDashboards default path)', () => {
  it('finds the bundled dist/data/dashboards/ at runtime', async () => {
    // This implicitly verifies that resolveDataDir() locates the data dir
    // when called from the source-tree location: src/deploy/*.ts → repo root.
    process.env.NEW_RELIC_ACCOUNT_ID = '12345';
    delete process.env.NEW_RELIC_API_KEY;
    const out = new CapturedStdout();
    const code = await runDeployDashboards({
      all: false,
      update: false,
      teardown: false,
      print: true,
      eu: false,
      developer: null,
      file: 'ai-coding-assistant-overview.json',
      // No dataDir override — exercises the resolver.
      stdout: out,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain('AI Coding Assistant');
  });
});
