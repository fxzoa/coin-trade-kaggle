/**
 * Application error classes and error utility functions.
 */
import { errorMessage, redactSecrets } from "./domain/error_message.ts";

export { errorMessage, redactSecrets };

/**
 * Ensures any thrown unknown value is safely converted to an Error instance.
 */
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

/**
 * Re-export assertNever from result.ts for convenience.
 */
export { assertNever } from "./result.ts";

/**
 * Error classifications matching existing architecture.
 */
export type ErrorKind =
  | "network"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "server"
  | "client"
  | "bad_response"
  | "circuit_open"
  | "config"
  | "unknown";

export type ErrorService =
  | "D1"
  | "KV"
  | "Queues"
  | "HyperliquidInfo"
  | "HyperliquidWS"
  | "SQLite"
  | "App";

export type ErrorLogLevel = "warn" | "error";

export interface ErrorKindPolicy {
  readonly summary: string;
  readonly hint: string;
  readonly retryable: boolean;
  readonly logLevel: ErrorLogLevel;
  readonly infrastructureFailure: boolean;
}

export const ERROR_KIND_POLICY: Readonly<Record<ErrorKind, ErrorKindPolicy>> = {
  network: {
    summary: "通信に失敗しました",
    hint: "ネットワーク接続・DNS・プロキシを確認してください。一時的な場合は自動で回復します",
    retryable: true,
    logLevel: "warn",
    infrastructureFailure: true,
  },
  timeout: {
    summary: "応答がタイムアウトしました",
    hint: "相手サービスの遅延が疑われます。稼働状況とタイムアウト値を確認してください",
    retryable: true,
    logLevel: "warn",
    infrastructureFailure: true,
  },
  auth: {
    summary: "認証・認可エラーです",
    hint: "API トークンの権限と有効期限を確認してください",
    retryable: false,
    logLevel: "error",
    infrastructureFailure: true,
  },
  rate_limit: {
    summary: "レート制限に達しました",
    hint: "リクエスト頻度を下げてください (間隔設定やキャッシュを見直す)",
    retryable: true,
    logLevel: "warn",
    infrastructureFailure: true,
  },
  server: {
    summary: "相手サービスでエラーが発生しました",
    hint: "相手サービスの障害情報を確認し、復旧を待ってください",
    retryable: true,
    logLevel: "warn",
    infrastructureFailure: true,
  },
  client: {
    summary: "リクエストが拒否されました",
    hint: "リクエスト内容 (ID・SQL・パラメータ) を確認してください",
    retryable: false,
    logLevel: "error",
    infrastructureFailure: false,
  },
  bad_response: {
    summary: "応答が不正です",
    hint: "API 仕様の変更や不正な応答がないか確認してください",
    retryable: false,
    logLevel: "error",
    infrastructureFailure: true,
  },
  circuit_open: {
    summary: "依存先を一時的に遮断中です",
    hint: "連続失敗のため呼び出しを見送っています。待機後に自動で再試行します",
    retryable: false,
    logLevel: "warn",
    infrastructureFailure: false,
  },
  config: {
    summary: "設定が不正です",
    hint: "環境変数・設定値を確認してください",
    retryable: false,
    logLevel: "error",
    infrastructureFailure: false,
  },
  unknown: {
    summary: "想定外のエラーです",
    hint: "原因のメッセージを確認し、継続する場合は調査してください",
    retryable: false,
    logLevel: "error",
    infrastructureFailure: false,
  },
};

export interface AppErrorOptions {
  message: string;
  code?: string;
  statusCode?: number;
  status?: number;
  context?: Record<string, unknown>;
  cause?: unknown;
  kind?: ErrorKind;
  service?: ErrorService;
  retryable?: boolean;
  retryAfterMs?: number;
  hint?: string;
}

/**
 * Base Application Error
 */
export class AppError extends Error {
  override readonly name: string = "AppError";
  readonly code: string;
  readonly statusCode: number;
  readonly status: number;
  readonly context?: Record<string, unknown>;
  readonly kind: ErrorKind;
  readonly service: ErrorService;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly hint: string;

  constructor(options: AppErrorOptions | string, additionalOptions?: Partial<AppErrorOptions>) {
    const opts: AppErrorOptions = typeof options === "string"
      ? { message: options, ...additionalOptions }
      : { ...options, ...additionalOptions };

    super(opts.message, { cause: opts.cause });
    Object.setPrototypeOf(this, new.target.prototype);

    this.code = opts.code ?? "APP_ERROR";
    const statusCode = opts.statusCode ?? opts.status ?? 500;
    this.statusCode = statusCode;
    this.status = statusCode;
    this.context = opts.context;

    const kind = opts.kind ?? "unknown";
    const policy = ERROR_KIND_POLICY[kind] ?? ERROR_KIND_POLICY.unknown;
    this.kind = kind;
    this.service = opts.service ?? "App";
    this.retryable = opts.retryable ?? policy.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.hint = opts.hint ?? policy.hint;
  }
}

