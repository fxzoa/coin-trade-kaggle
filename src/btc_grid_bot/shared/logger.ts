/**
 * btc-grid-deno: ロギングモジュール
 */

import { getJstLogString } from './helpers/time_helper.ts';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

let currentLogLevel: LogLevel = (Deno.env.get('LOG_LEVEL')?.toUpperCase() as LogLevel) || 'INFO';

export function setLogLevel(level: LogLevel) {
  currentLogLevel = level;
}

function formatMessage(level: LogLevel, message: string): string {
  const nowJst = getJstLogString();
  return `[${nowJst}] [${level}] [btc-grid-deno] ${message}`;
}

export const logger = {
  debug(message: string, ...args: unknown[]) {
    if (LOG_LEVEL_PRIORITY[currentLogLevel] <= LOG_LEVEL_PRIORITY.DEBUG) {
      console.debug(formatMessage('DEBUG', message), ...args);
    }
  },
  info(message: string, ...args: unknown[]) {
    if (LOG_LEVEL_PRIORITY[currentLogLevel] <= LOG_LEVEL_PRIORITY.INFO) {
      console.info(formatMessage('INFO', message), ...args);
    }
  },
  warn(message: string, ...args: unknown[]) {
    if (LOG_LEVEL_PRIORITY[currentLogLevel] <= LOG_LEVEL_PRIORITY.WARN) {
      console.warn(formatMessage('WARN', message), ...args);
    }
  },
  error(message: string, ...args: unknown[]) {
    if (LOG_LEVEL_PRIORITY[currentLogLevel] <= LOG_LEVEL_PRIORITY.ERROR) {
      console.error(formatMessage('ERROR', message), ...args);
    }
  },
};
