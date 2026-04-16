import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { VERSION, createLogger } from '@nr-ai-observatory/shared';
import type { ServerOptions } from './types.js';
import { registerSessionTools } from './tools/session-stats.js';

const logger = createLogger('mcp-server');

export class NrMcpServer {
  readonly server: Server;

  constructor(options: ServerOptions) {
    this.server = new Server(
      { name: options.name, version: options.version },
      {
        capabilities: { tools: {}, resources: {}, logging: {} },
        instructions:
          'This server monitors tool usage for observability purposes. Metrics are sent to New Relic.',
      },
    );

    this.registerHandlers(options);
    logger.info('MCP server created', { name: options.name, version: options.version });
  }

  private registerHandlers(options: ServerOptions): void {
    // Session tools (when a tracker is provided)
    if (options.sessionTracker) {
      registerSessionTools(this.server, options.sessionTracker);
    } else {
      this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [],
      }));

      this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`,
        );
      });
    }

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unknown resource: ${request.params.uri}`,
      );
    });
  }

  async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('MCP server connected via stdio transport');
  }

  async close(): Promise<void> {
    await this.server.close();
    logger.info('MCP server closed');
  }
}

export function createServer(options?: Partial<ServerOptions>): NrMcpServer {
  const resolved: ServerOptions = {
    name: options?.name ?? 'nr-ai-observability',
    version: options?.version ?? VERSION,
    sessionTracker: options?.sessionTracker,
  };
  return new NrMcpServer(resolved);
}