/**
 * Domain-specific error class for domain business logic violations.
 */
export class DomainError extends AppError {
  override readonly name = "DomainError";
  constructor(message: string, options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: options?.code ?? "DOMAIN_ERROR",
      statusCode: options?.statusCode ?? 400,
      service: options?.service ?? "App",
      ...options,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Signal error class for signal evaluation and validation errors.
 */
export class SignalError extends AppError {
  override readonly name = "SignalError";
  constructor(message: string, options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: options?.code ?? "SIGNAL_ERROR",
      statusCode: options?.statusCode ?? 400,
      service: options?.service ?? "App",
      ...options,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Repository error class for database, KV, or persistence store failures.
 */
export class RepositoryError extends AppError {
  override readonly name = "RepositoryError";
  constructor(message: string, options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: options?.code ?? "REPOSITORY_ERROR",
      statusCode: options?.statusCode ?? 500,
      service: options?.service ?? "App",
      ...options,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * KV store error class.
 */
export class KvError extends AppError {
  override readonly name = "KvError";
  constructor(message: string, options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: options?.code ?? "KV_ERROR",
      statusCode: options?.statusCode ?? 500,
      service: options?.service ?? "KV",
      kind: options?.kind ?? "server",
      ...options,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Cloudflare (D1, Workers KV, Queues) error class.
 */
export class CloudflareError extends AppError {
  override readonly name = "CloudflareError";
  constructor(message: string, options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: options?.code ?? "CLOUDFLARE_ERROR",
      statusCode: options?.statusCode ?? 502,
      service: options?.service ?? "D1",
      kind: options?.kind ?? "server",
      ...options,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Hyperliquid API / WebSocket error class.
 */
export class HyperliquidError extends AppError {
  override readonly name = "HyperliquidError";
  constructor(message: string, options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: options?.code ?? "HYPERLIQUID_ERROR",
      statusCode: options?.statusCode ?? 502,
      service: options?.service ?? "HyperliquidInfo",
      kind: options?.kind ?? "network",
      ...options,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Circuit breaker open error class.
 */
export class CircuitBreakerError extends AppError {
  override readonly name = "CircuitBreakerError";
  constructor(message: string, options?: Partial<AppErrorOptions>) {
    super({
      message,
      code: options?.code ?? "CIRCUIT_BREAKER_OPEN",
      statusCode: options?.statusCode ?? 503,
      kind: "circuit_open",
      retryable: false,
      service: options?.service ?? "App",
      ...options,
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function classifyHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "bad_response";
}

export function httpStatusError(
  service: ErrorService,
  status: number,
  detail?: string,
  retryAfterMs?: number,
): AppError {
  return new AppError({
    kind: classifyHttpStatus(status),
    service,
    message: `HTTP ${status}${detail ? ` (${detail})` : ""}`,
    status,
    statusCode: status,
    code: `HTTP_${status}`,
    retryAfterMs,
  });
}

const TIMEOUT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "TimedOut"]);
const NETWORK_ERROR_NAMES = new Set([
  "ConnectionRefused",
  "ConnectionReset",
  "ConnectionAborted",
  "NotConnected",
  "BrokenPipe",
  "AddrNotAvailable",
]);
const FETCH_FAILURE_MESSAGE = /error sending request|fetch failed|network|connect|dns|tls|socket/i;

function kindOfThrown(e: unknown): ErrorKind {
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  if (typeof name === "string") {
    if (TIMEOUT_ERROR_NAMES.has(name)) return "timeout";
    if (NETWORK_ERROR_NAMES.has(name)) return "network";
  }
  if (e instanceof TypeError && FETCH_FAILURE_MESSAGE.test(e.message)) return "network";
  return "unknown";
}

export function classifyError(e: unknown, service: ErrorService): AppError {
  if (e instanceof AppError) return e;
  return new AppError({
    kind: kindOfThrown(e),
    service,
    message: errorMessage(e),
    cause: e,
  });
}

export function logLevelOf(error: AppError): ErrorLogLevel {
  return ERROR_KIND_POLICY[error.kind].logLevel;
}

export function formatError(e: unknown, service: ErrorService = "App"): string {
  const error = classifyError(e, service);
  const { summary } = ERROR_KIND_POLICY[error.kind];
  const status = error.status === undefined ? "" : ` HTTP ${error.status}`;
  const detail = error.message ? `原因: ${error.message}, ` : "";
  const line =
    `[${error.service}/${error.kind}] ${summary}${status} (${detail}対処: ${error.hint})`;
  return redactSecrets(line.replace(/\s*\n\s*/g, " "));
}
