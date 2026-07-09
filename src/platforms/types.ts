export interface NormalizedToolCall {
  readonly toolName: string;
  readonly platformToolName: string;
  readonly platform: string;
  readonly timestamp: number;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly error?: string;
  readonly inputSizeBytes?: number;
  readonly outputSizeBytes?: number;
  readonly filePath?: string;
  readonly command?: string;
  readonly sessionId?: string;
  readonly toolUseId?: string;
  readonly inputHash?: string;
}

export interface PlatformConfig {
  readonly platform?: string;
  readonly [key: string]: unknown;
}

export interface PlatformSessionMetadata {
  readonly platform: string;
  readonly model?: string;
  readonly ideVersion?: string;
  readonly extensionVersion?: string;
  readonly [key: string]: unknown;
}

export interface PlatformAdapter {
  readonly platformName: string;
  initialize(config: PlatformConfig): Promise<void>;
  normalizeToolCall(raw: unknown): NormalizedToolCall;
  /**
   * Maps a platform's raw tool name (e.g. Kiro's `fs_read`) to Preflight's
   * canonical vocabulary (`Read`). Returns `'Unknown'` for names the adapter
   * doesn't recognize, preserving the platform's original name in telemetry
   * via the caller (never throws).
   */
  mapToolName(platformToolName: string): string;
  getSessionMetadata(): PlatformSessionMetadata;
  getHookInstallInstructions(): string;
  isSupported(): boolean;
}
