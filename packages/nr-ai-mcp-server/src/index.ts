#!/usr/bin/env node
import { Command } from 'commander';
import { VERSION, createLogger } from '@nr-ai-observatory/shared';
import { createServer } from './server.js';
import type { CliOptions } from './types.js';

export { VERSION };
export { NrMcpServer, createServer } from './server.js';
export { loadMcpConfig, redactSensitive } from './config.js';
export type { McpServerConfig } from './config.js';
export { LocalStore } from './storage/index.js';
export type { HookEvent, SessionSummary, AuditEntry } from './storage/index.js';
export type { CliOptions, ServerOptions } from './types.js';

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

  const server = createServer();

  if (options.stdio) {
    await server.connectStdio();
    logger.info('Server running on stdio transport');
  } else {
    logger.error('HTTP transport not yet implemented. Use --stdio flag.');
    process.exit(1);
  }

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
}

// Only run main() when executed directly (not when imported for testing)
if (process.argv[1] && /index\.[jt]s$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    logger.error('Fatal error', { error: String(err) });
    process.exit(1);
  });
}
