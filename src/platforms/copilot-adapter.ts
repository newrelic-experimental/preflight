import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

/**
 * Event types forwarded by a Copilot-compatible VS Code extension via HTTP.
 * This adapter only consumes its events.
 */
export interface CopilotToolCallEvent {
  readonly type:
    | 'file_edit'
    | 'file_open'
    | 'file_create'
    | 'file_delete'
    | 'terminal_command'
    | 'task';
  readonly timestamp?: number;
  readonly endTimestamp?: number;
  readonly filePath?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly error?: string;
  readonly inputSizeBytes?: number;
  readonly outputSizeBytes?: number;
  readonly sessionId?: string;
  readonly [key: string]: unknown;
}

const COPILOT_EVENT_TYPE_MAP: Record<string, string> = {
  file_edit: 'Edit',
  file_open: 'Read',
  file_create: 'Write',
  file_delete: 'Delete',
  terminal_command: 'Bash',
  task: 'Bash',
};

export interface CopilotUsageRecord {
  readonly day: string;
  readonly total_suggestions_count?: number;
  readonly total_acceptances_count?: number;
  readonly total_lines_suggested?: number;
  readonly total_lines_accepted?: number;
  readonly total_active_users?: number;
  readonly [key: string]: unknown;
}

export function parseCopilotUsageResponse(raw: unknown): CopilotUsageRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is CopilotUsageRecord =>
      typeof item === 'object' && item !== null && typeof item.day === 'string',
  );
}

export class CopilotAdapter implements PlatformAdapter {
  readonly platformName = 'copilot';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Copilot does not use MCP natively. Data arrives from
    // a Copilot VS Code extension via HTTP.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as CopilotToolCallEvent;
    const eventType = event.type ?? 'unknown';
    const toolName = COPILOT_EVENT_TYPE_MAP[eventType] ?? 'Unknown';

    const timestamp = event.timestamp ?? Date.now();
    const durationMs =
      event.timestamp !== undefined && event.endTimestamp !== undefined
        ? Math.max(0, event.endTimestamp - event.timestamp)
        : null;

    return {
      toolName,
      platformToolName: eventType,
      platform: this.platformName,
      timestamp,
      durationMs,
      success: event.success ?? true,
      ...(event.error !== undefined && { error: event.error }),
      ...(event.inputSizeBytes !== undefined && { inputSizeBytes: event.inputSizeBytes }),
      ...(event.outputSizeBytes !== undefined && { outputSizeBytes: event.outputSizeBytes }),
      ...(event.filePath !== undefined && { filePath: event.filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.VSCODE_VERSION && { ideVersion: process.env.VSCODE_VERSION }),
      ...(process.env.COPILOT_EXTENSION_VERSION && {
        extensionVersion: process.env.COPILOT_EXTENSION_VERSION,
      }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'GitHub Copilot Observability Setup:',
      '1. Set NEW_RELIC_AI_PLATFORM=copilot in your environment',
      '2. Set NEW_RELIC_LICENSE_KEY and NEW_RELIC_ACCOUNT_ID',
      '3. Configure your Copilot extension to forward events to http://localhost:9847',
      '   (Set "preflight.endpoint" to "http://localhost:9847" in VS Code settings)',
      '4. Note: tool call timing is approximate (inferred from VS Code event timestamps)',
    ].join('\n');
  }

  isSupported(): boolean {
    return process.env.MCP_CLIENT === 'copilot' || process.env.NEW_RELIC_AI_PLATFORM === 'copilot';
  }
}
