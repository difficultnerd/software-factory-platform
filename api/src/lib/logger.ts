/**
 * @file Structured logger
 * @purpose Provides consistent JSON logging across the platform
 * @invariants All log entries must include event, outcome, and timestamp
 */

interface LogEntry {
  event: string;
  actor?: string;
  outcome: 'success' | 'failure' | 'info';
  metadata?: Record<string, unknown>;
}

function emit(level: string, entry: LogEntry): void {
  const record = {
    ...entry,
    level,
    timestamp: new Date().toISOString(),
  };

  if (level === 'error') {
    console.error(JSON.stringify(record));
  } else {
    console.log(JSON.stringify(record));
  }
}

export const logger = {
  info: (entry: LogEntry) => emit('info', entry),
  warn: (entry: LogEntry) => emit('warn', entry),
  error: (entry: LogEntry) => emit('error', entry),
};
