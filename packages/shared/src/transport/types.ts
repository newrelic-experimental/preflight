export interface NrMetric {
  name: string;
  type: 'gauge' | 'count' | 'summary';
  value: number;
  timestamp: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface TransportOptions {
  /** NR account ID — required for Events API URL path. */
  accountId: string;
  /** Override collector host; used for EU region routing or custom endpoints. */
  collectorHost?: string | null;
  /** Max retry attempts for retryable errors. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay in ms for backoff cap. Default: 30000. */
  maxDelayMs?: number;
}

export interface TransportResult {
  success: boolean;
  statusCode: number | null;
  retryCount: number;
  error?: string;
}

export interface HttpSendOptions {
  url: string;
  body: unknown;
  licenseKey: string;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
