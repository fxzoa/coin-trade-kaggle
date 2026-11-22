import { Redis } from "ioredis";
import type { Candle } from "../domain/candle.ts";
import type { PriceRange } from "../domain/price_range.ts";
import type { CandleRepository } from "./candle_repository.ts";
import { toError } from "../errors.ts";

/** 360日分の4H足の最大保持本数 (360日 * 24時間 / 4時間 = 2,160本) */
export const MAX_RETENTION_CANDLES_360D = 2160;

/**
 * Redis ベースの CandleRepository 実装
 * キー構成:
 * - `hl:evaluator:candles:{symbol}` (ZSET): score = openTime, member = JSON.stringify(Candle)
 * - `hl:evaluator:latest_open_times` (Hash): { [symbol]: openTime }
 * - `hl:evaluator:symbols` (Set): 登録済み通貨シンボル一覧
 */
export class RedisCandleRepository implements CandleRepository {
  private client: InstanceType<typeof Redis>;
  private readonly prefix: string = "hl:evaluator:";

  constructor(redisUrl?: string) {
    const url = redisUrl || Deno.env.get("REDIS_URL") || "redis://localhost:6379";
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    });
  }

  upsertMany(candles: Candle[]): void {
    if (candles.length === 0) return;
    // 同期インターフェースに合わせるため非同期Promiseを追跡しつつバックグラウンド実行
    const pipeline = this.client.pipeline();
    const symbols = new Set<string>();
    const latestTimes: Record<string, string> = {};

    for (const c of candles) {
      symbols.add(c.symbol);
      const zkey = `${this.prefix}candles:${c.symbol}`;
      pipeline.zadd(zkey, c.openTime, JSON.stringify(c));
      // 過去 360 日分 (2,160 本) のみを保持し、古い足を自動削除
      pipeline.zremrangebyrank(zkey, 0, -(MAX_RETENTION_CANDLES_360D + 1));

      const currentLatest = Number(latestTimes[c.symbol] || 0);
      if (c.openTime > currentLatest) {
        latestTimes[c.symbol] = c.openTime.toString();
      }
    }

    if (symbols.size > 0) {
      pipeline.sadd(`${this.prefix}symbols`, ...Array.from(symbols));
      pipeline.hset(`${this.prefix}latest_open_times`, latestTimes);
    }

    pipeline.exec().catch((err) => {
      console.error("[RedisCandleRepository] upsertMany エラー:", toError(err).message);
    });
  }

  async upsertManyAsync(candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;
    const pipeline = this.client.pipeline();
    const symbols = new Set<string>();
    const latestTimes: Record<string, string> = {};

    for (const c of candles) {
      symbols.add(c.symbol);
      const zkey = `${this.prefix}candles:${c.symbol}`;
      pipeline.zadd(zkey, c.openTime, JSON.stringify(c));
      // 過去 360 日分 (2,160 本) のみを保持し、古い足を自動削除
      pipeline.zremrangebyrank(zkey, 0, -(MAX_RETENTION_CANDLES_360D + 1));

      const currentLatest = Number(latestTimes[c.symbol] || 0);
      if (c.openTime > currentLatest) {
        latestTimes[c.symbol] = c.openTime.toString();
      }
    }

    if (symbols.size > 0) {
      pipeline.sadd(`${this.prefix}symbols`, ...Array.from(symbols));
      pipeline.hset(`${this.prefix}latest_open_times`, latestTimes);
    }

    await pipeline.exec();
  }

  count(_symbol: string): number {
    return MAX_RETENTION_CANDLES_360D;
  }

  async countAsync(symbol: string): Promise<number> {
    try {
      return await this.client.zcard(`${this.prefix}candles:${symbol}`);
    } catch {
      return 0;
    }
  }

  latestOpenTimes(): Map<string, number> {
    // 起動時や同期集計用にメモリキャッシュまたは即時取得
    return new Map();
  }

  async latestOpenTimesAsync(): Promise<Map<string, number>> {
    try {
      const all = await this.client.hgetall(`${this.prefix}latest_open_times`);
      const map = new Map<string, number>();
      for (const [sym, timeStr] of Object.entries(all)) {
        map.set(sym, Number(timeStr));
      }
      return map;
    } catch {
      return new Map();
    }
  }

  aggregateRanges(
    _since: Record<string, number>,
  ): Map<string, Record<string, PriceRange | null>> {
    return new Map();
  }

  async aggregateRangesAsync(
    since: Record<string, number>,
  ): Promise<Map<string, Record<string, PriceRange | null>>> {
    const result = new Map<string, Record<string, PriceRange | null>>();
    const labels = Object.keys(since);
    if (labels.length === 0) return result;

    try {
      const symbols = await this.client.smembers(`${this.prefix}symbols`);
      const earliest = Math.min(...Object.values(since));

      for (const symbol of symbols) {
        const zkey = `${this.prefix}candles:${symbol}`;
        // earliest 以降の足を取得
        const rawCandles = await this.client.zrangebyscore(zkey, earliest, "+inf");
        const candles: Candle[] = rawCandles.map((r) => JSON.parse(r));

        const ranges: Record<string, PriceRange | null> = {};
        for (const label of labels) {
          const threshold = since[label];
          const matched = candles.filter((c) => c.openTime >= threshold);
          if (matched.length === 0) {
            ranges[label] = null;
          } else {
            let high = -Infinity;
            let low = Infinity;
            for (const c of matched) {
              if (c.high > high) high = c.high;
              if (c.low < low) low = c.low;
            }
            ranges[label] = { high, low };
          }
        }
        result.set(symbol, ranges);
      }
    } catch (err) {
      console.error("[RedisCandleRepository] aggregateRangesAsync エラー:", toError(err).message);
    }

    return result;
  }

  aggregateOpenPrices(
    _since: Record<string, number>,
  ): Map<string, Record<string, number | null>> {
    return new Map();
  }

  async aggregateOpenPricesAsync(
    since: Record<string, number>,
  ): Promise<Map<string, Record<string, number | null>>> {
    const result = new Map<string, Record<string, number | null>>();
    const labels = Object.keys(since);
    if (labels.length === 0) return result;

    try {
      const symbols = await this.client.smembers(`${this.prefix}symbols`);
      const earliest = Math.min(...Object.values(since));

      for (const symbol of symbols) {
        const zkey = `${this.prefix}candles:${symbol}`;
        const rawCandles = await this.client.zrangebyscore(zkey, earliest, "+inf");
        const candles: Candle[] = rawCandles.map((r) => JSON.parse(r));

        const opens: Record<string, number | null> = {};
        for (const label of labels) {
          const threshold = since[label];
          const first = candles.find((c) => c.openTime >= threshold);
          opens[label] = first ? first.open : null;
        }
        result.set(symbol, opens);
      }
    } catch (err) {
      console.error("[RedisCandleRepository] aggregateOpenPricesAsync エラー:", toError(err).message);
    }

    return result;
  }

  close(): void {
    this.client.quit().catch(() => {});
  }
}
