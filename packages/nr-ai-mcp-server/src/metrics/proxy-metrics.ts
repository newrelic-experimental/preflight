/**
 * Proxy Metrics Aggregation — tracks per-server call counts, latency
 * percentiles, error rates, tool popularity, and proxy overhead for
 * upstream MCP server traffic flowing through the proxy.
 */

import type { MetricAggregator } from '@nr-ai-observatory/shared';
import type { ProxyToolCallRecord, ProxyRequestRecord } from '../proxy/types.js';
import { computeDurationStats, type DurationStats } from './session-tracker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerStats {
  callCount: number;
  latencyMs: DurationStats;
  errorRate: number;
  errorsByType: Record<string, number>;
  avgRequestSizeBytes: number;
  avgResponseSizeBytes: number;
}

export interface ProxyMetrics {
  perServer: Record<string, ServerStats>;
  toolPopularity: Array<{ tool: string; server: string; count: number }>;
  totalProxiedCalls: number;
  avgProxyOverheadMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SAMPLES = 1_000;

// ---------------------------------------------------------------------------
// ProxyMetricsTracker
// ---------------------------------------------------------------------------

export class ProxyMetricsTracker {
  private serverCalls = new Map<string, number>();
  private serverLatencies = new Map<string, number[]>();
  private serverErrors = new Map<string, { total: number; failed: number }>();
  private serverErrorsByType = new Map<string, Map<string, number>>();
  private serverRequestSizes = new Map<string, number[]>();
  private serverResponseSizes = new Map<string, number[]>();
  private toolServerCounts = new Map<string, number>();
  private proxyOverheadValues: number[] = [];
  private totalCalls = 0;

  /**
   * Record a proxied tools/call. Updates all per-server aggregates,
   * tool popularity, and proxy overhead tracking.
   */
  recordProxyCall(record: ProxyToolCallRecord): void {
    const server = record.serverName;
    this.totalCalls++;

    // Per-server call count
    this.serverCalls.set(server, (this.serverCalls.get(server) ?? 0) + 1);

    // Latency
    if (record.durationMs != null) {
      const latencies = this.serverLatencies.get(server);
      if (latencies) {
        appendBounded(latencies, record.durationMs);
      } else {
        this.serverLatencies.set(server, [record.durationMs]);
      }
    }

    // Error tracking
    const errorEntry = this.serverErrors.get(server) ?? { total: 0, failed: 0 };
    errorEntry.total++;
    if (!record.success) {
      errorEntry.failed++;
      const errorType = record.errorType ?? 'unknown';
      let typeMap = this.serverErrorsByType.get(server);
      if (!typeMap) {
        typeMap = new Map();
        this.serverErrorsByType.set(server, typeMap);
      }
      typeMap.set(errorType, (typeMap.get(errorType) ?? 0) + 1);
    }
    this.serverErrors.set(server, errorEntry);

    // Payload sizes
    if (record.inputSizeBytes != null) {
      const sizes = this.serverRequestSizes.get(server);
      if (sizes) {
        appendBounded(sizes, record.inputSizeBytes);
      } else {
        this.serverRequestSizes.set(server, [record.inputSizeBytes]);
      }
    }
    if (record.outputSizeBytes != null) {
      const sizes = this.serverResponseSizes.get(server);
      if (sizes) {
        appendBounded(sizes, record.outputSizeBytes);
      } else {
        this.serverResponseSizes.set(server, [record.outputSizeBytes]);
      }
    }

    // Tool popularity (keyed by tool|server)
    const toolKey = `${record.toolName}|${server}`;
    this.toolServerCounts.set(toolKey, (this.toolServerCounts.get(toolKey) ?? 0) + 1);

    // Proxy overhead
    if (record.proxyOverheadMs != null) {
      appendBounded(this.proxyOverheadValues, record.proxyOverheadMs);
    }
  }

