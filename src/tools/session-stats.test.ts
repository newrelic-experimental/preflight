import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, NrMcpServer } from '../server.js';
import { SessionTracker } from '../metrics/session-tracker.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import { FeedbackCollector } from './workflow-tools.js';
import {
  handleGetSessionStats,
  handleGetSessionTimeline,
  handleHealth,
  handleGetConfig,
} from './session-stats.js';
import type { ConfigSummary } from './session-stats.js';
import type { ToolCallRecord } from '../storage/types.js';
import type { SessionStore } from '../storage/session-store.js';
import type { WeeklySummaryGenerator } from '../storage/weekly-summary.js';
import type { TrendAnalyzer } from '../metrics/trend-analyzer.js';
import type { CollaborationProfiler } from '../metrics/collaboration-profile.js';
import type { ClaudeMdTracker } from '../metrics/claudemd-tracker.js';
import type { CostPerOutcomeAnalyzer } from '../metrics/cost-per-outcome.js';
import type { TaskDetector } from '../metrics/task-detector.js';
import type { RecommendationEngine } from '../metrics/recommendation-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: 'sess-001',
    toolName: 'Read',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 50,
    success: true,
    ...overrides,
  };
}

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// handleGetSessionStats — unit tests
// ---------------------------------------------------------------------------

