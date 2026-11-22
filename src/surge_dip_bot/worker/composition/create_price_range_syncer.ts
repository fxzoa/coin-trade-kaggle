import type { SignalConfig } from "../../shared/config.ts";
import type { ErrorLogSinks } from "../../shared/domain/error_log.ts";
import type { PriceRangeCache } from "../usecase/price_range_cache.ts";
import {
  PriceRangeRedisSyncer,
  type RedisClientLike,
} from "../usecase/price_range_redis_syncer.ts";

/** Redis 価格統計同期の依存オブジェクト */
export interface CreatePriceRangeSyncerOptions {
  redisClient: RedisClientLike;
  logSinks: ErrorLogSinks;
  prefix?: string;
  getVolume?: (symbol: string) => number | undefined;
}

/**
 * PriceRangeRedisSyncer を組み立てる。
 * Redis クライアントを用いて、メモリ上の期間別価格レンジを Redis へ同期する。
 */
export function createPriceRangeSyncer(
  config: SignalConfig,
  cache: PriceRangeCache,
  options: CreatePriceRangeSyncerOptions,
): PriceRangeRedisSyncer {
  return new PriceRangeRedisSyncer(
    {
      redisClient: options.redisClient,
      cache,
    },
    {
      enabled: config.priceStatsWriteEnabled ?? config.kvPriceStatsWriteEnabled ?? true,
      prefix: options.prefix,
      getVolume: options.getVolume,
      onLog: (msg) => (options.logSinks.onInfo ?? options.logSinks.onLog)(msg),
      onError: (msg) => (options.logSinks.onError ?? options.logSinks.onLog)(msg),
    },
  );
}
