export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLogLevel(): LogLevel {
  const envLevel = process.env.NEW_RELIC_AI_LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVEL_ORDER) {
    return envLevel as LogLevel;
  }
  return 'info';
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(component: string, levelOverride?: LogLevel): Logger {
  const minLevel = levelOverride ?? resolveLogLevel();
  const minLevelOrder = LOG_LEVEL_ORDER[minLevel];

  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < minLevelOrder) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...data,
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      // Fallback uses only known-safe scalar fields — avoids re-spreading
      // circular data that caused the original stringify to throw.
      serialized = JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        component: entry.component,
        message: entry.message,
        data: '[unserializable]',
      });
    }
    process.stderr.write(serialized + '\n');
  }

  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
  };
}
