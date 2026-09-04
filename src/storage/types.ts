interface HookEventBase {
  readonly tool: string;
  readonly timestamp: number;
  /**
   * True originating platform, stamped by the collector in the hook
   * subprocess, where platform env signals actually exist. Absent on lines
   * written by older collectors and by watchers.
   */
  readonly platform?: string;
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
  /** Set when this tool call was made by a subagent (code.claude.com/docs/en/hooks.md). */
  readonly agentId?: string;
  /** The subagent's type, or the session's `--agent` type. */
  readonly agentType?: string;
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
  /** Set when this tool call was made by a subagent (code.claude.com/docs/en/hooks.md). */
  readonly agentId?: string;
  /** The subagent's type, or the session's `--agent` type. */
  readonly agentType?: string;
  /**
   * Claude Code's own reported tool-execution time (ms), excluding
   * permission-prompt wait time and PreToolUse hook execution. When present,
   * `HookEventProcessor` prefers this over the pre/post wall-clock delta for
   * `ToolCallRecord.durationMs`, and derives `permissionWaitMs` from the gap
   * between the two.
   */
  readonly nativeDurationMs?: number;
}

/**
 * Emitted when a gated tool call awaits user approval (Claude Code's
 * PermissionRequest hook). Marks the pending `PreHookEvent` with the same
 * toolUseId as permission-requested; a rejection produces no further hook
 * event, so `HookEventProcessor` infers it when the marked entry expires.
 */
export interface PermissionRequestHookEvent extends HookEventBase {
  readonly mode: 'permission_request';
  readonly toolUseId: string;
  readonly sessionId?: string;
}

/**
 * Emitted when auto permission mode denies a tool call by policy (Claude
 * Code's PermissionDenied hook). Completes the pending `PreHookEvent` with
 * the same toolUseId as errorType 'denied'.
 */
