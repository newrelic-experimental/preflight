interface HookEventBase {
  readonly tool: string;
  readonly timestamp: number;
}

/**
 * Emitted before a tool call executes. Buffered by the collector, paired
 * with a matching `PostHookEvent` by `HookEventProcessor`.
 */
export interface PreHookEvent extends HookEventBase {
  readonly mode: 'pre';
  readonly toolUseId?: string;
  readonly sessionId?: string;
  readonly toolInput?: unknown;
  readonly inputSize?: number;
  readonly inputHash?: string;
  readonly cwd?: string;
  readonly transcriptPath?: string;
  readonly permissionMode?: string;
}

/**
 * Emitted after a tool call completes. Paired with its `PreHookEvent` by
 * toolUseId (or FIFO tool-name fallback) to produce a `ToolCallRecord`.
 */
export interface PostHookEvent extends HookEventBase {
  readonly mode: 'post';
  readonly toolUseId?: string;
  readonly sessionId?: string;
  readonly toolInput?: unknown;
  readonly toolOutput?: unknown;
  readonly outputSize?: number;
  readonly success?: boolean;
  readonly error?: string;
  readonly isInterrupt?: boolean;
}

/** Emitted per LLM API turn with token usage; feeds CostTracker. */
export interface TokenHookEvent extends HookEventBase {
  readonly mode: 'token';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly model?: string;
  readonly sessionId?: string;
}

/** Emitted by the SubagentWatcher for each subagent assistant turn. */
export interface SubagentTokenHookEvent extends HookEventBase {
  readonly mode: 'subagent_token';
  readonly agentId?: string;
  readonly messageId?: string;
  readonly sessionId?: string;
  readonly workflowRunId?: string | null;
  readonly turnUuid?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly stopReason?: string | null;
  readonly schemaFingerprint?: string;
}

/** Emitted by the WorkflowWatcher / SubagentWatcher with pipeline health counters. */
export interface ObservabilityHealthHookEvent extends HookEventBase {
  readonly mode: 'observability_health';
  readonly watcher?: 'workflow' | 'subagent';
  readonly filesWatched?: number;
  readonly linesRead?: number;
  readonly bytesRead?: number;
  readonly parseErrors?: number;
  readonly schemaDrifts?: number;
  readonly lastError?: { code: string; class: string } | null;
  readonly event?: string;
  readonly dimension?: string;
  readonly fingerprint?: string;
  readonly workflowRunId?: string;
  readonly costSelfCheckDeltaPct?: number;
}

/**
 * Buffer line discriminated union. `pre`/`post`/`token` are the original
 * collector modes. `subagent_token`, `workflow_run`, and
 * `observability_health` are emitted by the SubagentWatcher / WorkflowWatcher.
 */
export type HookEvent =
  | PreHookEvent
  | PostHookEvent
  | TokenHookEvent
  | SubagentTokenHookEvent
  | WorkflowRunEvent
  | ObservabilityHealthHookEvent;

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

export interface WorkflowRunEvent extends HookEventBase {
  readonly mode: 'workflow_run';
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
