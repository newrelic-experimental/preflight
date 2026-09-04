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
import { readAndCheckHooks } from './install/install-helper.js';
import { installHooksHeadless } from './install/headless-install.js';

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
        // tools.listChanged is required, not cosmetic: when the session_id
        // can't be resolved synchronously the server first exposes only the
        // pending tool set (registerPendingTools) and swaps in the full set
        // once trackers exist, milliseconds later. A client that called
        // tools/list during that window would otherwise cache the three
        // pending tools for the life of the connection and never see
        // nr_observe_get_session_stats and friends. Declaring the capability
        // lets notifyToolListChanged() tell it to re-list.
        capabilities: { tools: { listChanged: true }, resources: {}, logging: {} },
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
      hooksInstalledFn: () => readAndCheckHooks(),
      headlessInstaller: installHooksHeadless,
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

  /**
   * Tell connected clients the tool list changed so they re-issue tools/list.
   *
   * Call this after swapping the pending tool set for the full one. Clients
   * cache tools/list from initialization, so without this a client that
   * connected during the pending window keeps only the three pending tools —
   * observed on Kiro, which listed exactly nr_observe_health,
   * nr_observe_install_hooks and nr_observe_get_config for a whole session
   * while the full set was registered server-side.
   *
   * Never throws: a client that doesn't support the notification, or a
   * transport that has already gone away, must not take down startup. Failure
   * only means that client keeps its stale list, which is the pre-existing
   * behavior.
   */
  async notifyToolListChanged(): Promise<void> {
    try {
      await this.server.sendToolListChanged();
      logger.debug('Sent tools/list_changed notification');
    } catch (err) {
      logger.debug('Could not send tools/list_changed notification', { error: String(err) });
    }
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
