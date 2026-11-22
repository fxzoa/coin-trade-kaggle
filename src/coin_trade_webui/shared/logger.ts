/**
 * close-trader-webui: ロガー
 */

const LOG_LEVELS: Record<string, number> = {
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
};

let currentLogLevel = 2;

export function setLogLevel(level: string): void {
  currentLogLevel = LOG_LEVELS[level.toUpperCase()] ?? 2;
}

export const logger = {
  debug(...args: unknown[]): void {
    if (currentLogLevel <= 1) {
      console.debug(`[DEBUG] ${new Date().toISOString()}`, ...args);
    }
  },
  info(...args: unknown[]): void {
    if (currentLogLevel <= 2) {
      console.log(`[INFO]  ${new Date().toISOString()}`, ...args);
    }
  },
  warn(...args: unknown[]): void {
    if (currentLogLevel <= 3) {
      console.warn(`[WARN]  ${new Date().toISOString()}`, ...args);
    }
  },
  error(...args: unknown[]): void {
    if (currentLogLevel <= 4) {
      console.error(`[ERROR] ${new Date().toISOString()}`, ...args);
    }
  },
};
