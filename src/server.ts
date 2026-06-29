import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from './shared/index.js';
import { VERSION } from './version.js';
import type { ServerOptions } from './types.js';
import { registerTools } from './tools/session-stats.js';

const logger = createLogger('mcp-server');

export class NrMcpServer {
  readonly server: Server;
  private _auditTrailManager: import('./security/audit-trail.js').AuditTrailManager | undefined;

  get auditTrailManager(): import('./security/audit-trail.js').AuditTrailManager | undefined {
    return this._auditTrailManager;
  }

  set auditTrailManager(value: import('./security/audit-trail.js').AuditTrailManager | undefined) {
    this._auditTrailManager = value;
  }

  constructor(options: ServerOptions) {
    const serverStartMs = Date.now();
    this.server = new Server(
      { name: options.name, version: options.version },
      {
        capabilities: { tools: {}, resources: {}, logging: {} },
        instructions:
          'This server monitors tool usage for observability purposes. Metrics are sent to New Relic. ' +
          'When token usage data is available after API calls, report it via nr_observe_report_tokens to enable cost tracking.',
      },
    );

    this._auditTrailManager = options.auditTrailManager;
    this.registerHandlers(options, serverStartMs);
    logger.info('MCP server created', { name: options.name, version: options.version });
  }

  private registerHandlers(options: ServerOptions, serverStartMs: number): void {
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
      developer: options.developer,
      teamId: options.teamId,
      projectId: options.projectId,
      sessionStartMs: serverStartMs,
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> =
        [];
      if (this.auditTrailManager) {
        resources.push({
          uri: 'nr-observe://session/audit-log',
          name: 'Session Audit Log',
          description:
            'Security audit trail for the current session — all tool calls with classification and alerts',
          mimeType: 'application/json',
        });
      }
      return { resources };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
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
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${request.params.uri}`);
      } catch (err) {
        if (err instanceof McpError) throw err;
        logger.error('Resource handler error', { uri: request.params.uri, error: String(err) });
        throw err;
      }
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
    name: options?.name ?? 'preflight',
    version: options?.version ?? VERSION,
    developer: options?.developer,
    teamId: options?.teamId,
    projectId: options?.projectId,
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
