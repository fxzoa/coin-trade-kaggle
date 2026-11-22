/**
 * coid-trade-webui: Redis Pub/Sub & Sorted Set 履歴ストア
 *
 * - 新規注文 (hl:events:orders:result / hl:history:orders:result)
 * - 決済注文 (hl:events:closes / hl:history:closes)
 * を Redis Pub/Sub でリアルタイム購読し、Sorted Set (ZREVRANGE) から過去履歴を取得する。
 */

import { Redis } from "ioredis";
import { logger } from "./logger.ts";
import type {
  CloseHistoryFilter,
  CloseRecord,
  CloseStats,
  OrderHistoryFilter,
  OrderRecord,
  OrderStats,
  WebUiConfig,
} from "./types.ts";

export type StreamEvent =
  | { type: "order"; record: OrderRecord }
  | { type: "close"; record: CloseRecord };

type StreamListener = (event: StreamEvent) => void;

const MAX_CACHE_SIZE = 500;

export class RedisHistoryStore {
  private redis: Redis | null = null;
  private subRedis: Redis | null = null;
  private orderCache: OrderRecord[] = [];
  private closeCache: CloseRecord[] = [];
  private readonly listeners = new Set<StreamListener>();
  private connected = false;

  constructor(private readonly config: WebUiConfig) {}

