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
  getSessionMetadata(): PlatformSessionMetadata;
  getHookInstallInstructions(): string;
  isSupported(): boolean;
}