  /**
   * Record a proxied discovery request (tools/list, resources/list, etc.).
   * Updates server-level stats but not tool popularity.
   */
  recordProxyRequest(record: ProxyRequestRecord): void {
    const server = record.serverName;
    this.totalCalls++;

    // Per-server call count
    this.serverCalls.set(server, (this.serverCalls.get(server) ?? 0) + 1);

    // Latency
    if (record.durationMs != null) {
      const latencies = this.serverLatencies.get(server);
      if (latencies) {
        appendBounded(latencies, record.durationMs);
      } else {
        this.serverLatencies.set(server, [record.durationMs]);
      }
    }

    // Error tracking
    const errorEntry = this.serverErrors.get(server) ?? { total: 0, failed: 0 };
    errorEntry.total++;
    if (!record.success) {
      errorEntry.failed++;
      const errorType = record.error ?? 'unknown';
      let typeMap = this.serverErrorsByType.get(server);
      if (!typeMap) {
        typeMap = new Map();
        this.serverErrorsByType.set(server, typeMap);
      }
      typeMap.set(errorType, (typeMap.get(errorType) ?? 0) + 1);
    }
    this.serverErrors.set(server, errorEntry);

    // Response payload size
    if (record.responseSizeBytes != null) {
      const sizes = this.serverResponseSizes.get(server);
      if (sizes) {
        appendBounded(sizes, record.responseSizeBytes);
      } else {
        this.serverResponseSizes.set(server, [record.responseSizeBytes]);
      }
    }

    // Proxy overhead
    if (record.proxyOverheadMs != null) {
      appendBounded(this.proxyOverheadValues, record.proxyOverheadMs);
    }
  }

  /** Return a snapshot of all proxy metrics. */
  getMetrics(): ProxyMetrics {
    const perServer: Record<string, ServerStats> = {};

    for (const [server, callCount] of this.serverCalls) {
      const latencies = this.serverLatencies.get(server) ?? [];
      const errorEntry = this.serverErrors.get(server) ?? { total: 0, failed: 0 };
      const errorsByType: Record<string, number> = {};
      const typeMap = this.serverErrorsByType.get(server);
      if (typeMap) {
        for (const [type, count] of typeMap) {
          errorsByType[type] = count;
        }
      }

      const requestSizes = this.serverRequestSizes.get(server) ?? [];
      const responseSizes = this.serverResponseSizes.get(server) ?? [];

      perServer[server] = {
        callCount,
        latencyMs: computeDurationStats(latencies),
        errorRate: errorEntry.total > 0 ? errorEntry.failed / errorEntry.total : 0,
        errorsByType,
        avgRequestSizeBytes: requestSizes.length > 0
          ? requestSizes.reduce((a, b) => a + b, 0) / requestSizes.length
          : 0,
        avgResponseSizeBytes: responseSizes.length > 0
          ? responseSizes.reduce((a, b) => a + b, 0) / responseSizes.length
          : 0,
      };
    }

    // Tool popularity — sorted descending by count
    const toolPopularity: Array<{ tool: string; server: string; count: number }> = [];
    for (const [key, count] of this.toolServerCounts) {
      const [tool = 'unknown', server = 'unknown'] = key.split('|');
      toolPopularity.push({ tool, server, count });
    }
    toolPopularity.sort((a, b) => b.count - a.count);

    // Average proxy overhead
    const avgProxyOverheadMs = this.proxyOverheadValues.length > 0
      ? this.proxyOverheadValues.reduce((a, b) => a + b, 0) / this.proxyOverheadValues.length
      : 0;

    return {
      perServer,
      toolPopularity,
      totalProxiedCalls: this.totalCalls,
      avgProxyOverheadMs,
    };
  }

  /** Emit aggregated metrics to a MetricAggregator for NR ingestion. */
  emitMetrics(aggregator: MetricAggregator): void {
    for (const [server, callCount] of this.serverCalls) {
      aggregator.record('ai.mcp.server_call_count', callCount, { server });

      const latencies = this.serverLatencies.get(server) ?? [];
      if (latencies.length > 0) {
        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        aggregator.record('ai.mcp.server_latency_ms', avg, { server });
      }

      const errorEntry = this.serverErrors.get(server);
      if (errorEntry && errorEntry.total > 0) {
        aggregator.record('ai.mcp.server_error_rate', errorEntry.failed / errorEntry.total, { server });
      }
    }

    // Global proxy overhead
    if (this.proxyOverheadValues.length > 0) {
      const avg = this.proxyOverheadValues.reduce((a, b) => a + b, 0) / this.proxyOverheadValues.length;
      aggregator.record('ai.mcp.proxy_overhead_ms', avg);
    }

    // Tool popularity
    for (const [key, count] of this.toolServerCounts) {
      const [tool = 'unknown', server = 'unknown'] = key.split('|');
      aggregator.record('ai.mcp.tool_popularity', count, { tool, server });
    }
  }

  /** Clear all internal state. */
  reset(): void {
    this.serverCalls.clear();
    this.serverLatencies.clear();
    this.serverErrors.clear();
    this.serverErrorsByType.clear();
    this.serverRequestSizes.clear();
    this.serverResponseSizes.clear();
    this.toolServerCounts.clear();
    this.proxyOverheadValues = [];
    this.totalCalls = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendBounded(arr: number[], value: number): void {
  arr.push(value);
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
}
