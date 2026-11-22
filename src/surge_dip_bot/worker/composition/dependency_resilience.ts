import { type AppError, type ErrorService, formatError } from "../../shared/errors.ts";
import { type ErrorLogSinks, logAtLevel } from "../../shared/domain/error_log.ts";
import {
  CircuitBreaker,
  type CircuitState,
  DEFAULT_OPEN_MS,
} from "../infrastructure/circuit_breaker.ts";
import type { ResilienceOptions, RetrySettings } from "../infrastructure/resilience.ts";

/** 依存先ごとの遮断器 (依存先 1 つにつき 1 つを全クライアントで共有する) */
export interface DependencyBreakers {
  d1: CircuitBreaker;
  kv: CircuitBreaker;
  queues: CircuitBreaker;
  hyperliquidInfo: CircuitBreaker;
}

/** 依存先ごとの耐障害設定 (遮断器と再試行) */
export interface DependencyResilience {
  d1: ResilienceOptions;
  kv: ResilienceOptions;
  queues: ResilienceOptions;
  hyperliquidInfo: ResilienceOptions;
}

/** createDependencyBreakers の依存 */
export interface CreateDependencyBreakersOptions extends ErrorLogSinks {
  /** 遮断に至る連続失敗の回数 (省略時は CircuitBreaker の既定) */
  failureThreshold?: number;
  /** 遮断を続ける時間 (ms。省略時は CircuitBreaker の既定) */
  openMs?: number;
  /** 現在時刻 (テストで差し替える) */
  now?: () => number;
}

/** createDependencyResilience の依存 */
export interface CreateDependencyResilienceOptions extends CreateDependencyBreakersOptions {
  /** 共有する遮断器。省略時は新しく作る (複数の組み立てで共有するときは呼び出し側で 1 度だけ作って渡す) */
  breakers?: DependencyBreakers;
  /** 読み取りの再試行設定 (テストで sleep / random を差し替える) */
  retry?: RetrySettings;
}

/** 遮断器の状態変化を 1 遷移につき 1 行で通知する: 遮断 (open) は error、回復 (closed) は info。half_open は通知しない */
function stateChangeLogger(sinks: ErrorLogSinks, openMs: number) {
  return (
    name: string,
    _from: CircuitState,
    to: CircuitState,
    lastError: AppError | undefined,
  ): void => {
    if (to === "open") {
      const cause = lastError
        ? formatError(lastError)
        : `[App/unknown] ${name} の失敗の原因は不明です`;
      logAtLevel(
        sinks,
        "error",
        `${cause} - 連続失敗のため ${name} への呼び出しを遮断しました。` +
          `${Math.ceil(openMs / 1000)} 秒間は呼び出しを停止します`,
      );
    } else if (to === "closed") {
      logAtLevel(sinks, "info", `${name} への呼び出しが回復したため遮断を解除しました`);
    }
  };
}

/** D1 / KV / Queues / HyperliquidInfo の遮断器を 1 つずつ作る。状態変化は sinks へ通知する */
export function createDependencyBreakers(
  options: CreateDependencyBreakersOptions,
): DependencyBreakers {
  const { failureThreshold, openMs = DEFAULT_OPEN_MS, now } = options;
  const onStateChange = stateChangeLogger(options, openMs);
  const create = (name: string, service: ErrorService) =>
    new CircuitBreaker({ name, service, failureThreshold, openMs, now, onStateChange });
  return {
    d1: create("D1", "D1"),
    kv: create("KV", "KV"),
    queues: create("Queues", "Queues"),
    hyperliquidInfo: create("HyperliquidInfo", "HyperliquidInfo"),
  };
}

/**
 * 依存先ごとの遮断器と再試行設定を組み立てる。
 * 再試行の途中経過はログに出さない (最終的な失敗は呼び出し側が 1 行で、遮断は遮断器が 1 遷移 1 行で通知する)。
 * Queues は書き込みのみなので再試行を設定しない (読み取りの再試行は runRead だけが使う)
 */
export function createDependencyResilience(
  options: CreateDependencyResilienceOptions,
): DependencyResilience {
  const breakers = options.breakers ?? createDependencyBreakers(options);
  const { retry } = options;
  return {
    d1: { breaker: breakers.d1, retry },
    kv: { breaker: breakers.kv, retry },
    queues: { breaker: breakers.queues },
    hyperliquidInfo: { breaker: breakers.hyperliquidInfo, retry },
  };
}
