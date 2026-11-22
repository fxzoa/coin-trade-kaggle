import { withRetry } from "../infrastructure/retry.ts";
import type { PriceRangeCache } from "./price_range_cache.ts";

/** 集計 (SQLite の読み取り) 失敗時の既定の最大試行回数 (初回を含む) */
export const DEFAULT_REFRESH_MAX_ATTEMPTS = 3;
/** 集計失敗時の再試行の待機の基準 (ms) */
export const DEFAULT_REFRESH_RETRY_BASE_MS = 1_000;

/** 集計の再試行に関する設定 (読み取りのみなので再試行しても安全) */
export interface RefreshRetryOptions {
  sleep: (ms: number) => Promise<void>;
  onLog: (msg: string) => void;
  /** 最大試行回数 (初回を含む。既定 3) */
  maxAttempts?: number;
  /** 再試行の待機の基準 (ms。既定 1000) */
  retryBaseDelayMs?: number;
  /** 0 以上 1 未満の乱数 (ジッタ用。テストで差し替える) */
  random?: () => number;
}

/** 再集計の設定 */
export interface RefreshUntilFreshOptions extends RefreshRetryOptions {
  now: () => number;
  /** 最新足が揃うまで再集計を繰り返す最大回数 */
  maxRetries: number;
  /** 再集計までの待機時間 (ms) */
  retryDelayMs: number;
}

/**
 * キャッシュを 1 回集計する。SQLite の一時的な失敗 (ロック・ビジー) は指数バックオフで再試行し、
 * それでも失敗したら分類済みの AppError を投げる (キャッシュは前回の内容を保持する)
 */
export function refreshWithRetry(
  cache: PriceRangeCache,
  now: () => number,
  opts: RefreshRetryOptions,
): Promise<void> {
  return withRetry(() => Promise.resolve().then(() => cache.refresh(now())), {
    service: "SQLite",
    maxAttempts: opts.maxAttempts ?? DEFAULT_REFRESH_MAX_ATTEMPTS,
    baseDelayMs: opts.retryBaseDelayMs ?? DEFAULT_REFRESH_RETRY_BASE_MS,
    sleep: opts.sleep,
    random: opts.random,
    onRetry: (attempt, delayMs) =>
      opts.onLog(
        `期間別レンジの集計に失敗しました。${delayMs}ms 後に再試行します (${attempt} 回目)`,
      ),
  });
}

/**
 * キャッシュを集計し、直前に確定した足が未登録の銘柄があれば待って再集計する。
 * 最大回数に達したら未登録のまま確定する (次の H4 境界で再び集計される)。
 * 集計自体の失敗は再試行 (refreshWithRetry) しても回復しなければ、分類済みの AppError として送出する
 */
export async function refreshUntilFresh(
  cache: PriceRangeCache,
  opts: RefreshUntilFreshOptions,
): Promise<void> {
  for (let attempt = 0;; attempt++) {
    await refreshWithRetry(cache, opts.now, opts);
    opts.onLog(`期間別レンジを集計しました: ${cache.size} 銘柄`);

    const stale = cache.staleSymbols(opts.now());
    if (stale.length === 0) return;
    if (attempt >= opts.maxRetries) {
      opts.onLog(`最新足が未登録の銘柄が ${stale.length} 件ありますが、再集計を打ち切ります`);
      return;
    }
    opts.onLog(
      `最新足が未登録の銘柄が ${stale.length} 件あります。` +
        `${opts.retryDelayMs / 1000}秒後に再集計します (${attempt + 1}/${opts.maxRetries})`,
    );
    await opts.sleep(opts.retryDelayMs);
  }
}
