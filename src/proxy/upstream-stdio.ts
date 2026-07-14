/**
 * Stdio Upstream — bridges HTTP to a stdio-based MCP server.
 *
 * Spawns a child process via the MCP SDK Client + StdioClientTransport,
 * parses incoming JSON-RPC from HTTP, dispatches through the Client, and
 * serializes the response back to the HTTP response.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { createLogger } from '../shared/index.js';
import type { ForwardResult, ProxyUpstream, UpstreamConfig } from './types.js';

const logger = createLogger('proxy-stdio');

// ---------------------------------------------------------------------------
// Env sanitization — strips keys that enable dynamic-linker or Node injection.
// Note: PATH is intentionally NOT listed here. StdioClientTransport (MCP SDK)
// spreads getDefaultEnvironment() before applying this env, so stripping PATH
// from the caller-supplied env has no effect — PATH always flows through.
// PATH hijacking is prevented instead by validateCommand requiring absolute paths.
// ---------------------------------------------------------------------------

export const DANGEROUS_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'PERL5LIB',
  'LD_AUDIT',
  'GCONV_PATH',
  'BASH_ENV',
  'ENV',
  'ELECTRON_RUN_AS_NODE',
]);

export function sanitizeEnv(
  env: Record<string, string> | undefined,
  upstreamName: string,
): Record<string, string> | undefined {
  if (!env) return undefined;

  const sanitized: Record<string, string> = {};
  const stripped: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (DANGEROUS_ENV_KEYS.has(key)) {
      stripped.push(key);
    } else {
      sanitized[key] = value;
    }
  }

  if (stripped.length > 0) {
    logger.warn(`StdioUpstream "${upstreamName}": stripped dangerous env keys`, { keys: stripped });
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// Command validation — requires absolute paths to prevent PATH hijacking
// ---------------------------------------------------------------------------

export function validateCommand(
  upstreamName: string,
  command: string,
  allowBareCommand: boolean,
): void {
  if (!allowBareCommand && !isAbsolute(command)) {
    throw new Error(
      `StdioUpstream "${upstreamName}": command "${command}" must be an absolute path ` +
        `(bare names can be hijacked via PATH manipulation). ` +
        `Use the full path (e.g. /usr/bin/node) or set allowBareCommand for development.`,
    );
  }
}

const DISCONNECT_TIMEOUT_MS = 5_000;
const DISPATCH_TIMEOUT_MS = 30_000;

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
    const command = this.config.command!;
    validateCommand(this.name, command, this.config.allowBareCommand ?? false);

    logger.info(`Stdio upstream "${this.name}" starting`, { command, args: this.config.args });

    this.transport = new StdioClientTransport({
      command,
      args: this.config.args,
      env: sanitizeEnv(this.config.env, this.name),
      stderr: 'pipe',
    });

    this.client = new Client({ name: `proxy-${this.name}`, version: '1.0.0' });

    await this.client.connect(this.transport);
    logger.info(`Stdio upstream "${this.name}" connected`, { command, args: this.config.args });

    // Detect unexpected child process exit so subsequent requests fail fast
    // instead of hanging on a dead client.
    this.transport.onclose = () => {
      if (this.client !== null) {
        logger.warn(
          `Stdio upstream "${this.name}" process exited unexpectedly — marking disconnected`,
        );
        this.client = null;
        this.transport = null;
      }
    };
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
      if (timeoutId !== null) clearTimeout(timeoutId);
    } catch {
      if (timeoutId !== null) clearTimeout(timeoutId);
      logger.warn(
        `Stdio upstream "${this.name}" close timed out after ${DISCONNECT_TIMEOUT_MS}ms — force-killing process`,
      );
      // Access the child process via the MCP SDK's private field. If the field
      // is renamed in a future SDK version, the optional-chain gracefully no-ops
      // rather than throwing, and the OS will clean up the orphaned child when
      // this process exits.
      const maybeProc = (transport as unknown as Record<string, unknown>)['_process'] as
        { kill(signal?: string): void } | undefined;
      maybeProc?.kill('SIGKILL');
    }

    logger.info(`Stdio upstream "${this.name}" disconnected`);
  }

  async forward(_req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<ForwardResult> {
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
      logger.error('Stdio upstream error', {
        upstream: this.name,
        method: rpc.method,
        error: message,
      });

      // -32603 is JSON-RPC's standard "Internal error" code — reuse its own name as the
      // generic client-facing message. The real detail (child-process error text, which
      // may contain file paths or tool-echoed arguments) stays in the logger call above.
      const size = writeJsonRpcError(res, rpc.id, -32603, 'Internal error');
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
    const controller = new AbortController();
    const options = { signal: controller.signal };

    // Wrap the dispatch in a timeout so a hung child process doesn't hold
    // the HTTP connection open indefinitely. Aborting the underlying SDK
    // call (not just racing past it) stops the abandoned request from
    // continuing to run against the child process with nothing awaiting it.
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        controller.abort();
        reject(new Error(`Stdio dispatch timeout after ${DISPATCH_TIMEOUT_MS}ms`));
      }, DISPATCH_TIMEOUT_MS);
      t.unref();
    });

    let dispatchPromise: Promise<unknown>;
    switch (rpc.method) {
      case 'tools/call':
        dispatchPromise = client.callTool(
          params as Parameters<typeof client.callTool>[0],
          undefined,
          options,
        );
        break;
      case 'tools/list':
        dispatchPromise = client.listTools(
          params as Parameters<typeof client.listTools>[0],
          options,
        );
        break;
      case 'resources/list':
        dispatchPromise = client.listResources(
          params as Parameters<typeof client.listResources>[0],
          options,
        );
        break;
      case 'resources/read':
        dispatchPromise = client.readResource(
          params as Parameters<typeof client.readResource>[0],
          options,
        );
        break;
      case 'ping':
        dispatchPromise = client.ping(options);
        break;
      case 'initialize':
        // The Client has already initialized; return current server info synchronously.
        return {
          protocolVersion: '2025-03-26',
          capabilities: client.getServerCapabilities() ?? {},
          serverInfo: client.getServerVersion() ?? { name: this.name, version: '0.0.0' },
        };
      default:
        dispatchPromise = client.request(
          { method: rpc.method, params } as Parameters<typeof client.request>[0],
          z.any(),
          options,
        );
    }

    return Promise.race([dispatchPromise, timeoutPromise]);
  }
}