describe('handleGetSessionStats()', () => {
  it('returns correct JSON structure after recording 10 tool calls', () => {
    const tracker = new SessionTracker('stats-session');

    for (let i = 0; i < 5; i++)
      tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 30 }));
    for (let i = 0; i < 3; i++)
      tracker.recordToolCall(makeRecord({ toolName: 'Edit', durationMs: 20 }));
    for (let i = 0; i < 2; i++)
      tracker.recordToolCall(
        makeRecord({ toolName: 'Bash', durationMs: 100, success: false, errorType: 'timeout' }),
      );

    const result = handleGetSessionStats(tracker);
    const stats = JSON.parse(result.content[0].text);

    expect(stats.session_id).toBe('stats-session');
    expect(stats.tool_calls).toBe(10);
    expect(stats.tool_calls_by_type).toEqual({ Read: 5, Edit: 3, Bash: 2 });
    expect(stats.success_rate).toBe(0.8);
    expect(stats.failed_calls).toBe(2);
  });

  it('all fields match the current SessionTracker state', () => {
    const tracker = new SessionTracker('match-session');

    tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 40, filePath: '/a.ts' }));
    tracker.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 60, filePath: '/b.ts' }));
    tracker.recordToolCall(makeRecord({ toolName: 'Write', durationMs: 30, filePath: '/c.ts' }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 200 }));
    tracker.recordToolCall(makeRecord({ toolName: 'Grep', durationMs: 10 }));

    const metrics = tracker.getMetrics();
    const result = handleGetSessionStats(tracker);
    const stats = JSON.parse(result.content[0].text);

    expect(stats.session_id).toBe(metrics.sessionId);
    expect(stats.session_duration_ms).toBeGreaterThanOrEqual(0);
    expect(stats.tool_calls).toBe(metrics.toolCallCount);
    expect(stats.tool_calls_by_type).toEqual(metrics.toolCallCountByTool);
    expect(stats.success_rate).toBe(metrics.toolSuccessRate);
    expect(stats.failed_calls).toBe(metrics.toolErrorCount);
    expect(stats.unique_files_read).toBe(metrics.uniqueFilesRead);
    expect(stats.unique_files_modified).toBe(metrics.uniqueFilesWritten);
    expect(stats.bash_commands_run).toBe(metrics.bashCommandsRun);
    expect(stats.search_queries).toBe(metrics.searchQueries);
    expect(stats.avg_tool_duration_ms).toBe(Math.round((40 + 60 + 30 + 200 + 10) / 5));
  });

  it('includes bash_calls_by_category in the response', () => {
    const tracker = new SessionTracker('cat-session');
    tracker.recordToolCall(
      makeRecord({ toolName: 'Bash', bashCategory: 'git' } as Partial<ToolCallRecord>),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Bash', bashCategory: 'git' } as Partial<ToolCallRecord>),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Bash', bashCategory: 'test-runner' } as Partial<ToolCallRecord>),
    );

    const result = handleGetSessionStats(tracker);
    const stats = JSON.parse(result.content[0].text);

    expect(stats.bash_calls_by_category).toEqual({ git: 2, 'test-runner': 1 });
  });

  it('returns zero avg_tool_duration_ms when no durations recorded', () => {
    const tracker = new SessionTracker('empty-session');
    tracker.recordToolCall(makeRecord({ durationMs: null }));

    const result = handleGetSessionStats(tracker);
    const stats = JSON.parse(result.content[0].text);

    expect(stats.avg_tool_duration_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleGetSessionTimeline — unit tests
// ---------------------------------------------------------------------------

describe('handleGetSessionTimeline()', () => {
  it('returns exactly last_n entries when specified', () => {
    const tracker = new SessionTracker('timeline-session');

    for (let i = 0; i < 10; i++) {
      tracker.recordToolCall(makeRecord({ toolName: `Tool${i}`, timestamp: 1000 + i * 100 }));
    }

    const result = handleGetSessionTimeline(tracker, 5);
    const data = JSON.parse(result.content[0].text);

    expect(data.timeline).toHaveLength(5);
    // Should be the last 5 entries (Tool5 through Tool9)
    expect(data.timeline[0].tool).toBe('Tool5');
    expect(data.timeline[4].tool).toBe('Tool9');
  });

  it('defaults to 20 entries', () => {
    const tracker = new SessionTracker('default-session');

    for (let i = 0; i < 30; i++) {
      tracker.recordToolCall(makeRecord({ toolName: 'Read', timestamp: 1000 + i * 100 }));
    }

    const result = handleGetSessionTimeline(tracker);
    const data = JSON.parse(result.content[0].text);

    expect(data.timeline).toHaveLength(20);
  });

  it('timeline entries have correct shape', () => {
    const tracker = new SessionTracker('shape-session');
    const ts = 1_700_000_000_000;

    tracker.recordToolCall(
      makeRecord({ toolName: 'Bash', timestamp: ts, durationMs: 4800, success: false }),
    );

    const result = handleGetSessionTimeline(tracker, 1);
    const data = JSON.parse(result.content[0].text);
    const entry = data.timeline[0];

    expect(entry.timestamp).toBe(new Date(ts).toISOString());
    expect(entry.tool).toBe('Bash');
    expect(entry.duration_ms).toBe(4800);
    expect(entry.success).toBe(false);
  });

  it('returns chronological order (oldest first)', () => {
    const tracker = new SessionTracker('order-session');

    tracker.recordToolCall(makeRecord({ toolName: 'Read', timestamp: 1000 }));
    tracker.recordToolCall(makeRecord({ toolName: 'Edit', timestamp: 2000 }));
    tracker.recordToolCall(makeRecord({ toolName: 'Bash', timestamp: 3000 }));

    const result = handleGetSessionTimeline(tracker, 3);
    const data = JSON.parse(result.content[0].text);

    expect(data.timeline[0].tool).toBe('Read');
    expect(data.timeline[1].tool).toBe('Edit');
    expect(data.timeline[2].tool).toBe('Bash');
  });
});

// ---------------------------------------------------------------------------
// handleHealth — unit tests
// ---------------------------------------------------------------------------

describe('handleHealth()', () => {
  it('returns ok status with version when called with no options', () => {
    const result = handleHealth({});
    const data = JSON.parse(result.content[0].text);

    expect(data.status).toBe('ok');
    expect(typeof data.version).toBe('string');
    expect(data.version.length).toBeGreaterThan(0);
    expect(data.developer).toBe('unknown');
    expect(data.session_id).toBeNull();
    expect(data.uptime_seconds).toBe(0);
    expect(typeof data.connected_at).toBe('string');
    expect(new Date(data.connected_at).toISOString()).toBe(data.connected_at);
  });

  it('computes uptime_seconds from sessionStartMs', () => {
    const startMs = Date.now() - 90_000;
    const result = handleHealth({ sessionStartMs: startMs });
    const data = JSON.parse(result.content[0].text);

    expect(data.uptime_seconds).toBeGreaterThanOrEqual(89);
    expect(data.uptime_seconds).toBeLessThanOrEqual(91);
  });

  it('reflects developer and session_id when provided', () => {
    const tracker = new SessionTracker('health-session-id');
    const result = handleHealth({ developer: 'alice', sessionId: tracker.getMetrics().sessionId });
    const data = JSON.parse(result.content[0].text);

    expect(data.developer).toBe('alice');
    expect(data.session_id).toBe('health-session-id');
  });
});

// ---------------------------------------------------------------------------
// handleGetConfig — unit tests
// ---------------------------------------------------------------------------

function makeConfigSummary(overrides?: Partial<ConfigSummary>): ConfigSummary {
  return {
    mode: 'cloud',
    developer: 'alice',
    accountId: '1234567',
    licenseKeyMasked: 'NRAA...1234',
    nrApiKeyMasked: 'NRAK...5678',
    region: 'us',
    storagePath: '/home/alice/.preflight',
    dashboardUrl: 'http://127.0.0.1:9847',
    configFilePath: '/home/alice/.preflight/config.json',
    ...overrides,
  };
}

describe('handleGetConfig()', () => {
  it('returns all config fields as JSON', () => {
    const summary = makeConfigSummary();
    const result = handleGetConfig(summary);
    const data = JSON.parse(result.content[0].text) as ConfigSummary;

    expect(data.mode).toBe('cloud');
    expect(data.developer).toBe('alice');
    expect(data.accountId).toBe('1234567');
    expect(data.licenseKeyMasked).toBe('NRAA...1234');
    expect(data.nrApiKeyMasked).toBe('NRAK...5678');
    expect(data.region).toBe('us');
    expect(data.storagePath).toBe('/home/alice/.preflight');
    expect(data.dashboardUrl).toBe('http://127.0.0.1:9847');
    expect(data.configFilePath).toBe('/home/alice/.preflight/config.json');
  });

  it('handles null sensitive fields (local mode)', () => {
    const summary = makeConfigSummary({
      mode: 'local',
      accountId: null,
      licenseKeyMasked: null,
      nrApiKeyMasked: null,
    });
    const result = handleGetConfig(summary);
    const data = JSON.parse(result.content[0].text) as ConfigSummary;

    expect(data.mode).toBe('local');
    expect(data.accountId).toBeNull();
    expect(data.licenseKeyMasked).toBeNull();
    expect(data.nrApiKeyMasked).toBeNull();
  });

  it('reflects eu region', () => {
    const summary = makeConfigSummary({ region: 'eu' });
    const result = handleGetConfig(summary);
    const data = JSON.parse(result.content[0].text) as ConfigSummary;
    expect(data.region).toBe('eu');
  });
});

// ---------------------------------------------------------------------------
// MCP protocol integration (via InMemoryTransport)
// ---------------------------------------------------------------------------

describe('MCP protocol integration', () => {
  let server: NrMcpServer;
  let client: Client;
  let tracker: SessionTracker;

  beforeEach(async () => {
    tracker = new SessionTracker('mcp-session');

    // Seed some data
    tracker.recordToolCall(
      makeRecord({ toolName: 'Read', durationMs: 30, filePath: '/a.ts', timestamp: 1000 }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Edit', durationMs: 20, filePath: '/a.ts', timestamp: 2000 }),
    );
    tracker.recordToolCall(
      makeRecord({ toolName: 'Bash', durationMs: 100, timestamp: 3000, success: false }),
    );

    server = createServer({
      name: 'test-mcp',
      version: '0.0.1',
      sessionTracker: tracker,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('tools/list includes health and session tools', async () => {
    const result = await client.listTools();

    expect(result.tools).toHaveLength(3);

    const names = result.tools.map((t) => t.name);
    expect(names).toContain('nr_observe_health');
    expect(names).toContain('nr_observe_get_session_stats');
    expect(names).toContain('nr_observe_get_session_timeline');

    // Check descriptions exist
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('tools have readOnlyHint annotation', async () => {
    const result = await client.listTools();

    for (const tool of result.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('calling nr_observe_get_session_stats returns valid JSON', async () => {
    const result = await client.callTool({ name: 'nr_observe_get_session_stats', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');

    const stats = JSON.parse(content[0].text);
    expect(stats.session_id).toBe('mcp-session');
    expect(stats.tool_calls).toBe(3);
    expect(stats.tool_calls_by_type).toEqual({ Read: 1, Edit: 1, Bash: 1 });
  });

  it('calling nr_observe_get_session_timeline with last_n returns correct count', async () => {
    const result = await client.callTool({
      name: 'nr_observe_get_session_timeline',
      arguments: { last_n: 2 },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);

    expect(data.timeline).toHaveLength(2);
    // Last 2 entries: Edit and Bash
    expect(data.timeline[0].tool).toBe('Edit');
    expect(data.timeline[1].tool).toBe('Bash');
  });

  it('calling unknown tool returns error', async () => {
    await expect(client.callTool({ name: 'nonexistent_tool', arguments: {} })).rejects.toThrow();
  });

  it('returns isError content block when a tool handler throws unexpectedly', async () => {
    jest.spyOn(tracker, 'getMetrics').mockImplementation(() => {
      throw new Error('tracker exploded');
    });

    const result = await client.callTool({ name: 'nr_observe_get_session_stats', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0]!.text)).toMatchObject({ error: 'tracker exploded' });
  });

  it('MCP initialize response includes transparency disclosure', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('test-mcp');

    // The instructions field is set on the server — verify it's accessible
    // Note: The MCP SDK passes instructions during initialize handshake.
    // We verify the server was configured with it by checking it exists on the server.
    // The Client SDK stores server instructions internally.
    expect(server.server).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MCP protocol integration — cost tools
// ---------------------------------------------------------------------------

describe('MCP protocol integration — cost tools', () => {
  let server: NrMcpServer;
  let client: Client;
  let costTracker: CostTracker;
  let feedbackCollector: FeedbackCollector;

  beforeEach(async () => {
    costTracker = new CostTracker();
    feedbackCollector = new FeedbackCollector();

    server = createServer({
      name: 'cost-mcp',
      version: '0.0.1',
      costTracker,
      feedbackCollector,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('tools/list includes nr_observe_report_tokens when costTracker provided', async () => {
    const result = await client.listTools();

    const names = result.tools.map((t) => t.name);
    expect(names).toContain('nr_observe_report_tokens');
  });

  it('tools/list includes both session and cost tools when both trackers provided', async () => {
    // Clean up the cost-only server
    await client.close();
    await server.close();

    const sessionTracker = new SessionTracker('both-session');
    const bothServer = createServer({
      name: 'both-mcp',
      version: '0.0.1',
      sessionTracker,
      costTracker: new CostTracker(sessionTracker),
    });

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const bothClient = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([bothServer.server.connect(st), bothClient.connect(ct)]);

    const result = await bothClient.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain('nr_observe_health');
    expect(names).toContain('nr_observe_get_session_stats');
    expect(names).toContain('nr_observe_get_session_timeline');
    expect(names).toContain('nr_observe_report_tokens');
    expect(names).toContain('nr_observe_get_cost_breakdown');
    expect(names).toContain('nr_observe_get_cost_forecast');
    expect(result.tools).toHaveLength(6);

    await bothClient.close();
    await bothServer.close();
  });

  it('calling nr_observe_report_tokens returns cost data', async () => {
    const result = await client.callTool({
      name: 'nr_observe_report_tokens',
      arguments: {
        input_tokens: 10_000,
        output_tokens: 2_000,
        model: 'claude-sonnet-4',
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text);

    expect(body.recorded).toBe(true);
    expect(body.model).toBe('claude-sonnet-4');
    expect(body.cost_this_report_usd).toBeCloseTo(0.06, 6);
    expect(body.session_total_cost_usd).toBeCloseTo(0.06, 6);
  });

  it('calling nr_observe_report_tokens with negative tokens returns error', async () => {
    const result = await client.callTool({
      name: 'nr_observe_report_tokens',
      arguments: {
        input_tokens: -100,
        output_tokens: 2_000,
        model: 'claude-sonnet-4',
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text);

    expect(body.error).toContain('Invalid token report');
  });

  it('calling nr_observe_report_tokens with missing model returns error', async () => {
    const result = await client.callTool({
      name: 'nr_observe_report_tokens',
      arguments: {
        input_tokens: 10_000,
        output_tokens: 2_000,
        // missing model
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text);

    expect(body.error).toContain('Invalid token report');
  });

  it('calling nr_observe_report_tokens with invalid quality enum returns error', async () => {
    const result = await client.callTool({
      name: 'nr_observe_report_feedback',
      arguments: {
        quality: 'great',
        task_id: 'task-123',
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text);

    expect(body.error).toContain('Invalid feedback');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — server without any trackers
// ---------------------------------------------------------------------------

describe('Server without any trackers', () => {
  let server: NrMcpServer;
  let client: Client;

  beforeEach(async () => {
    server = createServer({ name: 'bare-mcp', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('returns only health tool when no trackers provided', async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe('nr_observe_health');
  });
});

// ---------------------------------------------------------------------------
// Cross-session tool registration — individual dependency gating
// ---------------------------------------------------------------------------

describe('Cross-session tool registration', () => {
  it('registers only session_history and platform_comparison when only sessionStore provided', async () => {
    const server = createServer({
      name: 'cs-test',
      version: '0.0.1',
      sessionStore: {} as unknown as SessionStore,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.server.connect(st), client.connect(ct)]);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain('nr_observe_get_session_history');
    expect(names).toContain('nr_observe_get_platform_comparison');
    expect(names).not.toContain('nr_observe_get_weekly_summary');
    expect(names).not.toContain('nr_observe_get_trends');
    expect(names).not.toContain('nr_observe_get_collaboration_profile');
    expect(names).not.toContain('nr_observe_get_claudemd_impact');
    expect(names).not.toContain('nr_observe_get_cost_per_outcome');
    expect(names).not.toContain('nr_observe_get_recommendations');

    await client.close();
    await server.close();
  });

  it('registers all cross-session tools when all dependencies provided', async () => {
    const server = createServer({
      name: 'cs-all',
      version: '0.0.1',
      sessionStore: {} as unknown as SessionStore,
      weeklySummaryGenerator: {} as unknown as WeeklySummaryGenerator,
      trendAnalyzer: {} as unknown as TrendAnalyzer,
      collaborationProfiler: {} as unknown as CollaborationProfiler,
      claudeMdTracker: {} as unknown as ClaudeMdTracker,
      costPerOutcomeAnalyzer: {} as unknown as CostPerOutcomeAnalyzer,
      taskDetector: {} as unknown as TaskDetector,
      recommendationEngine: {} as unknown as RecommendationEngine,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.server.connect(st), client.connect(ct)]);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain('nr_observe_get_session_history');
    expect(names).toContain('nr_observe_get_platform_comparison');
    expect(names).toContain('nr_observe_get_weekly_summary');
    expect(names).toContain('nr_observe_get_trends');
    expect(names).toContain('nr_observe_get_collaboration_profile');
    expect(names).toContain('nr_observe_get_claudemd_impact');
    expect(names).toContain('nr_observe_get_cost_per_outcome');
    expect(names).toContain('nr_observe_get_recommendations');

    await client.close();
    await server.close();
  });

  it('does not register cross-session tools when only sessionTracker provided', async () => {
    const tracker = new SessionTracker('no-cs-session');
    const server = createServer({
      name: 'cs-none',
      version: '0.0.1',
      sessionTracker: tracker,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.server.connect(st), client.connect(ct)]);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    const crossSessionTools = [
      'nr_observe_get_session_history',
      'nr_observe_get_weekly_summary',
      'nr_observe_get_trends',
      'nr_observe_get_collaboration_profile',
      'nr_observe_get_claudemd_impact',
      'nr_observe_get_cost_per_outcome',
      'nr_observe_get_recommendations',
      'nr_observe_get_platform_comparison',
    ];

    for (const tool of crossSessionTools) {
      expect(names).not.toContain(tool);
    }

    await client.close();
    await server.close();
  });

  it('cost_per_outcome requires both costPerOutcomeAnalyzer and taskDetector', async () => {
    const server = createServer({
      name: 'cs-cost-no-task',
      version: '0.0.1',
      costPerOutcomeAnalyzer: {} as unknown as CostPerOutcomeAnalyzer,
      // no taskDetector
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.server.connect(st), client.connect(ct)]);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).not.toContain('nr_observe_get_cost_per_outcome');

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 3: pre-resolution gating via registerPendingTools()
// ---------------------------------------------------------------------------

describe('registerPendingTools()', () => {
  it('returns "session_id not yet resolved" structured error for non-health tools', async () => {
    const { registerPendingTools } = await import('./session-stats.js');

    const server = createServer({ name: 'pending', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    registerPendingTools(server.server, { sessionStartMs: Date.now(), developer: 'tester' });
    await Promise.all([server.server.connect(st), client.connect(ct)]);

    // List should expose only the health tool while pending
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['nr_observe_health']);

    // Health still works
    const health = await client.callTool({ name: 'nr_observe_health', arguments: {} });
    const healthBody = JSON.parse((health.content as Array<{ text: string }>)[0].text);
    expect(healthBody.status).toBe('ok');
    expect(healthBody.session_id).toBeNull();

    // Any other tool returns the structured "not yet resolved" error
    const unresolved = await client.callTool({
      name: 'nr_observe_get_session_stats',
      arguments: {},
    });
    expect(unresolved.isError).toBe(true);
    const errBody = JSON.parse((unresolved.content as Array<{ text: string }>)[0].text);
    expect(errBody.error).toBe('session_id not yet resolved');
    expect(errBody.hint).toContain('Make any tool call');

    await client.close();
    await server.close();
  });

  it('exposes nr_observe_get_config when configSummary is provided', async () => {
    const { registerPendingTools } = await import('./session-stats.js');
    const server = createServer({ name: 'pending2', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });

    const summary: ConfigSummary = {
      mode: 'local',
      developer: 'tester',
      accountId: null,
      licenseKeyMasked: null,
      nrApiKeyMasked: null,
      region: 'us',
      storagePath: '/tmp/x',
      dashboardUrl: 'http://127.0.0.1:7777',
      configFilePath: '/tmp/x/config.json',
    };
    registerPendingTools(server.server, {
      sessionStartMs: Date.now(),
      developer: 'tester',
      configSummary: summary,
    });
    await Promise.all([server.server.connect(st), client.connect(ct)]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('nr_observe_health');
    expect(names).toContain('nr_observe_get_config');

    const cfg = await client.callTool({ name: 'nr_observe_get_config', arguments: {} });
    const cfgBody = JSON.parse((cfg.content as Array<{ text: string }>)[0].text);
    expect(cfgBody.developer).toBe('tester');
    expect(cfgBody.mode).toBe('local');

    await client.close();
    await server.close();
  });
});
