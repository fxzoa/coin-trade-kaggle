/**
 * 構造化ロガー実装
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

let currentLevel: LogLevel = "INFO";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatLog(level: LogLevel, message: string, ...args: unknown[]): void {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;
  if (level === "ERROR") {
    console.error(prefix, message, ...args);
  } else if (level === "WARN") {
    console.warn(prefix, message, ...args);
  } else {
    console.log(prefix, message, ...args);
  }
}

export const logger = {
  debug: (message: string, ...args: unknown[]) =>
    formatLog("DEBUG", message, ...args),
  info: (message: string, ...args: unknown[]) =>
    formatLog("INFO", message, ...args),
  warn: (message: string, ...args: unknown[]) =>
    formatLog("WARN", message, ...args),
  error: (message: string, ...args: unknown[]) =>
    formatLog("ERROR", message, ...args),
};
