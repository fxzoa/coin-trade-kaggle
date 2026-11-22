/**
 * multi-dca-bot: 構造化ロガー
 */

import { formatJstLog } from './helpers/time_helper.ts';
import { toError } from './errors.ts';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLogLevel: LogLevel = (Deno.env.get('LOG_LEVEL')?.toUpperCase() as LogLevel) || 'INFO';

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  const current = LOG_LEVEL_PRIORITY[currentLogLevel] ?? 1;
  const target = LOG_LEVEL_PRIORITY[level] ?? 1;
  return target >= current;
}

function formatMessage(level: LogLevel, message: string): string {
  const timestamp = formatJstLog();
  return `[${timestamp}] [${level}] [multi-dca-bot] ${message}`;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('DEBUG')) {
      console.debug(formatMessage('DEBUG', message), ...args);
    }
  },
  info(message: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) {
      console.info(formatMessage('INFO', message), ...args);
    }
  },
  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('WARN')) {
      console.warn(formatMessage('WARN', message), ...args);
    }
  },
  error(messageOrErr: unknown, ...args: unknown[]): void {
    if (shouldLog('ERROR')) {
      if (typeof messageOrErr === 'string') {
        console.error(formatMessage('ERROR', messageOrErr), ...args);
      } else {
        const err = toError(messageOrErr);
        console.error(formatMessage('ERROR', err.message), ...args, err.stack);
      }
    }
  },
};
