import { type AppError, classifyError, type ErrorService } from "../../shared/errors.ts";

/** 既定の再試行継続時間 (ms): 最初の呼出しから 100 秒 (cf-workers の fetchWithRetry と共通) */
export const DEFAULT_RETRY_TOTAL_TIMEOUT_MS = 100_000;
/** 既定のバックオフ基準 (ms) */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
/** 既定の 1 回あたりの待機の上限 (ms) */
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/** withRetry のオプション */
export interface RetryOptions {
  /** 例外の分類に使う発生元サービス (省略時は "App") */
  service?: ErrorService;
  /** 最初の呼出しから再試行を続ける合計時間 (ms)。既定 100 秒。0 以下なら再試行しない */
  totalTimeoutMs?: number;
  /** 試行回数の上限 (初回を含む)。省略時は時間予算だけで打ち切る。時間とは別に回数を絞りたい場合のみ指定 */
  maxAttempts?: number;
  /** 指数バックオフの基準 (ms)。n 回目の失敗後の待機は base * 2^(n-1) + 0〜base のジッタ */
  baseDelayMs?: number;
  /** 1 回あたりの待機の上限 (ms)。Retry-After 指定もこの値と残り時間で頭打ちにする */
  maxDelayMs?: number;
  /** 待機する関数 (テストで差し替える) */
  sleep?: (ms: number) => Promise<void>;
  /** 0 以上 1 未満の乱数 (テストで差し替える) */
  random?: () => number;
  /** 現在時刻 (ms)。時間予算の計測に使う (テストで差し替える) */
  now?: () => number;
  /** 再試行の直前に呼ばれる (attempt は直前に失敗した試行の番号、1 始まり) */
  onRetry?: (attempt: number, delayMs: number, error: AppError) => void;
}

/** 既定の待機 (setTimeout) */
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 指数バックオフ + ジッタ加算の待機時間。相手が Retry-After を示した場合はそれを優先する (上限・残り時間で頭打ち) */
function backoffDelay(
  attempt: number,
  error: AppError,
  baseDelayMs: number,
  maxDelayMs: number,
  remainingMs: number,
  random: () => number,
): number {
  const backoff = baseDelayMs * 2 ** (attempt - 1) + random() * baseDelayMs;
  return Math.floor(Math.min(error.retryAfterMs ?? backoff, maxDelayMs, remainingMs));
}

/**
 * 一時的な失敗 (AppError.retryable が true) に限り、最初の呼出しから totalTimeoutMs 経過するまで
 * 指数バックオフ + ジッタで再試行し続ける。再試行できない失敗・時間予算 (または maxAttempts) の超過時は、分類済みの AppError を投げる。
 *
 * 警告: 冪等な操作 (読み取り・KV GET・Info API の POST による参照など) にだけ使うこと。
 * D1 の INSERT や open-queue への publish は、応答が失われただけで実際には成功している場合があり、
 * 再試行すると二重登録・二重発注になるため、絶対に包んではならない。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    service = "App",
    totalTimeoutMs = DEFAULT_RETRY_TOTAL_TIMEOUT_MS,
    maxAttempts = Number.POSITIVE_INFINITY,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
    onRetry,
  } = options;
  const attempts = Math.max(1, Math.floor(maxAttempts));
  const deadline = now() + totalTimeoutMs;

  for (let attempt = 1;; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const error = classifyError(e, service);
      const remainingMs = deadline - now();
      if (!error.retryable || attempt >= attempts || remainingMs <= 0) throw error;
      const delayMs = backoffDelay(attempt, error, baseDelayMs, maxDelayMs, remainingMs, random);
      onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }
}
