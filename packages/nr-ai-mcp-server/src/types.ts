import type { LogLevel } from '@nr-ai-observatory/shared';
import type { SessionTracker } from './metrics/session-tracker.js';

export interface CliOptions {
  readonly port: number;
  readonly config: string | null;
  readonly logLevel: LogLevel;
  readonly stdio: boolean;
}

export interface ServerOptions {
  readonly name: string;
  readonly version: string;
  readonly sessionTracker?: SessionTracker;
}
