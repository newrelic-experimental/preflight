/**
 * ProxyManager — HTTP server that routes requests to upstream MCP servers
 * with transparent forwarding and observability recording.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../shared/index.js';
import type {
  ForwardResult,
  ProxyRequestRecord,
  ProxyToolCallRecord,
  ProxyUpstream,
  UpstreamConfig,
} from './types.js';
import { TRACKED_METHODS } from './types.js';
import { HttpUpstream } from './upstream-http.js';
import { StdioUpstream } from './upstream-stdio.js';
import { OtlpReceiver } from './otlp-receiver.js';

const logger = createLogger('proxy-manager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyManagerOptions {
  readonly port: number;
  readonly onToolCall?: (record: ProxyToolCallRecord) => void;
  readonly onRequest?: (record: ProxyRequestRecord) => void;
  /** Timeout for reading the full request body (ms). Default: 30000. */
  readonly bodyTimeoutMs?: number;
  /** Maximum allowed request body size in bytes. Default: 10 MB. */
  readonly maxBodyBytes?: number;
  readonly otlpReceiverEnabled?: boolean;
  readonly otlpReceiverPort?: number;
  readonly otlpReceiverBindAddress?: string;
  readonly otlpForwardEndpoint?: string | null;
  readonly otlpForwardHeaders?: Record<string, string>;
  readonly otlpEnrichmentAttributes?: Record<string, string>;
}

const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// JSON-RPC body parsing (just enough to identify the method)
// ---------------------------------------------------------------------------

interface JsonRpcPeek {
  method: string;
  id?: string | number;
  params?: Record<string, unknown>;
}

