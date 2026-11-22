/**
 * Deno KV ベースの CandleRepository 実装
 * 
 * キー設計:
 * - `["candles_h4", symbol, openTime]` -> Candle (openTime, closeTime, open, high, low, close, volume, trades)
 * - `["candles_symbols", symbol]` -> true
 * - `["candles_latest", symbol]` -> openTime (number)
 */

import type { Candle } from "../domain/candle.ts";
import type { PriceRange } from "../domain/price_range.ts";
import type { CandleRepository } from "./candle_repository.ts";
import { toError } from "../errors.ts";

export class KvCandleRepository implements CandleRepository {
  private kv!: Deno.Kv;
  private readonly dbPath?: string;
  private initialized = false;

  constructor(kvPath?: string) {
    let envPath = Deno.env.get("KV_PATH");
    if (envPath && envPath.startsWith("/app/")) {
      try {
        Deno.statSync("/app");
      } catch {
        envPath = `.${envPath.slice(4)}`;
      }
    }
    this.dbPath = kvPath || envPath || "./data/kv.sqlite";
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.dbPath && this.dbPath !== ":memory:" && this.dbPath.includes("/")) {
      const lastSlash = this.dbPath.lastIndexOf("/");
      const dir = this.dbPath.slice(0, lastSlash);
      try {
        await Deno.mkdir(dir, { recursive: true });
      } catch {
        // ignore
      }
    }
    this.kv = await Deno.openKv(this.dbPath);
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.initialized && this.kv) {
      await this.kv.close();
      this.initialized = false;
    }
  }

  upsertMany(candles: Candle[]): void {
    this.upsertManyAsync(candles).catch((err) => {
      console.error("[KvCandleRepository] upsertMany エラー:", toError(err).message);
    });
  }

  async upsertManyAsync(candles: Candle[]): Promise<void> {
    if (!this.initialized) await this.init();
    if (candles.length === 0) return;

    const symbols = new Set<string>();
    const latestTimes = new Map<string, number>();

    // 100件ずつのバッチで保存
    for (let i = 0; i < candles.length; i += 100) {
      const chunk = candles.slice(i, i + 100);
      const atomic = this.kv.atomic();

      for (const c of chunk) {
        symbols.add(c.symbol);
        const curLatest = latestTimes.get(c.symbol) ?? 0;
        if (c.openTime > curLatest) latestTimes.set(c.symbol, c.openTime);

        atomic.set(["candles_h4", c.symbol, c.openTime], c);
      }

      await atomic.commit();
    }

    // 銘柄メタデータ更新
    for (const s of symbols) {
      await this.kv.set(["candles_symbols", s], true);
      const latest = latestTimes.get(s);
      if (latest) {
        const cur = await this.kv.get<number>(["candles_latest", s]);
        if (!cur.value || latest > cur.value) {
          await this.kv.set(["candles_latest", s], latest);
        }
      }
    }
  }

  count(_symbol: string): number {
    return 0;
  }

  aggregateRanges(_since: Record<string, number>): Map<string, Record<string, PriceRange | null>> {
    return new Map();
  }

  aggregateOpenPrices(_since: Record<string, number>): Map<string, Record<string, number | null>> {
    return new Map();
  }

  latestOpenTimes(): Map<string, number> {
    return new Map();
  }

  /**
   * 銘柄ごとの最新足時刻を Deno KV から取得
   */
  async latestOpenTimesAsync(): Promise<Map<string, number>> {
    if (!this.initialized) await this.init();
    const result = new Map<string, number>();
    const iter = this.kv.list<number>({ prefix: ["candles_latest"] });
    for await (const entry of iter) {
      const symbol = entry.key[1] as string;
      if (entry.value) {
        result.set(symbol, entry.value);
      }
    }
    return result;
  }

  /**
   * 登録銘柄一覧を Deno KV から取得
   */
  async getSymbolsAsync(): Promise<string[]> {
    if (!this.initialized) await this.init();
    const symbols: string[] = [];
    const iter = this.kv.list<boolean>({ prefix: ["candles_symbols"] });
    for await (const entry of iter) {
      const symbol = entry.key[1] as string;
      symbols.push(symbol);
    }
    return symbols;
  }

  /**
   * 期間別レンジ (MIN/MAX) を Deno KV から直接走査して計算
   * since: 各期間の開始時刻 (ms) 例: { "24h": now - 24h, "7d": now - 7d, ... }
   */
  async aggregateRangesAsync(
    since: Record<string, number>
  ): Promise<Map<string, Record<string, PriceRange | null>>> {
    if (!this.initialized) await this.init();
    const labels = Object.keys(since);
    const result = new Map<string, Record<string, PriceRange | null>>();
    if (labels.length === 0) return result;

    const earliest = Math.min(...Object.values(since));
    const symbols = await this.getSymbolsAsync();

    for (const symbol of symbols) {
      const ranges: Record<string, PriceRange | null> = {};
      for (const label of labels) {
        ranges[label] = null;
      }

      // Deno KV の範囲クエリ: openTime >= earliest の足を取得
      const iter = this.kv.list<Candle>({
        prefix: ["candles_h4", symbol],
        start: ["candles_h4", symbol, earliest],
      });

      const matchedCandles: Candle[] = [];
      for await (const entry of iter) {
        if (entry.value) {
          matchedCandles.push(entry.value);
        }
      }

      if (matchedCandles.length > 0) {
        for (const label of labels) {
          const threshold = since[label];
          let high = -Infinity;
          let low = Infinity;
          let found = false;

          for (const c of matchedCandles) {
            if (c.openTime >= threshold) {
              if (c.high > high) high = c.high;
              if (c.low < low) low = c.low;
              found = true;
            }
          }

          if (found) {
            ranges[label] = { high, low };
          }
        }
      }

      result.set(symbol, ranges);
    }

    return result;
  }

  /**
   * 期間最古足の始値 (open) を Deno KV から集計
   */
  async aggregateOpenPricesAsync(
    since: Record<string, number>
  ): Promise<Map<string, Record<string, number | null>>> {
    if (!this.initialized) await this.init();
    const labels = Object.keys(since);
    const result = new Map<string, Record<string, number | null>>();
    if (labels.length === 0) return result;

    const earliest = Math.min(...Object.values(since));
    const symbols = await this.getSymbolsAsync();

    for (const symbol of symbols) {
      const opens: Record<string, number | null> = {};
      for (const label of labels) {
        opens[label] = null;
      }

      const iter = this.kv.list<Candle>({
        prefix: ["candles_h4", symbol],
        start: ["candles_h4", symbol, earliest],
      });

      const matchedCandles: Candle[] = [];
      for await (const entry of iter) {
        if (entry.value) {
          matchedCandles.push(entry.value);
        }
      }

      for (const label of labels) {
        const threshold = since[label];
        const first = matchedCandles.find((c) => c.openTime >= threshold);
        opens[label] = first ? first.open : null;
      }

      result.set(symbol, opens);
    }

    return result;
  }

  /**
   * 統計情報 (総足数、銘柄数、最新時刻) を Deno KV から取得
   */
  async getStatsAsync(): Promise<{
    totalCandles: number;
    uniqueSymbols: number;
    latestOpenTimeMs: number | null;
  }> {
    if (!this.initialized) await this.init();

    // 高速化のため、登録済みメタデータから統計を取得
    const symbols = await this.getSymbolsAsync();
    let latestTime: number | null = null;
    let totalCandles = 0;

    const iterLatest = this.kv.list<number>({ prefix: ["candles_latest"] });
    for await (const entry of iterLatest) {
      if (entry.value && (!latestTime || entry.value > latestTime)) {
        latestTime = entry.value;
      }
    }

    // 総件数カウント
    const countIter = this.kv.list({ prefix: ["candles_h4"] });
    for await (const _entry of countIter) {
      totalCandles++;
    }

    return {
      totalCandles,
      uniqueSymbols: symbols.length,
      latestOpenTimeMs: latestTime,
    };
  }
}
