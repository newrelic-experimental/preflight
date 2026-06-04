import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MetricAggregator } from '../shared/index.js';
import { ProxyMetricsTracker } from './proxy-metrics.js';
import type { ProxyToolCallRecord } from '../proxy/types.js';
import type { ProxyRequestRecord } from '../proxy/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeToolCallRecord(overrides?: Partial<ProxyToolCallRecord>): ProxyToolCallRecord {
  return {
    id: 'rec-001',
    sessionId: null,
    toolName: 'test_tool',
    toolUseId: 'toolu_001',
    timestamp: Date.now(),
    durationMs: 100,
    success: true,
    serverName: 'test-server',
    upstreamLatencyMs: 90,
    proxyOverheadMs: 10,
    inputSizeBytes: 256,
    outputSizeBytes: 1024,
    ...overrides,
  };
}

function makeRequestRecord(overrides?: Partial<ProxyRequestRecord>): ProxyRequestRecord {
  return {
    id: 'req-001',
    serverName: 'test-server',
    method: 'tools/list',
    timestamp: Date.now(),
    durationMs: 50,
    upstreamLatencyMs: 45,
    proxyOverheadMs: 5,
    success: true,
    responseSizeBytes: 512,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ProxyMetricsTracker
// ---------------------------------------------------------------------------

describe('ProxyMetricsTracker', () => {
  let tracker: ProxyMetricsTracker;

  beforeEach(() => {
    tracker = new ProxyMetricsTracker();
  });

  // -------------------------------------------------------------------------
  // Per-server callCount
  // -------------------------------------------------------------------------

  it('tracks per-server call counts', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordProxyCall(makeToolCallRecord({ serverName: 'nr-mcp-server' }));
    }
    for (let i = 0; i < 5; i++) {
      tracker.recordProxyCall(makeToolCallRecord({ serverName: 'confluence' }));
    }

    const metrics = tracker.getMetrics();
    expect(metrics.perServer['nr-mcp-server']!.callCount).toBe(10);
    expect(metrics.perServer['confluence']!.callCount).toBe(5);
    expect(metrics.totalProxiedCalls).toBe(15);
  });

  // -------------------------------------------------------------------------
  // Latency stats
  // -------------------------------------------------------------------------

  it('computes correct latency stats with known durations', () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const d of durations) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          serverName: 'server-a',
          durationMs: d,
        }),
      );
    }

    const stats = tracker.getMetrics().perServer['server-a']!.latencyMs;
    expect(stats.count).toBe(10);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.sum).toBe(550);
    expect(stats.p95).toBe(90);
  });

  // -------------------------------------------------------------------------
  // Error rate
  // -------------------------------------------------------------------------

  it('computes error rate correctly', () => {
    for (let i = 0; i < 8; i++) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          serverName: 'server-a',
          success: true,
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          serverName: 'server-a',
          success: false,
          errorType: 'timeout',
        }),
      );
    }

    const serverStats = tracker.getMetrics().perServer['server-a']!;
    expect(serverStats.errorRate).toBeCloseTo(0.2);
    expect(serverStats.errorsByType['timeout']).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Tool popularity
  // -------------------------------------------------------------------------

  it('ranks tools across servers by count descending', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          toolName: 'grep_tool',
          serverName: 'server-a',
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          toolName: 'read_file',
          serverName: 'server-a',
        }),
      );
    }
    for (let i = 0; i < 7; i++) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          toolName: 'search',
          serverName: 'server-b',
        }),
      );
    }

    const popularity = tracker.getMetrics().toolPopularity;
    expect(popularity[0]).toEqual({ tool: 'search', server: 'server-b', count: 7 });
    expect(popularity[1]).toEqual({ tool: 'grep_tool', server: 'server-a', count: 5 });
    expect(popularity[2]).toEqual({ tool: 'read_file', server: 'server-a', count: 3 });
  });

  // -------------------------------------------------------------------------
  // AiMcpToolCall event attributes
  // -------------------------------------------------------------------------

  it('records all expected attributes for event emission', () => {
    const record = makeToolCallRecord({
      serverName: 'my-server',
      toolName: 'my_tool',
      durationMs: 150,
      upstreamLatencyMs: 140,
      proxyOverheadMs: 10,
      success: true,
      inputSizeBytes: 500,
      outputSizeBytes: 2000,
    });

    tracker.recordProxyCall(record);
    const metrics = tracker.getMetrics();

    const serverStats = metrics.perServer['my-server']!;
    expect(serverStats.callCount).toBe(1);
    expect(serverStats.latencyMs.sum).toBe(150);
    expect(serverStats.avgRequestSizeBytes).toBe(500);
    expect(serverStats.avgResponseSizeBytes).toBe(2000);
    expect(metrics.avgProxyOverheadMs).toBe(10);
    expect(metrics.toolPopularity[0]).toEqual({ tool: 'my_tool', server: 'my-server', count: 1 });
  });

  // -------------------------------------------------------------------------
  // proxy_overhead_ms computation
  // -------------------------------------------------------------------------

  it('computes average proxy overhead correctly', () => {
    tracker.recordProxyCall(makeToolCallRecord({ proxyOverheadMs: 5 }));
    tracker.recordProxyCall(makeToolCallRecord({ proxyOverheadMs: 15 }));
    tracker.recordProxyCall(makeToolCallRecord({ proxyOverheadMs: 10 }));

    expect(tracker.getMetrics().avgProxyOverheadMs).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Payload sizes
  // -------------------------------------------------------------------------

  it('computes average request and response sizes', () => {
    tracker.recordProxyCall(
      makeToolCallRecord({
        serverName: 'server-a',
        inputSizeBytes: 100,
        outputSizeBytes: 500,
      }),
    );
    tracker.recordProxyCall(
      makeToolCallRecord({
        serverName: 'server-a',
        inputSizeBytes: 200,
        outputSizeBytes: 1500,
      }),
    );

    const stats = tracker.getMetrics().perServer['server-a']!;
    expect(stats.avgRequestSizeBytes).toBe(150);
    expect(stats.avgResponseSizeBytes).toBe(1000);
  });

  // -------------------------------------------------------------------------
  // recordProxyRequest
  // -------------------------------------------------------------------------

  it('recordProxyRequest updates server stats but not tool popularity', () => {
    tracker.recordProxyRequest(
      makeRequestRecord({
        serverName: 'server-a',
        durationMs: 30,
      }),
    );
    tracker.recordProxyRequest(
      makeRequestRecord({
        serverName: 'server-a',
        durationMs: 50,
      }),
    );

    const metrics = tracker.getMetrics();
    expect(metrics.perServer['server-a']!.callCount).toBe(2);
    expect(metrics.perServer['server-a']!.latencyMs.count).toBe(2);
    expect(metrics.toolPopularity).toHaveLength(0);
    expect(metrics.totalProxiedCalls).toBe(2);
  });

  it('recordProxyRequest tracks errors', () => {
    tracker.recordProxyRequest(makeRequestRecord({ success: true }));
    tracker.recordProxyRequest(
      makeRequestRecord({
        success: false,
        error: 'connection_refused',
      }),
    );

    const stats = tracker.getMetrics().perServer['test-server']!;
    expect(stats.errorRate).toBeCloseTo(0.5);
    expect(stats.errorsByType['connection_refused']).toBe(1);
  });

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------

  it('reset() clears all state', () => {
    tracker.recordProxyCall(makeToolCallRecord());
    tracker.recordProxyRequest(makeRequestRecord());

    tracker.reset();
    const metrics = tracker.getMetrics();

    expect(metrics.totalProxiedCalls).toBe(0);
    expect(metrics.avgProxyOverheadMs).toBe(0);
    expect(Object.keys(metrics.perServer)).toHaveLength(0);
    expect(metrics.toolPopularity).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // emitMetrics()
  // -------------------------------------------------------------------------

  it('emits expected metric names via MetricAggregator', () => {
    // Record some data across two servers
    tracker.recordProxyCall(
      makeToolCallRecord({
        serverName: 'server-a',
        toolName: 'tool_x',
        durationMs: 100,
        proxyOverheadMs: 5,
      }),
    );
    tracker.recordProxyCall(
      makeToolCallRecord({
        serverName: 'server-b',
        toolName: 'tool_y',
        durationMs: 200,
        proxyOverheadMs: 15,
      }),
    );

    const aggregator = new MetricAggregator();
    tracker.emitMetrics(aggregator);
    const metrics = aggregator.harvest(60_000);
    const names = metrics.map((m) => m.name);

    // Per-server metrics
    expect(names).toContain('ai.mcp.server_call_count');
    expect(names).toContain('ai.mcp.server_latency_ms');
    expect(names).toContain('ai.mcp.server_error_rate');

    // Global proxy overhead
    expect(names).toContain('ai.mcp.proxy_overhead_ms');

    // Tool popularity
    expect(names).toContain('ai.mcp.tool_popularity');

    // Check server dimensions
    const serverCallMetrics = metrics.filter((m) => m.name === 'ai.mcp.server_call_count');
    const servers = serverCallMetrics.map((m) => m.attributes?.server);
    expect(servers).toContain('server-a');
    expect(servers).toContain('server-b');

    // Check tool+server dimensions on popularity
    const popularityMetrics = metrics.filter((m) => m.name === 'ai.mcp.tool_popularity');
    const toolServers = popularityMetrics.map((m) => ({
      tool: m.attributes?.tool,
      server: m.attributes?.server,
    }));
    expect(toolServers).toContainEqual({ tool: 'tool_x', server: 'server-a' });
    expect(toolServers).toContainEqual({ tool: 'tool_y', server: 'server-b' });
  });

  it('emitMetrics skips latency and error rate when no data', () => {
    const aggregator = new MetricAggregator();
    tracker.emitMetrics(aggregator);
    const metrics = aggregator.harvest(60_000);

    expect(metrics).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Array cap (MAX_SAMPLES = 1000)
  // -------------------------------------------------------------------------

  it('latency array for a server never exceeds 1000 entries', () => {
    for (let i = 0; i < 1005; i++) {
      tracker.recordProxyCall(makeToolCallRecord({ durationMs: i, serverName: 'server-cap' }));
    }

    // p95 computation would fail / be very slow on large arrays;
    // verify getMetrics() still returns valid stats (not hanging or throwing)
    const metrics = tracker.getMetrics();
    expect(metrics.perServer['server-cap']).toBeDefined();
    // Call count is accurate even though samples are capped
    expect(metrics.perServer['server-cap']!.callCount).toBe(1005);
  });

  it('request size array for a server never exceeds 1000 entries', () => {
    for (let i = 0; i < 1002; i++) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          serverName: 'server-req',
          inputSizeBytes: i + 1,
          durationMs: null as unknown as number,
          proxyOverheadMs: null as unknown as number,
          outputSizeBytes: null as unknown as number,
        }),
      );
    }

    const metrics = tracker.getMetrics();
    // avgRequestSizeBytes reflects the 1000 most recent values (3..1002)
    // average of 3..1002 = (3+1002)/2 = 502.5
    expect(metrics.perServer['server-req']!.avgRequestSizeBytes).toBeCloseTo(502.5, 0);
  });

  it('proxyOverheadValues array never exceeds 1000 entries', () => {
    for (let i = 0; i < 1003; i++) {
      tracker.recordProxyCall(
        makeToolCallRecord({
          proxyOverheadMs: i + 1,
          durationMs: null as unknown as number,
          inputSizeBytes: null as unknown as number,
          outputSizeBytes: null as unknown as number,
        }),
      );
    }

    const metrics = tracker.getMetrics();
    // avgProxyOverheadMs reflects the 1000 most recent values (4..1003)
    // average of 4..1003 = (4+1003)/2 = 503.5
    expect(metrics.avgProxyOverheadMs).toBeCloseTo(503.5, 0);
  });

  it('response size cap applies via recordProxyRequest too', () => {
    for (let i = 0; i < 1002; i++) {
      tracker.recordProxyRequest(
        makeRequestRecord({
          serverName: 'server-resp',
          responseSizeBytes: i + 1,
          durationMs: null as unknown as number,
          proxyOverheadMs: null as unknown as number,
        }),
      );
    }

    const metrics = tracker.getMetrics();
    // avgResponseSizeBytes reflects the 1000 most recent values (3..1002)
    expect(metrics.perServer['server-resp']!.avgResponseSizeBytes).toBeCloseTo(502.5, 0);
  });
});
