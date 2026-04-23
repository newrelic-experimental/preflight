import { init, NrAiAgent } from './agent.js';

// Mock the transport so no real HTTP calls are made
jest.mock('@nr-ai-observatory/shared', () => {
  const actual = jest.requireActual<typeof import('@nr-ai-observatory/shared')>(
    '@nr-ai-observatory/shared',
  );
  return {
    ...actual,
    sendEvents: jest.fn().mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 }),
    sendMetrics: jest.fn().mockResolvedValue({ success: true, statusCode: 200, retryCount: 0 }),
  };
});

let stderrSpy: ReturnType<typeof jest.spyOn>;

const validConfig = {
  licenseKey: 'test-license-key-1234567890abcdef',
  appName: 'test-app',
  accountId: '12345',
};

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  // Always try to clean up the singleton
  try {
    const agent = (init as any).__lastInstance;
  } catch {
    // ignore
  }
  stderrSpy.mockRestore();
});

describe('init()', () => {
  // ---------------------------------------------------------------------------
  // 1. Returns NrAiAgent with all expected methods
  // ---------------------------------------------------------------------------
  it('returns NrAiAgent with all expected methods', async () => {
    const agent = await init(validConfig);

    expect(agent).toBeInstanceOf(NrAiAgent);
    expect(typeof agent.wrapAnthropicClient).toBe('function');
    expect(typeof agent.wrapGeminiClient).toBe('function');
    expect(typeof agent.shutdown).toBe('function');
    expect(typeof agent.getStats).toBe('function');

    await agent.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 2. Missing license key rejects with clear error
  // ---------------------------------------------------------------------------
  it('rejects when license key is missing', async () => {
    const savedKey = process.env.NEW_RELIC_LICENSE_KEY;
    const savedApp = process.env.NEW_RELIC_APP_NAME;
    delete process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_APP_NAME;

    try {
      await expect(init({ appName: 'test' } as any)).rejects.toThrow('NEW_RELIC_LICENSE_KEY');
    } finally {
      if (savedKey) process.env.NEW_RELIC_LICENSE_KEY = savedKey;
      if (savedApp) process.env.NEW_RELIC_APP_NAME = savedApp;
    }
  });

  // ---------------------------------------------------------------------------
  // 3. enabled=false returns no-op agent
  // ---------------------------------------------------------------------------
  it('returns no-op agent when enabled=false', async () => {
    const agent = await init({ ...validConfig, enabled: false });

    expect(agent.getStats().enabled).toBe(false);

    await agent.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 4. Concurrent init() calls return the same agent instance
  // ---------------------------------------------------------------------------
  it('concurrent calls return the same agent instance', async () => {
    const [first, second] = await Promise.all([init(validConfig), init(validConfig)]);

    expect(second).toBe(first);

    await first.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 5. shutdown() clears initPromise so re-init creates a new agent
  // ---------------------------------------------------------------------------
  it('shutdown clears initPromise allowing re-initialization', async () => {
    const first = await init(validConfig);
    await first.shutdown();

    const second = await init(validConfig);
    expect(second).not.toBe(first);

    await second.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 6. getStats() reflects agent state
  // ---------------------------------------------------------------------------
  it('getStats reflects enabled state and uptime', async () => {
    const agent = await init(validConfig);
    const stats = agent.getStats();

    expect(stats.enabled).toBe(true);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(stats.eventsBuffered).toBe(0);
    expect(stats.eventsSent).toBe(0);
    expect(stats.eventsDropped).toBe(0);

    await agent.shutdown();
  });

  // ---------------------------------------------------------------------------
  // 7. Failed init() resets initPromise so the next call can retry
  // ---------------------------------------------------------------------------
  it('resets initPromise after rejection so callers can retry', async () => {
    const savedKey = process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_LICENSE_KEY;

    try {
      await expect(init({ appName: 'test' } as any)).rejects.toThrow();
      // After rejection, a valid init() should succeed
      const agent = await init(validConfig);
      expect(agent).toBeInstanceOf(NrAiAgent);
      await agent.shutdown();
    } finally {
      if (savedKey) process.env.NEW_RELIC_LICENSE_KEY = savedKey;
    }
  });
});