function peekJsonRpc(body: Buffer): JsonRpcPeek | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf-8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'method' in parsed &&
      typeof (parsed as Record<string, unknown>).method === 'string'
    ) {
      return parsed as JsonRpcPeek;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ProxyManager
// ---------------------------------------------------------------------------

export class ProxyManager {
  private readonly upstreams = new Map<string, ProxyUpstream>();
  private httpServer: Server | null = null;
  private otlpReceiver: OtlpReceiver | null = null;
  private readonly options: ProxyManagerOptions;
  private readonly port: number;
  private readonly onToolCall: ((record: ProxyToolCallRecord) => void) | undefined;
  private readonly onRequest: ((record: ProxyRequestRecord) => void) | undefined;
  private readonly bodyTimeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(options: ProxyManagerOptions) {
    this.options = options;
    this.port = options.port;
    this.onToolCall = options.onToolCall;
    this.onRequest = options.onRequest;
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  /** Register an upstream MCP server for proxying. */
  registerUpstream(config: UpstreamConfig): void {
    const upstream = createUpstream(config);
    this.upstreams.set(config.name, upstream);
    logger.info(`Registered upstream "${config.name}"`, { transportType: config.transportType });
  }

  /** Get the list of registered upstream names. */
  getUpstreamNames(): string[] {
    return Array.from(this.upstreams.keys());
  }

  /** Get a registered upstream by name (for testing). */
  getUpstream(name: string): ProxyUpstream | undefined {
    return this.upstreams.get(name);
  }

  /** Connect all upstreams and start the HTTP proxy server. */
  async start(): Promise<void> {
    // Connect all upstreams
    const upstreamNames = Array.from(this.upstreams.keys());
    const connectResults = await Promise.allSettled(
      Array.from(this.upstreams.values()).map((u) => u.connect()),
    );
    const failedNames: string[] = [];
    for (let i = 0; i < connectResults.length; i++) {
      if (connectResults[i].status === 'rejected') {
        const name = upstreamNames[i];
        const reason = (connectResults[i] as PromiseRejectedResult).reason;
        logger.error('Failed to connect upstream', { name, error: String(reason) });
        failedNames.push(name);
      }
    }
    if (failedNames.length > 0 && failedNames.length === this.upstreams.size) {
      throw new Error(
        `All upstreams failed to connect (${failedNames.join(', ')}). Proxy cannot start.`,
      );
    }
    if (failedNames.length > 0) {
      logger.warn('Some upstreams failed to connect — proxy starting in degraded mode', {
        failed: failedNames,
        total: this.upstreams.size,
      });
    }

    // Start HTTP server
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        logger.error('Unhandled request error', { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        } else if (!res.writableEnded) {
          // Headers already sent (e.g. mid-SSE stream) — writing JSON would corrupt
          // the stream. destroy the response (not just the socket) so the
          // writable stream and its pipe chain are fully cleaned up.
          res.on('error', () => {
            /* suppress post-destroy write errors */
          });
          res.destroy();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.port, '127.0.0.1', () => {
        logger.info(`Proxy server listening`, { port: this.port });
        // Replace the startup rejection handler with a permanent error logger so
        // post-startup server errors don't invoke reject() on an already-resolved
        // promise and don't become unhandled Node.js errors.
        this.httpServer!.removeAllListeners('error');
        this.httpServer!.on('error', (err) =>
          logger.error('Proxy server error', { error: String(err) }),
        );
        resolve();
      });
    });

    if (this.options.otlpReceiverEnabled) {
      try {
        const receiver = new OtlpReceiver({
          port: this.options.otlpReceiverPort ?? 4318,
          bindAddress: this.options.otlpReceiverBindAddress ?? '127.0.0.1',
          forwardEndpoint: this.options.otlpForwardEndpoint ?? null,
          forwardHeaders: this.options.otlpForwardHeaders ?? {},
          enrichmentAttributes: this.options.otlpEnrichmentAttributes ?? {},
        });
        await receiver.start();
        this.otlpReceiver = receiver;
      } catch (err) {
        logger.warn('OTLP receiver failed to start — disabled', { error: String(err) });
      }
    }
  }

  /** Stop the HTTP server and disconnect all upstreams. */
  async stop(): Promise<void> {
    // Close the HTTP server
    if (this.httpServer) {
      // closeAllConnections() forcibly destroys keep-alive connections so stop()
      // doesn't hang waiting for clients to close them naturally (Node 18.2+).
      if (typeof this.httpServer.closeAllConnections === 'function') {
        this.httpServer.closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    if (this.otlpReceiver) {
      await this.otlpReceiver.stop();
      this.otlpReceiver = null;
    }

    // Disconnect all upstreams
    await Promise.allSettled(Array.from(this.upstreams.values()).map((u) => u.disconnect()));

    logger.info('Proxy server stopped');
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // Health check
    if (url === '/health' && req.method === 'GET') {
      const body = JSON.stringify({
        status: 'ok',
        upstreams: this.getUpstreamNames(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    // Parse /proxy/{server-name} route
    const match = url.match(/^\/proxy\/([^/]+)/);
    if (!match) {
      logger.warn('Proxy route not found', { url });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    let serverName: string;
    try {
      serverName = decodeURIComponent(match[1]);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request', message: 'Invalid server name encoding' }));
      return;
    }
    const upstream = this.upstreams.get(serverName);
    if (!upstream) {
      logger.warn('Unknown upstream requested', { serverName });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_not_found' }));
      return;
    }

    // Read request body (for POST/DELETE; empty for GET)
    let body: Buffer;
    try {
      body = await readBody(req, this.bodyTimeoutMs, this.maxBodyBytes);
    } catch (err) {
      if (res.headersSent) return;
      const detailedMessage = err instanceof Error ? err.message : String(err);
      logger.error('body read error', { error: detailedMessage });
      if ((err as NodeJS.ErrnoException).code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
      } else {
        res.writeHead(408, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'request_timeout' }));
      }
      // Destroy the request so Node stops buffering inbound data.
      req.destroy();
      return;
    }

    // Forward with interception
    await this.forwardWithInterception(upstream, req, res, body);
  }

  private async forwardWithInterception(
    upstream: ProxyUpstream,
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const rpc = peekJsonRpc(body);
    const isTracked = rpc !== null && TRACKED_METHODS.has(rpc.method);

    const overallStart = performance.now();
    const result = await upstream.forward(req, res, body);
    const overallEnd = performance.now();

    if (!isTracked || !rpc) return;

    const totalDurationMs = overallEnd - overallStart;
    const proxyOverheadMs = Math.max(0, totalDurationMs - result.upstreamLatencyMs);

    if (rpc.method === 'tools/call') {
      this.emitToolCallRecord(upstream, rpc, result, totalDurationMs, proxyOverheadMs, body);
    } else {
      this.emitRequestRecord(upstream, rpc, result, totalDurationMs, proxyOverheadMs);
    }
  }

  private emitToolCallRecord(
    upstream: ProxyUpstream,
    rpc: JsonRpcPeek,
    result: ForwardResult,
    durationMs: number,
    proxyOverheadMs: number,
    body: Buffer,
  ): void {
    if (!this.onToolCall) return;

    const toolName = (typeof rpc.params?.name === 'string' ? rpc.params.name : 'unknown')
      .slice(0, 256)
      .replace(/[\x00-\x1f\x7f]/g, '');

    const args =
      typeof rpc.params?.arguments === 'object' && rpc.params.arguments !== null
        ? (rpc.params.arguments as Record<string, unknown>)
        : {};
    const filePath =
      typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.path === 'string'
          ? args.path
          : undefined;
    const command = typeof args.command === 'string' ? args.command : undefined;

    const record: ProxyToolCallRecord = {
      id: randomUUID(),
      sessionId: null,
      toolName,
      toolUseId: String(rpc.id ?? ''),
      timestamp: Date.now(),
      durationMs,
      success: result.statusCode >= 200 && result.statusCode < 300,
      serverName: upstream.name,
      upstreamLatencyMs: result.upstreamLatencyMs,
      proxyOverheadMs,
      inputSizeBytes: body.length,
      outputSizeBytes: result.responseSizeBytes ?? undefined,
      ...(filePath !== undefined && { filePath }),
      ...(command !== undefined && { command }),
    };

    this.onToolCall(record);
  }

  private emitRequestRecord(
    upstream: ProxyUpstream,
    rpc: JsonRpcPeek,
    result: ForwardResult,
    durationMs: number,
    proxyOverheadMs: number,
  ): void {
    if (!this.onRequest) return;

    const record: ProxyRequestRecord = {
      id: randomUUID(),
      serverName: upstream.name,
      method: rpc.method,
      timestamp: Date.now(),
      durationMs,
      upstreamLatencyMs: result.upstreamLatencyMs,
      proxyOverheadMs,
      success: result.statusCode >= 200 && result.statusCode < 300,
      responseSizeBytes: result.responseSizeBytes ?? undefined,
    };

    this.onRequest(record);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    if (req.method === 'GET') {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    timeoutHandle = setTimeout(() => {
      settle(() => reject(new Error(`Request body read timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timeoutHandle.unref();

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      fn();
    };

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const err = new Error(
          `Request body exceeds limit of ${maxBytes} bytes`,
        ) as NodeJS.ErrnoException;
        err.code = 'BODY_TOO_LARGE';
        settle(() => reject(err));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    req.on('error', (err) => settle(() => reject(err)));
    req.on('close', () =>
      settle(() => reject(new Error('Request closed before body was fully read'))),
    );
  });
}

function createUpstream(config: UpstreamConfig): ProxyUpstream {
  if (config.transportType === 'http') {
    return new HttpUpstream(config);
  }
  return new StdioUpstream(config);
}
