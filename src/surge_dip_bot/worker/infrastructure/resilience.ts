import type { ErrorService } from "../../shared/errors.ts";
import type { CircuitBreaker } from "./circuit_breaker.ts";
import { type RetryOptions, withRetry } from "./retry.ts";

/** 再試行の設定 (発生元サービスは呼び出し側が決めるため含めない) */
export type RetrySettings = Omit<RetryOptions, "service">;

/** 依存先への呼び出しの耐障害設定 (遮断器と再試行)。どちらも省略できる */
export interface ResilienceOptions {
  /** 依存先ごとの遮断器 (省略時は遮断しない) */
  breaker?: CircuitBreaker;
  /** 読み取りの再試行設定 (省略時は withRetry の既定。書き込みには使わない) */
  retry?: RetrySettings;
}

/**
 * 冪等な読み取りを実行する: 遮断器(再試行(fn))。
 * 遮断器が最も外側なので、再試行を尽くした最終的な失敗だけが連続失敗に数えられる
 */
export function runRead<T>(
  service: ErrorService,
  options: ResilienceOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const retried = () => withRetry(fn, { ...options.retry, service });
  return options.breaker ? options.breaker.execute(retried) : retried();
}

/**
 * 書き込み (D1 の INSERT・open-queue への publish) を実行する。
 * 再試行は絶対にしない (応答が失われただけで成功している場合に二重登録・二重発注になるため)。
 * 遮断器が開いている間は即座に失敗させる
 */
export function runWrite<T>(options: ResilienceOptions, fn: () => Promise<T>): Promise<T> {
  return options.breaker ? options.breaker.execute(fn) : fn();
}
