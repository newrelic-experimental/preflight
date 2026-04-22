/**
 * Stdio Upstream — bridges HTTP to a stdio-based MCP server.
 *
 * Spawns a child process via the MCP SDK Client + StdioClientTransport,
 * parses incoming JSON-RPC from HTTP, dispatches through the Client, and
 * serializes the response back to the HTTP response.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { createLogger } from '@nr-ai-observatory/shared';
import type { ForwardResult, ProxyUpstream, UpstreamConfig } from './types.js';

const logger = createLogger('proxy-stdio');

const DISCONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function parseJsonRpc(body: Buffer): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(body.toString('utf-8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'method' in parsed &&
      typeof (parsed as Record<string, unknown>).method === 'string'
    ) {
      return parsed as JsonRpcRequest;
    }
    return null;
  } catch {
    return null;
  }
}

function writeJsonRpcResponse(
  res: ServerResponse,
  id: string | number | undefined,
  result: unknown,
): number {
  const body = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
  return Buffer.byteLength(body);
}

function writeJsonRpcError(
  res: ServerResponse,
  id: string | number | undefined,
  code: number,
  message: string,
): number {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  });
  const statusCode = code === -32700 ? 400 : 500;
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
  return Buffer.byteLength(body);
}

// ---------------------------------------------------------------------------
// StdioUpstream
// ---------------------------------------------------------------------------

export class StdioUpstream implements ProxyUpstream {
  readonly name: string;
  readonly transportType = 'stdio' as const;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly config: UpstreamConfig;

  constructor(config: UpstreamConfig) {
    if (!config.command) {
      throw new Error(`StdioUpstream "${config.name}" requires a command`);
    }
    this.name = config.name;
    this.config = config;
  }

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.config.command!,
      args: this.config.args,
      env: this.config.env,
      stderr: 'pipe',
    });

    this.client = new Client(
      { name: `proxy-${this.name}`, version: '1.0.0' },
    );

    await this.client.connect(this.transport);
    logger.info(`Stdio upstream "${this.name}" connected`, {
      command: this.config.command,
      args: this.config.args,
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;

    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        client.close(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('disconnect timeout')),
            DISCONNECT_TIMEOUT_MS,
          );
          timeoutId.unref();
        }),
      ]);
    } catch {
      logger.warn(`Stdio upstream "${this.name}" close timed out after ${DISCONNECT_TIMEOUT_MS}ms — force-killing process`);
      const proc = (transport as unknown as { _process?: { kill(signal?: string): void } })._process;
      proc?.kill('SIGKILL');
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }

    logger.info(`Stdio upstream "${this.name}" disconnected`);
  }

  async forward(
    _req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<ForwardResult> {
    if (!this.client) {
      const size = writeJsonRpcError(res, undefined, -32603, 'Upstream not connected');
      return {
        statusCode: 500,
        isStreaming: false,
        responseSizeBytes: size,
        upstreamLatencyMs: 0,
      };
    }

    const rpc = parseJsonRpc(body);
    if (!rpc) {
      const size = writeJsonRpcError(res, undefined, -32700, 'Parse error: invalid JSON-RPC');
      return {
        statusCode: 400,
        isStreaming: false,
        responseSizeBytes: size,
        upstreamLatencyMs: 0,
      };
    }

    const start = performance.now();

    try {
      const result = await this.dispatchToClient(rpc);
      const upstreamLatencyMs = performance.now() - start;
      const size = writeJsonRpcResponse(res, rpc.id, result);

      return {
        statusCode: 200,
        isStreaming: false,
        responseSizeBytes: size,
        upstreamLatencyMs,
      };
    } catch (err: unknown) {
      const upstreamLatencyMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Stdio upstream error', { upstream: this.name, method: rpc.method, error: message });

      const size = writeJsonRpcError(res, rpc.id, -32603, message);
      return {
        statusCode: 500,
        isStreaming: false,
        responseSizeBytes: size,
        upstreamLatencyMs,
      };
    }
  }

  private async dispatchToClient(rpc: JsonRpcRequest): Promise<unknown> {
    const client = this.client!;
    const params = rpc.params ?? {};

    switch (rpc.method) {
      case 'tools/call':
        return client.callTool(params as Parameters<typeof client.callTool>[0]);

      case 'tools/list':
        return client.listTools(params as Parameters<typeof client.listTools>[0]);

      case 'resources/list':
        return client.listResources(params as Parameters<typeof client.listResources>[0]);

      case 'resources/read':
        return client.readResource(params as Parameters<typeof client.readResource>[0]);

      case 'ping':
        return client.ping();

      case 'initialize':
        // The Client has already initialized; return current server info
        return {
          protocolVersion: '2025-03-26',
          capabilities: client.getServerCapabilities() ?? {},
          serverInfo: client.getServerVersion() ?? { name: this.name, version: '0.0.0' },
        };

      default:
        // Generic passthrough for any other JSON-RPC method
        return client.request(
          { method: rpc.method, params } as Parameters<typeof client.request>[0],
          z.any(),
        );
    }
  }
}
