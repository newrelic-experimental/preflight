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
import { registerTools } from './tools/session-stats.js';

const logger = createLogger('mcp-server');

export class NrMcpServer {
  readonly server: Server;
  auditTrailManager: import('./security/audit-trail.js').AuditTrailManager | undefined;

  constructor(options: ServerOptions) {
    this.server = new Server(
      { name: options.name, version: options.version },
      {
        capabilities: { tools: {}, resources: {}, logging: {} },
        instructions:
          'This server monitors tool usage for observability purposes. Metrics are sent to New Relic. ' +
          'When token usage data is available after API calls, report it via nr_observe_report_tokens to enable cost tracking.',
      },
    );

    this.auditTrailManager = options.auditTrailManager;
    this.registerHandlers(options);
    logger.info('MCP server created', { name: options.name, version: options.version });
  }

  private registerHandlers(options: ServerOptions): void {
    // Register tools when any tracker is provided
    const hasTrackers =
      options.sessionTracker ||
      options.costTracker ||
      options.taskDetector ||
      options.antiPatternDetector ||
      options.efficiencyScorer ||
      options.feedbackCollector ||
      options.sessionStore ||
      options.weeklySummaryGenerator ||
      options.trendAnalyzer ||
      options.collaborationProfiler ||
      options.claudeMdTracker ||
      options.costPerOutcomeAnalyzer ||
      options.recommendationEngine;

    if (hasTrackers) {
      registerTools(this.server, {
        sessionTracker: options.sessionTracker,
        costTracker: options.costTracker,
        taskDetector: options.taskDetector,
        antiPatternDetector: options.antiPatternDetector,
        efficiencyScorer: options.efficiencyScorer,
        feedbackCollector: options.feedbackCollector,
        sessionStore: options.sessionStore,
        weeklySummaryGenerator: options.weeklySummaryGenerator,
        trendAnalyzer: options.trendAnalyzer,
        collaborationProfiler: options.collaborationProfiler,
        claudeMdTracker: options.claudeMdTracker,
        costPerOutcomeAnalyzer: options.costPerOutcomeAnalyzer,
        recommendationEngine: options.recommendationEngine,
      });
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

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];
      if (this.auditTrailManager) {
        resources.push({
          uri: 'nr-observe://session/audit-log',
          name: 'Session Audit Log',
          description: 'Security audit trail for the current session — all tool calls with classification and alerts',
          mimeType: 'application/json',
        });
      }
      return { resources };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri === 'nr-observe://session/audit-log' && this.auditTrailManager) {
        const entries = this.auditTrailManager.getAuditLog();
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(entries, null, 2),
            },
          ],
        };
      }
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
    costTracker: options?.costTracker,
    taskDetector: options?.taskDetector,
    antiPatternDetector: options?.antiPatternDetector,
    efficiencyScorer: options?.efficiencyScorer,
    feedbackCollector: options?.feedbackCollector,
    auditTrailManager: options?.auditTrailManager,
    sessionStore: options?.sessionStore,
    weeklySummaryGenerator: options?.weeklySummaryGenerator,
    trendAnalyzer: options?.trendAnalyzer,
    collaborationProfiler: options?.collaborationProfiler,
    claudeMdTracker: options?.claudeMdTracker,
    costPerOutcomeAnalyzer: options?.costPerOutcomeAnalyzer,
    recommendationEngine: options?.recommendationEngine,
  };
  return new NrMcpServer(resolved);
}