  get isConnected(): boolean {
    return this.connected;
  }

  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: StreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn("[RedisHistoryStore] SSEリスナー通知エラー:", err);
      }
    }
  }

  async init(): Promise<void> {
    const opts = {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times: number) {
        return Math.min(times * 500, 5000);
      },
    };

    this.redis = new Redis(this.config.redisUrl, opts);
    this.subRedis = new Redis(this.config.redisUrl, opts);

    this.redis.on("connect", () => {
      this.connected = true;
      logger.info(`[RedisHistoryStore] Redis 接続完了: ${this.config.redisUrl}`);
    });
    this.redis.on("close", () => {
      this.connected = false;
    });
    // deno-lint-ignore no-explicit-any
    this.redis.on("error", (err: any) => {
      logger.error("[RedisHistoryStore] Redis エラー:", err?.message || err);
    });

    // deno-lint-ignore no-explicit-any
    this.subRedis.on("error", (err: any) => {
      logger.error("[RedisHistoryStore:Sub] Redis Subscriber エラー:", err?.message || err);
    });

    this.subRedis.on("message", (channel: string, message: string) => {
      if (channel === this.config.redisOrderResultChannel) {
        const rec = this.parseOrderRecord(message);
        if (rec) {
          this.prependOrder(rec);
          this.emit({ type: "order", record: rec });
        }
      } else if (channel === this.config.redisCloseChannel) {
        const rec = this.parseCloseRecord(message);
        if (rec) {
          this.prependClose(rec);
          this.emit({ type: "close", record: rec });
        }
      }
    });

    await this.subRedis.subscribe(
      this.config.redisOrderResultChannel,
      this.config.redisCloseChannel,
    );
    logger.info(
      `[RedisHistoryStore:Sub] Pub/Sub 購読開始: ${this.config.redisOrderResultChannel}, ${this.config.redisCloseChannel}`,
    );

    await this.reloadFromRedis();
  }

  async reloadFromRedis(): Promise<void> {
    if (!this.redis) return;
    try {
      const [rawOrders, rawCloses] = await Promise.all([
        this.redis.zrevrange(this.config.redisOrderHistoryKey, 0, MAX_CACHE_SIZE - 1),
        this.redis.zrevrange(this.config.redisCloseHistoryKey, 0, MAX_CACHE_SIZE - 1),
      ]);

      const orders: OrderRecord[] = [];
      for (const raw of rawOrders) {
        const rec = this.parseOrderRecord(raw);
        if (rec) orders.push(rec);
      }

      const closes: CloseRecord[] = [];
      for (const raw of rawCloses) {
        const rec = this.parseCloseRecord(raw);
        if (rec) closes.push(rec);
      }

      if (orders.length > 0) this.orderCache = orders;
      if (closes.length > 0) this.closeCache = closes;
    } catch (err) {
      logger.warn("[RedisHistoryStore] Sorted Set 初期履歴ロード失敗:", err);
    }
  }

  async close(): Promise<void> {
    if (this.subRedis) {
      await this.subRedis.unsubscribe(
        this.config.redisOrderResultChannel,
        this.config.redisCloseChannel,
      );
      await this.subRedis.quit();
      this.subRedis = null;
    }
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
    this.connected = false;
  }

  private parseOrderRecord(raw: string): OrderRecord | null {
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      const tsMs = typeof obj.timestampMs === "number"
        ? obj.timestampMs
        : typeof obj.timestamp === "number"
        ? obj.timestamp
        : Date.parse(String(obj.timestamp || "")) || Date.now();
      const isoTs = typeof obj.timestamp === "string"
        ? obj.timestamp
        : new Date(tsMs).toISOString();
      const requestId = String(obj.requestId || obj.id || `${tsMs}`);
      return {
        id: String(obj.id || `order_${tsMs}_${requestId}`),
        requestId,
        timestamp: isoTs,
        timestampMs: tsMs,
        source: String(obj.source || "unknown"),
        botId: String(obj.botId || obj.source || "unknown"),
        coin: String(obj.coin || "").toUpperCase(),
        side: obj.side === "SELL" ? "SELL" : "BUY",
        status: obj.status || "error",
        price: Number(obj.price) || 0,
        size: Number(obj.size) || 0,
        notionalUsd: Number(obj.notionalUsd) || 0,
        cloid: obj.cloid ? String(obj.cloid) : undefined,
        oid: typeof obj.oid === "number" ? obj.oid : undefined,
        filledSize: typeof obj.filledSize === "number" ? obj.filledSize : undefined,
        avgPx: typeof obj.avgPx === "number" ? obj.avgPx : undefined,
        error: obj.error ? String(obj.error) : undefined,
      };
    } catch {
      return null;
    }
  }

  private parseCloseRecord(raw: string): CloseRecord | null {
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      const tsMs = typeof obj.timestampMs === "number"
        ? obj.timestampMs
        : Date.parse(String(obj.timestamp || "")) || Date.now();
      const isoTs = typeof obj.timestamp === "string"
        ? obj.timestamp
        : new Date(tsMs).toISOString();
      return {
        id: String(obj.id || `close_${tsMs}_${obj.coin || "UNK"}`),
        timestamp: isoTs,
        timestampMs: tsMs,
        coin: String(obj.coin || "").toUpperCase(),
        side: obj.side === "SHORT" ? "SHORT" : "LONG",
        closeAction: obj.closeAction === "BUY" ? "BUY" : "SELL",
        size: Number(obj.size) || 0,
        entryPrice: Number(obj.entryPrice) || 0,
        exitPrice: Number(obj.exitPrice) || 0,
        pnlUsd: Number(obj.pnlUsd) || 0,
        profitPct: Number(obj.profitPct) || 0,
        thresholdPct: Number(obj.thresholdPct) || 0,
        source: obj.source === "POLL" || obj.source === "MANUAL" ? obj.source : "EVENT",
        cloid: obj.cloid ? String(obj.cloid) : undefined,
        reason: obj.reason ? String(obj.reason) : undefined,
      };
    } catch {
      return null;
    }
  }

  private prependOrder(rec: OrderRecord): void {
    const idx = this.orderCache.findIndex((r) => r.id === rec.id);
    if (idx >= 0) this.orderCache.splice(idx, 1);
    this.orderCache.unshift(rec);
    if (this.orderCache.length > MAX_CACHE_SIZE) {
      this.orderCache.length = MAX_CACHE_SIZE;
    }
  }

  private prependClose(rec: CloseRecord): void {
    const idx = this.closeCache.findIndex((r) => r.id === rec.id);
    if (idx >= 0) this.closeCache.splice(idx, 1);
    this.closeCache.unshift(rec);
    if (this.closeCache.length > MAX_CACHE_SIZE) {
      this.closeCache.length = MAX_CACHE_SIZE;
    }
  }

  async listCloseHistory(filter?: CloseHistoryFilter): Promise<CloseRecord[]> {
    const limit = filter?.limit ?? 100;
    const coinUpper = filter?.coin?.trim().toUpperCase();
    return this.closeCache
      .filter((r) => {
        if (coinUpper && !r.coin.toUpperCase().includes(coinUpper)) return false;
        if (filter?.startTime && r.timestampMs < filter.startTime) return false;
        if (filter?.endTime && r.timestampMs > filter.endTime) return false;
        return true;
      })
      .slice(0, limit);
  }

  async getStats(): Promise<CloseStats> {
    let totalTrades = 0;
    let winTrades = 0;
    let lossTrades = 0;
    let totalPnlUsd = 0;
    let totalProfitPct = 0;
    let lastCloseTime: string | null = null;

    for (const rec of this.closeCache) {
      if (!lastCloseTime) lastCloseTime = rec.timestamp;
      totalTrades++;
      totalPnlUsd += rec.pnlUsd;
      totalProfitPct += rec.profitPct;
      if (rec.pnlUsd >= 0) winTrades++;
      else lossTrades++;
    }

    return {
      totalTrades,
      winTrades,
      lossTrades,
      winRatePct: totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0,
      totalPnlUsd,
      avgProfitPct: totalTrades > 0 ? totalProfitPct / totalTrades : 0,
      avgPnlUsd: totalTrades > 0 ? totalPnlUsd / totalTrades : 0,
      lastCloseTime,
    };
  }

  async listOrderHistory(filter?: OrderHistoryFilter): Promise<OrderRecord[]> {
    const limit = filter?.limit ?? 100;
    const coinUpper = filter?.coin?.trim().toUpperCase();
    return this.orderCache
      .filter((r) => {
        if (coinUpper && !r.coin.toUpperCase().includes(coinUpper)) return false;
        if (filter?.startTime && r.timestampMs < filter.startTime) return false;
        if (filter?.endTime && r.timestampMs > filter.endTime) return false;
        return true;
      })
      .slice(0, limit);
  }

  async getOrderStats(): Promise<OrderStats> {
    let totalOrders = 0;
    let filledOrders = 0;
    let restingOrders = 0;
    let failedOrders = 0;
    let dryRunOrders = 0;
    let totalNotionalUsd = 0;
    let lastOrderTime: string | null = null;

    for (const rec of this.orderCache) {
      if (!lastOrderTime) lastOrderTime = rec.timestamp;
      totalOrders++;
      totalNotionalUsd += rec.notionalUsd || 0;
      if (rec.status === "filled") filledOrders++;
      else if (rec.status === "resting") restingOrders++;
      else if (rec.status === "dry_run") dryRunOrders++;
      else if (rec.status === "rejected" || rec.status === "error") failedOrders++;
    }

    return {
      totalOrders,
      filledOrders,
      restingOrders,
      failedOrders,
      dryRunOrders,
      totalNotionalUsd,
      lastOrderTime,
    };
  }
}
