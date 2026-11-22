import type { SignalConfig } from "../../shared/config.ts";
import { D1PositionRepository } from "../infrastructure/d1_position_repository.ts";
import { DcaEvaluator } from "../usecase/dca_evaluator.ts";
import { DcaPositionCache } from "../usecase/dca_position_cache.ts";
import type { SignalRegistrar } from "../usecase/signal_registrar.ts";
import { createDependencyBreakers, createDependencyResilience } from "./dependency_resilience.ts";
import {
  createDcaSignalRegistrar,
  type CreateDcaSignalRegistrarOptions,
} from "./create_signal_registrar.ts";

/** DCA (ナンピン) の一式。positions を定期的に refresh し、ティックごとに evaluator → registrar へ流す */
export interface DcaPipeline {
  /** OPEN ポジションのキャッシュ (呼び出し側が起動時と定期的に refresh する) */
  positions: DcaPositionCache;
  /** ティックから DCA シグナルを判定する */
  evaluator: DcaEvaluator;
  /** DCA 用の登録器 (チェック → D1 登録 → open-queue 通知) */
  registrar: SignalRegistrar;
}

/** createDcaPipeline の依存 (登録器と共通。breakers を渡すと通常の登録器と遮断器を共有できる) */
export type CreateDcaPipelineOptions = CreateDcaSignalRegistrarOptions;

/**
 * 設定から DCA の一式を組み立てる。DCA_ENABLED=true でない場合は null。
 * OPEN ポジションは D1 からしか読めないため、D1 の認証情報が無い場合は警告して null (DCA は動作しない)。
 * 書き込み・open-queue 通知は SIGNAL_WRITE_ENABLED / OPEN_QUEUE_ENABLED に従い、既定はドライラン
 */
export function createDcaPipeline(
  config: SignalConfig,
  options: CreateDcaPipelineOptions,
): DcaPipeline | null {
  if (!config.dcaEnabled) return null;
  if (!config.d1) {
    options.onLog(
      "DCA_ENABLED=true ですが CF_ACCOUNT_ID / CF_TRADE_API_TOKEN / D1_DATABASE_ID のいずれかが" +
        "未設定のため、OPEN ポジションを読めず DCA は無効です",
    );
    return null;
  }
  // OPEN ポジションの読み取りと登録器が同じ D1 / KV / Queues の遮断器を共有する
  const breakers = options.breakers ?? createDependencyBreakers(options);
  const shared = { ...options, breakers };
  const positions = new DcaPositionCache({
    source: new D1PositionRepository(
      config.d1,
      options.fetchFn,
      createDependencyResilience(shared).d1,
    ),
    onLog: options.onLog,
    onError: options.onError,
    onInfo: options.onInfo,
  });
  return {
    positions,
    evaluator: new DcaEvaluator(positions, options.now),
    registrar: createDcaSignalRegistrar(config, shared),
  };
}
