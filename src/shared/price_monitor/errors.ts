/**
 * Shared Error definitions and utilities for Hyperliquid Price Syncer Bot.
 */

export interface AppErrorOptions {
  code?: string;
  statusCode?: number;
  context?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly context?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code ?? "INTERNAL_ERROR";
    this.statusCode = options.statusCode ?? 500;
    this.context = options.context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  try {
    return new Error(
      typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
    );
  } catch {
    return new Error(String(value));
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, {
      ...options,
      code: "CONFIG_ERROR",
      statusCode: options.statusCode ?? 500,
    });
    this.name = "ConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RedisError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, {
      ...options,
      code: "REDIS_ERROR",
      statusCode: options.statusCode ?? 502,
    });
    this.name = "RedisError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class KvError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, {
      ...options,
      code: "KV_ERROR",
      statusCode: options.statusCode ?? 500,
    });
    this.name = "KvError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UpstreamApiError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, {
      ...options,
      code: "UPSTREAM_API_ERROR",
      statusCode: options.statusCode ?? 502,
    });
    this.name = "UpstreamApiError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, {
      ...options,
      code: "VALIDATION_ERROR",
      statusCode: options.statusCode ?? 400,
    });
    this.name = "ValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, {
      ...options,
      code: "NOT_FOUND",
      statusCode: options.statusCode ?? 404,
    });
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
