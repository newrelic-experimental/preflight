export interface HookEvent {
  /**
   * Buffer line discriminator. `pre` / `post` / `token` are the original
   * collector modes. `subagent_token`, `workflow_run`, and
   * `observability_health` are emitted by the SubagentWatcher /
   * WorkflowWatcher.
   */
  readonly mode:
    'pre' | 'post' | 'token' | 'subagent_token' | 'workflow_run' | 'observability_health';
  readonly tool: string;
  readonly timestamp: number;
  readonly inputHash?: string;
  readonly inputSize?: number;
  readonly outputSize?: number;
  readonly success?: boolean;
  readonly [key: string]: unknown;
}

export interface TokenEvent {
  readonly mode: 'token';
  readonly timestamp: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly model: string;
  readonly sessionId?: string;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly toolCallCount: number;
  readonly developer: string;
  readonly [key: string]: unknown;
}

export interface ToolCallRecord {
  readonly id: string;
  readonly sessionId: string | null;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly timestamp: number;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly errorType?: string;
  readonly error?: string;
  readonly inputSizeBytes?: number;
  readonly outputSizeBytes?: number;
  readonly inputHash?: string;
  readonly [key: string]: unknown;
}

export interface ReplayTimelineEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
  readonly isTestCommand?: boolean;
  readonly isBuildCommand?: boolean;
  readonly isLintCommand?: boolean;
  readonly errorType?: string;
}

export interface AuditEntry {
  readonly timestamp: number;
  readonly action: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

export interface SubagentTokenEvent {
  readonly mode: 'subagent_token';
  readonly timestamp: number;
  readonly agentId: string;
  readonly workflowRunId: string | null;
  readonly messageId: string;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationTokens: number;
    readonly cacheReadTokens: number;
    readonly reasoningTokens: number;
  };
  readonly parentSessionId: string;
}

export interface WorkflowRunEvent {
  readonly mode: 'workflow_run';
  readonly timestamp: number;
  readonly workflowRunId: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly totalTokens: number;
  readonly agentCount: number;
  readonly workflowName: string;
  readonly phases: readonly string[];
  readonly workflowProgress: ReadonlyArray<{
    readonly type?: string;
    readonly state?: string;
    readonly agentId?: string;
  }>;
  readonly parentSessionId: string;
}
