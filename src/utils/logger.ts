/**
 * Simple structured logger for the agent runtime.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private _minLevel: LogLevel;
  private _prefix: string;
  private _handlers: Array<(entry: LogEntry) => void> = [];

  constructor(prefix = 'hermes', minLevel: LogLevel = 'info') {
    this._prefix = prefix;
    this._minLevel = minLevel;
  }

  addHandler(fn: (entry: LogEntry) => void): void {
    this._handlers.push(fn);
  }

  setLevel(level: LogLevel): void {
    this._minLevel = level;
  }

  private _log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this._minLevel]) return;

    const entry: LogEntry = { level, message, timestamp: Date.now(), context };

    if (this._handlers.length > 0) {
      for (const handler of this._handlers) handler(entry);
    } else {
      const ts = new Date(entry.timestamp).toISOString();
      const prefix = `[${ts}] [${this._prefix}] [${level.toUpperCase()}]`;
      const ctx = context ? ` ${JSON.stringify(context)}` : '';
      if (level === 'error') {
        console.error(`${prefix} ${message}${ctx}`);
      } else if (level === 'warn') {
        console.warn(`${prefix} ${message}${ctx}`);
      } else {
        console.log(`${prefix} ${message}${ctx}`);
      }
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this._log('debug', message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this._log('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this._log('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this._log('error', message, context);
  }

  child(prefix: string): Logger {
    return new Logger(`${this._prefix}:${prefix}`, this._minLevel);
  }
}

export const logger = new Logger();
