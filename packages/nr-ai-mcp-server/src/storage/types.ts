export interface HookEvent {
  readonly mode: 'pre' | 'post';
  readonly tool: string;
  readonly timestamp: number;
  readonly inputHash?: string;
  readonly inputSize?: number;
  readonly outputSize?: number;
  readonly success?: boolean;
  readonly [key: string]: unknown;
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

export interface AuditEntry {
  readonly timestamp: number;
  readonly action: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}
