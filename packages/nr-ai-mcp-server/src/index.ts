#!/usr/bin/env node
import { Command } from 'commander';
import { VERSION, createLogger } from '@nr-ai-observatory/shared';
import { createServer } from './server.js';
import { loadMcpConfig } from './config.js';
import { ProxyManager } from './proxy/index.js';
import type { CliOptions } from './types.js';

export { VERSION };
export { NrMcpServer, createServer } from './server.js';
export { loadMcpConfig, redactSensitive } from './config.js';
export type { McpServerConfig } from './config.js';
export { LocalStore } from './storage/index.js';
export type { HookEvent, SessionSummary, AuditEntry } from './storage/index.js';
export type { CliOptions, ServerOptions } from './types.js';
export { ProxyManager } from './proxy/index.js';
export type { ProxyToolCallRecord, ProxyRequestRecord, UpstreamConfig } from './proxy/index.js';
export {
  ClaudeCodeAdapter,
  CursorAdapter,
  WindsurfAdapter,
  CopilotAdapter,
  parseCopilotUsageResponse,
  GenericMcpAdapter,
  validateReportToolCallInput,
  REPORT_TOOL_CALL_TOOL,
  REPORT_SESSION_START_TOOL,
  REPORT_SESSION_END_TOOL,
  PlatformRegistry,
  createDefaultRegistry,
} from './platforms/index.js';
export type {
  NormalizedToolCall,
  PlatformConfig,
  PlatformSessionMetadata,
  PlatformAdapter,
  ReportToolCallInput,
  ReportSessionStartInput,
  ReportSessionEndInput,
} from './platforms/index.js';

const logger = createLogger('mcp-cli');

export function parseArgs(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name('nr-ai-mcp-server')
    .description('New Relic MCP server for observing AI coding assistants')
    .version(VERSION)
    .option('-p, --port <number>', 'HTTP port for proxy mode', '9847')
    .option('-c, --config <path>', 'path to config file')
    .option('-l, --log-level <level>', 'log level (debug|info|warn|error)', 'info')
    .option('--stdio', 'use stdio transport (for Claude Code MCP connection)');

  program.parse(argv);
  const opts = program.opts();

  return {
    port: parseInt(opts.port, 10),
    config: opts.config ?? null,
    logLevel: opts.logLevel as CliOptions['logLevel'],
    stdio: opts.stdio ?? false,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  logger.info('Starting nr-ai-mcp-server', {
    version: VERSION,
    stdio: options.stdio,
    port: options.port,
    logLevel: options.logLevel,
  });

  if (options.stdio) {
    const server = createServer();
    await server.connectStdio();
    logger.info('Server running on stdio transport');

    const shutdown = async () => {
      logger.info('Shutting down...');
      await server.close();
      process.exit(0);
    };

    // Exit when the client disconnects (closes the stdin pipe).
    // StdioServerTransport doesn't listen for stdin 'end', so we handle it here.
    process.stdin.on('end', () => {
      logger.info('stdin closed, shutting down');
      shutdown();
    });

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else {
    // Proxy mode: start HTTP proxy server that forwards to upstream MCP servers
    const config = loadMcpConfig(options);

    if (config.proxyUpstreams.length === 0) {
      logger.error(
        'No proxy upstreams configured. Either use --stdio for direct MCP mode ' +
        'or configure proxyUpstreams in the config file.',
      );
      process.exit(1);
    }

    const proxyManager = new ProxyManager({
      port: config.port,
      onToolCall: (record) => {
        logger.debug('Proxy tool call', {
          server: record.serverName,
          tool: record.toolName,
          durationMs: record.durationMs,
        });
      },
      onRequest: (record) => {
        logger.debug('Proxy request', {
          server: record.serverName,
          method: record.method,
          durationMs: record.durationMs,
        });
      },
    });

    for (const upstream of config.proxyUpstreams) {
      proxyManager.registerUpstream(upstream);
    }

    await proxyManager.start();
    logger.info('Proxy server running', { port: config.port, upstreams: proxyManager.getUpstreamNames() });

    const shutdown = async () => {
      logger.info('Shutting down proxy...');
      await proxyManager.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// Only run main() when executed directly (not when imported for testing).
// Resolve symlinks so this also matches when invoked via the `nr-ai-mcp-server` bin link.
import { realpathSync } from 'node:fs';
const resolvedArgv1 = (() => {
  try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; }
})();
if (resolvedArgv1 && /index\.[jt]s$/.test(resolvedArgv1)) {
  main().catch((err: unknown) => {
    logger.error('Fatal error', { error: String(err) });
    process.exit(1);
  });
}
