import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ToolCallRecord } from '../storage/types.js';

// ---------------------------------------------------------------------------
// Upstream configuration
// ---------------------------------------------------------------------------

export interface UpstreamConfig {
  readonly name: string;
  /** URL for HTTP upstreams (e.g. "http://localhost:3000/mcp") */
  readonly url?: string;
  /** Command for stdio upstreams (e.g. "node") */
  readonly command?: string;
  /** Arguments for the stdio command (e.g. ["server.js", "--stdio"]) */
  readonly args?: string[];
  /** Extra environment variables for stdio process */
  readonly env?: Record<string, string>;
  readonly transportType: 'http' | 'stdio';
  /** Timeout in ms for upstream HTTP requests (default: 30000) */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Proxy upstream interface
// ---------------------------------------------------------------------------

export interface ForwardResult {
  /** HTTP status code from upstream (or synthetic for stdio) */
  readonly statusCode: number;
  /** Was the response an SSE stream? */
  readonly isStreaming: boolean;
  /** Size of response body in bytes (null for in-progress streaming) */
  readonly responseSizeBytes: number | null;
  /** Time spent waiting for upstream response (ms) */
  readonly upstreamLatencyMs: number;
}

export interface ProxyUpstream {
  readonly name: string;
  readonly transportType: 'http' | 'stdio';
  /** Connect to the upstream (validate URL for HTTP, spawn process for stdio) */
  connect(): Promise<void>;
  /** Forward an HTTP request to the upstream and write the response */
  forward(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<ForwardResult>;
  /** Gracefully disconnect */
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Observability records
// ---------------------------------------------------------------------------

/** Extends ToolCallRecord with proxy-specific fields for tools/call requests. */
export interface ProxyToolCallRecord extends ToolCallRecord {
  readonly serverName: string;
  readonly upstreamLatencyMs: number;
  readonly proxyOverheadMs?: number;
}

/** Lighter record for discovery methods (tools/list, resources/list, resources/read). */
export interface ProxyRequestRecord {
  readonly id: string;
  readonly serverName: string;
  readonly method: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly upstreamLatencyMs: number;
  readonly proxyOverheadMs?: number;
  readonly success: boolean;
  readonly error?: string;
  readonly responseSizeBytes?: number;
}

// ---------------------------------------------------------------------------
// Interception
// ---------------------------------------------------------------------------

/** JSON-RPC methods the proxy intercepts for observability recording. */
export const TRACKED_METHODS = new Set([
  'tools/call',
  'tools/list',
  'resources/list',
  'resources/read',
]);

/** Headers that are forwarded from the proxy to the upstream server. */
export const FORWARDED_HEADER_PREFIXES = ['content-type', 'accept', 'authorization', 'mcp-session-id'];

/** Check if a header should be forwarded to upstream. */
export function shouldForwardHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORWARDED_HEADER_PREFIXES.includes(lower)) return true;
  if (lower.startsWith('x-')) return true;
  return false;
}
