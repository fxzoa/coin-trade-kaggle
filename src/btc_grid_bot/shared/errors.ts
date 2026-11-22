/**
 * hl-btc-grid-bot: エラー定義およびエラーハンドリングユーティリティ
 */

export interface AppErrorOptions extends ErrorOptions {
  code?: string;
  statusCode?: number;
  context?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly context?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options);
    this.name = 'AppError';
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.statusCode = options.statusCode ?? 500;
    this.context = options.context;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'CONFIG_ERROR', statusCode: options.statusCode ?? 500 });
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GridError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'GRID_ERROR', statusCode: options.statusCode ?? 400 });
    this.name = 'GridError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OrderError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'ORDER_ERROR', statusCode: options.statusCode ?? 400 });
    this.name = 'OrderError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HyperliquidApiError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'HYPERLIQUID_API_ERROR', statusCode: options.statusCode ?? 502 });
    this.name = 'HyperliquidApiError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class KvStoreError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'KV_STORE_ERROR', statusCode: options.statusCode ?? 500 });
    this.name = 'KvStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'VALIDATION_ERROR', statusCode: options.statusCode ?? 400 });
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * unknown 値を安全に Error インスタンスに変換する
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  let message = '';
  try {
    message = typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value);
  } catch {
    message = String(value);
  }
  return new Error(message);
}

/**
 * 網羅性チェック (Exhaustive check) のためのユーティリティ
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union value: ${JSON.stringify(value)}`);
}
