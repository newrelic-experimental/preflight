import type {
  NormalizedToolCall,
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
} from './types.js';

export interface ReportToolCallInput {
  readonly tool: string;
  readonly input?: Record<string, unknown>;
  readonly output_size_bytes?: number;
  readonly success: boolean;
  readonly duration_ms?: number;
  readonly error?: string;
  readonly timestamp?: number;
}

export interface ReportSessionStartInput {
  readonly platform: string;
  readonly model?: string;
  readonly developer?: string;
}

export interface ReportSessionEndInput {
  readonly summary?: string;
}

export const REPORT_TOOL_CALL_TOOL = {
  name: 'nr_observe_report_tool_call',
  description:
    'Report a tool call event for observability. Use this to report non-MCP tool calls ' +
    '(file reads, writes, terminal commands) that your AI assistant performs. ' +
    'MCP tool calls are captured automatically via the proxy.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tool: { type: 'string', description: 'Tool name (e.g., "Read", "Edit", "Bash")' },
      input: { type: 'object', description: 'Tool input parameters' },
      output_size_bytes: { type: 'number', description: 'Size of tool output in bytes' },
      success: { type: 'boolean', description: 'Whether the tool call succeeded' },
      duration_ms: { type: 'number', description: 'Duration of the tool call in milliseconds' },
      error: { type: 'string', description: 'Error message if the tool call failed' },
      timestamp: { type: 'number', description: 'Epoch milliseconds when the call occurred (defaults to now)' },
    },
    required: ['tool', 'success'],
  },
} as const;

export const REPORT_SESSION_START_TOOL = {
  name: 'nr_observe_report_session_start',
  description:
    'Report that a new AI coding session has begun. Call this at the start of a session ' +
    'to initialize session metadata for observability.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      platform: { type: 'string', description: 'Platform name (e.g., "my-ai-assistant")' },
      model: { type: 'string', description: 'AI model being used' },
      developer: { type: 'string', description: 'Developer name or identifier' },
    },
    required: ['platform'],
  },
} as const;

export const REPORT_SESSION_END_TOOL = {
  name: 'nr_observe_report_session_end',
  description:
    'Report that the current AI coding session has ended. Call this at the end of a session ' +
    'to finalize session metrics.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string', description: 'Brief summary of what was accomplished' },
    },
  },
} as const;

export function validateReportToolCallInput(raw: unknown): ReportToolCallInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Input must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.tool !== 'string' || obj.tool.length === 0) {
    throw new Error('Missing required field: tool');
  }
  if (typeof obj.success !== 'boolean') {
    throw new Error('Missing required field: success');
  }
  return obj as unknown as ReportToolCallInput;
}

export class GenericMcpAdapter implements PlatformAdapter {
  readonly platformName = 'generic-mcp';

  private sessionMetadata: PlatformSessionMetadata = { platform: 'generic-mcp' };

  async initialize(_config: PlatformConfig): Promise<void> {
    // Generic adapter requires no initialization — it accepts events via MCP tools.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const input = validateReportToolCallInput(raw);

    return {
      toolName: input.tool,
      platformToolName: input.tool,
      platform: this.sessionMetadata.platform,
      timestamp: input.timestamp ?? Date.now(),
      durationMs: input.duration_ms ?? null,
      success: input.success,
      ...(input.error !== undefined && { error: input.error }),
      ...(input.output_size_bytes !== undefined && { outputSizeBytes: input.output_size_bytes }),
      ...(input.input !== undefined && typeof input.input === 'object' && 'file_path' in input.input &&
        typeof input.input.file_path === 'string' && { filePath: input.input.file_path }),
      ...(input.input !== undefined && typeof input.input === 'object' && 'command' in input.input &&
        typeof input.input.command === 'string' && { command: input.input.command }),
    };
  }

  handleSessionStart(input: ReportSessionStartInput): void {
    this.sessionMetadata = {
      platform: input.platform || 'generic-mcp',
      ...(input.model !== undefined && { model: input.model }),
      ...(input.developer !== undefined && { developer: input.developer }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return { ...this.sessionMetadata };
  }

  getHookInstallInstructions(): string {
    return [
      'Generic MCP Client Setup:',
      '1. Add this MCP server to your AI assistant\'s MCP configuration',
      '   Command: npx nr-ai-mcp-server --stdio',
      '2. Set environment variables: NEW_RELIC_LICENSE_KEY, NEW_RELIC_ACCOUNT_ID',
      '3. MCP tool calls are captured automatically via the proxy',
      '4. Use nr_observe_report_tool_call to report non-MCP tool activity',
      '5. Use nr_observe_report_session_start / nr_observe_report_session_end for session tracking',
    ].join('\n');
  }

  isSupported(): boolean {
    return true;
  }

  getToolDefinitions(): readonly [typeof REPORT_TOOL_CALL_TOOL, typeof REPORT_SESSION_START_TOOL, typeof REPORT_SESSION_END_TOOL] {
    return [REPORT_TOOL_CALL_TOOL, REPORT_SESSION_START_TOOL, REPORT_SESSION_END_TOOL];
  }
}
