/**
 * dca-deno: 共通エラー定義モジュール
 */

export interface AppErrorOptions {
  code?: string;
  statusCode?: number;
  context?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * アプリケーション共通エラーベースクラス
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly context?: Record<string, unknown>;

  constructor(message: string, options?: AppErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = options?.code ?? 'APP_ERROR';
    this.statusCode = options?.statusCode ?? 500;
    this.context = options?.context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 注文処理に関するエラー
 */
export class OrderError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, { code: 'ORDER_ERROR', statusCode: 400, ...options });
  }
}

/**
 * Hyperliquid 取引所 API 通信・実行エラー
 */
export class HyperliquidApiError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, { code: 'HYPERLIQUID_API_ERROR', statusCode: 502, ...options });
  }
}

/**
 * KV / Redis ストア操作エラー
 */
export class KvStoreError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, { code: 'KV_STORE_ERROR', statusCode: 500, ...options });
  }
}

/**
 * 設定値・環境変数エラー
 */
export class ConfigError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, { code: 'CONFIG_ERROR', statusCode: 500, ...options });
  }
}

/**
 * パラメータ検証エラー
 */
export class ValidationError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, { code: 'VALIDATION_ERROR', statusCode: 400, ...options });
  }
}

/**
 * 対象データ未存在エラー
 */
export class NotFoundError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, { code: 'NOT_FOUND_ERROR', statusCode: 404, ...options });
  }
}

/**
 * unknown 型の例外値を安全に Error オブジェクトに変換
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  ) {
    const err = new Error((value as { message: string }).message);
    if ('name' in value && typeof (value as { name: unknown }).name === 'string') {
      err.name = (value as { name: string }).name;
    }
    if ('stack' in value && typeof (value as { stack: unknown }).stack === 'string') {
      err.stack = (value as { stack: string }).stack;
    }
    return err;
  }
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}