export interface PermissionDeniedHookEvent extends HookEventBase {
  readonly mode: 'permission_denied';
  readonly toolUseId: string;
  readonly sessionId?: string;
  readonly deniedReason?: string;
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
  /** Anthropic message id (msg_...) — used to dedupe replayed turns after a cursor-based re-read. */
  readonly messageId?: string;
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
 * Emitted by Claude Code's StopFailure hook when a turn ends because the
 * model-API call ultimately failed after Claude Code's own internal retries
 * are exhausted (code.claude.com/docs/en/hooks.md). `errorType` is the raw
 * Claude Code error string (e.g. 'rate_limit') — not yet mapped to
 * `ApiErrorType`; that mapping happens downstream in
 * `metrics/api-failure-tracker.ts`, which this file must not depend on.
 */
export interface ApiFailureHookEvent extends HookEventBase {
  readonly mode: 'api_failure';
  readonly sessionId?: string;
  readonly errorType: string;
  readonly errorDetails?: string;
  readonly lastAssistantMessage?: string;
}

/**
 * Emitted by Claude Code's SessionStart hook (code.claude.com/docs/en/hooks.md).
 * Fires on every session (startup/resume/clear/compact/fork) — `source`
 * distinguishes which. Only a `source` of `'resume'`/`'fork'` with a
 * transcript that already has a response carries the four resume-cost
 * fields below (Claude Code v2.1.251+); they're `undefined` for every other
 * `source`, and this event is only actionable when they're present.
 */
export interface SessionStartHookEvent extends HookEventBase {
  readonly mode: 'session_start';
  readonly sessionId?: string;
  readonly source?: string;
  readonly secondsSinceLastResponse?: number;
  readonly contextTokens?: number;
  readonly promptCacheLikelyExpired?: boolean;
  readonly estimatedCacheWriteUsd?: number;
}

/**
 * Emitted by Claude Code's InstructionsLoaded hook, which fires each time a
 * `CLAUDE.md` or `.claude/rules/*.md` file is loaded into context —
 * including at session start (`loadReason: 'session_start'`), a moment no
 * tool-call-based heuristic can observe at all, since Claude Code loads
 * eager instruction files internally with no visible `Read` call
 * (code.claude.com/docs/en/hooks.md).
 */
export interface InstructionsLoadedHookEvent extends HookEventBase {
  readonly mode: 'instructions_loaded';
  readonly sessionId?: string;
  readonly filePath: string;
  readonly memoryType?: string;
  readonly loadReason?: string;
}

/**
 * Emitted by Claude Code's PostModelSwitch hook after the session's model
 * changes (code.claude.com/docs/en/hooks.md). Only `PostModelSwitch` is
 * installed — `PreModelSwitch` exists to block/confirm a switch, which
 * Preflight has no reason to do, and every field here is also present on
 * PostModelSwitch's own input.
 *
 * `source` is `'command'`/`'picker'`/`'sdk'` for a deliberate switch,
 * `'auto'` for a persistent automatic change (e.g. a sustained fallback),
 * or `'resume'` for the model restored on session resume. Claude Code does
 * NOT fire this hook for a single-turn fallback-model-chain substitution
 * that leaves the session's nominal model unchanged — that specific case
 * stays invisible, `source: 'auto'` only covers a persistent switch.
 */
export interface ModelSwitchHookEvent extends HookEventBase {
  readonly mode: 'model_switch';
  readonly sessionId?: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly requestedModel?: string | null;
  readonly source?: string;
}

/**
 * Emitted by Claude Code's UserPromptSubmit hook, which fires when the user
 * submits a prompt, before Claude processes it (code.claude.com/docs/en/hooks.md).
 * Deliberately carries no content — the `prompt` field itself is free text
 * this file has no reason to capture; only its timestamp matters, as a
 * precise "a new task started here" boundary for `TaskDetector`.
 */
export interface UserPromptSubmitHookEvent extends HookEventBase {
  readonly mode: 'user_prompt_submit';
  readonly sessionId?: string;
}

/**
 * Emitted by Claude Code's Stop hook, which fires when the main agent has
 * finished responding — does NOT fire on a user interrupt, so this is a
 * corroborating precise signal, not a full replacement for the existing
 * idle-gap heuristics in `TurnTracker`/`TaskDetector` (code.claude.com/docs/en/hooks.md).
 * Deliberately carries no content — `last_assistant_message`,
 * `background_tasks`, and `session_crons` are all real fields on this hook's
 * input, but none of them are needed just to mark "a turn/task ended here".
 */
export interface StopHookEvent extends HookEventBase {
  readonly mode: 'stop';
  readonly sessionId?: string;
}

/**
 * Buffer line discriminated union. `pre`/`post`/`token` are the original
 * collector modes; `permission_request`/`permission_denied` are collector
 * modes for Claude Code's permission hooks. `subagent_token`, `workflow_run`,
 * and `observability_health` are emitted by the SubagentWatcher / WorkflowWatcher.
 * `api_failure` is emitted by the collector for Claude Code's StopFailure
 * hook, `session_start` for its SessionStart hook, `instructions_loaded` for
 * its InstructionsLoaded hook, `model_switch` for its PostModelSwitch hook,
 * `user_prompt_submit`/`stop` for its UserPromptSubmit/Stop hooks.
 */
export type HookEvent =
  | PreHookEvent
  | PostHookEvent
  | PermissionRequestHookEvent
  | PermissionDeniedHookEvent
  | TokenHookEvent
  | SubagentTokenHookEvent
  | WorkflowRunEvent
  | ObservabilityHealthHookEvent
  | ApiFailureHookEvent
  | SessionStartHookEvent
  | InstructionsLoadedHookEvent
  | ModelSwitchHookEvent
  | UserPromptSubmitHookEvent
  | StopHookEvent;

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
  /**
   * Tool execution time. Sourced from Claude Code's own `duration_ms` (see
   * `PostHookEvent.nativeDurationMs`) when available — excludes
   * permission-prompt wait time and PreToolUse hook execution. Falls back to
   * the pre/post hook wall-clock delta on platforms/versions that don't send
   * `duration_ms`, in which case it still includes that wait time.
   */
  readonly durationMs: number | null;
  /**
   * Wall-clock time this tool call spent on permission-prompt/PreToolUse-hook
   * overhead, i.e. the gap `durationMs` above deliberately excludes: the
   * pre/post wall-clock delta minus the native `duration_ms`. `null` when no
   * native `duration_ms` was available to decompose against (in that case
   * `durationMs` itself is the undecomposed wall-clock delta, not 0 overhead).
   * A local single-developer dashboard is the intended consumer — this is
   * "time spent waiting on you", not a tool-speed metric.
   */
  readonly permissionWaitMs?: number | null;
  readonly success: boolean;
  readonly errorType?: string;
  readonly error?: string;
  readonly inputSizeBytes?: number;
  readonly outputSizeBytes?: number;
  readonly inputHash?: string;
  /**
   * Which subagent made this tool call, straight from the hook payload's
   * `agent_id` (see `PreHookEvent.agentId`/`PostHookEvent.agentId`). Absent
   * for tool calls made by the parent/orchestrator session. Distinct from —
   * and a different signal than — the `agentId` `SubagentWatcher` derives
   * from transcript filenames for subagent *token usage* attribution; that
   * pipeline is untouched by this field.
   */
  readonly agentId?: string;
  readonly agentType?: string;
  /** Skill invoked, from the hook's `tool_input.skill`; only on `toolName === 'Skill'` records. */
  readonly skillName?: string;
  /** Length of the free-text `tool_input.args`; the text itself is never recorded. */
  readonly skillArgsLength?: number;
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
  // Optional because legacy on-disk records predate this field.
  readonly id?: string;
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
