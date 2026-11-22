/**
 * hl-signal-evaluator-bot: Deno KV (SQLite) & Redis 永続化ストア
 * 注文 (orders)・TP決済 (tp_orders)・約定履歴 (order_fills) のライフサイクル管理
 */

import { Redis } from "ioredis";
import { toError } from "./errors.ts";
import type { SlackNotifier } from "./slack_notifier.ts";

export type OrderStatus =
  | "NEW"
  | "OPEN"
  | "CLOSED"
  | "CANCEL"
  | "CANCELLED"
  | "FILLED"
  | "REJECTED";
export type TpTimeframe = "24H" | "7D" | "30D" | "90D" | "180D" | "360D";

export interface StoredOrderRecord {
  id: string;
  orderId?: number;
  cloid?: string;
  symbol: string;
  side: "LONG" | "SHORT";
  price: number;
  sz: number;
  filledSz?: number;
  avgPx?: number;
  targetSizeUsd: number;
  status: OrderStatus;
  signalType?: string;
  closedAt?: string;
  closedByTpId?: string;
  error?: string;
  timestamp: number;
  source: 'surge-dip-bot' | 'external'; // 注文発行元を追跡
  createdAt: string;
  updatedAt?: string;
}

export interface StoredTpOrderRecord {
  id: string;
  cloid: string;
  symbol: string;
  timeframe: string;
  profitPct: number;
  threshold: number;
  price: number;
  size: number;
  notionalUsd: number;
  status: OrderStatus;
  source: 'surge-dip-bot' | 'external'; // 注文発行元を追跡
  createdAt: string;
  updatedAt: string;
}

export interface StoredFillRecord {
  fillId: string;
  orderId?: number;
  cloid?: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  notionalUsd: number;
  fee: number;
  closedPnl: number;
  timestamp: string;
}

export class SignalExecutionStore {
  private client!: InstanceType<typeof Redis>;
  private kv!: Deno.Kv;
  private readonly redisUrl: string;
  private readonly prefix: string;
  private readonly dbPath?: string;
  public slackNotifier?: SlackNotifier;

  constructor(dbPath?: string, prefix?: string, slackNotifier?: SlackNotifier) {
    this.slackNotifier = slackNotifier;
    this.redisUrl = Deno.env.get("REDIS_URL") || "redis://localhost:6379";
    let envPath = Deno.env.get("KV_PATH");
    if (envPath && envPath.startsWith("/app/")) {
      try {
        Deno.statSync("/app");
      } catch {
        envPath = `.${envPath.slice(4)}`;
      }
    }
    this.dbPath = dbPath || envPath || "./data/kv.sqlite";

    if (dbPath === ":memory:" || dbPath?.includes("test")) {
      const rand = Math.random().toString(36).substring(2, 9);
      this.prefix = `hl:evaluator:test:${Date.now()}:${rand}:`;
    } else {
      this.prefix = prefix || Deno.env.get("REDIS_STORE_PREFIX") || "hl:evaluator:";
    }
  }

  async init(): Promise<void> {
    try {
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

      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
      });

      await this.client.ping();
    } catch (e) {
      const err = toError(e);
      console.error("[SignalExecutionStore] 初期化失敗:", err.message);
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
    if (this.kv) {
      this.kv.close();
    }
  }

  // --- Orders ---
  async saveOrder(order: StoredOrderRecord): Promise<void> {
    try {
      if (this.kv) {
        await this.kv.set(["orders", order.id], order);
        if (order.cloid && order.cloid !== order.id) {
          await this.kv.set(["orders_by_cloid", order.cloid], order.id);
        }
        if (order.orderId) {
          await this.kv.set(["orders_by_oid", order.orderId.toString()], order.id);
        }
      }

      const hashKey = `${this.prefix}orders`;
      const zkey = `${this.prefix}orders:timeline`;
      const pipeline = this.client.pipeline();
      pipeline.hset(hashKey, order.id, JSON.stringify(order));
      pipeline.zadd(zkey, order.timestamp || Date.now(), order.id);
      if (order.cloid) {
        pipeline.hset(`${this.prefix}orders_by_cloid`, order.cloid, order.id);
      }
      await pipeline.exec();
    } catch (e) {
      console.error("[SignalExecutionStore] 注文保存エラー:", toError(e).message);
    }
  }

  async getOrder(id: string): Promise<StoredOrderRecord | null> {
    try {
      if (this.kv) {
        const entry = await this.kv.get<StoredOrderRecord>(["orders", id]);
        if (entry.value) return entry.value;
      }
      const raw = await this.client.hget(`${this.prefix}orders`, id);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async getOrderByCloidOrOid(idOrCloidOrOid: string): Promise<StoredOrderRecord | null> {
    try {
      let order = await this.getOrder(idOrCloidOrOid);
      if (order) return order;

      if (this.kv) {
        const byCloid = await this.kv.get<string>(["orders_by_cloid", idOrCloidOrOid]);
        if (byCloid.value) {
          order = await this.getOrder(byCloid.value);
          if (order) return order;
        }
        const byOid = await this.kv.get<string>(["orders_by_oid", idOrCloidOrOid]);
        if (byOid.value) {
          order = await this.getOrder(byOid.value);
          if (order) return order;
        }
      }

      const actualId = await this.client.hget(`${this.prefix}orders_by_cloid`, idOrCloidOrOid);
      if (actualId) {
        return await this.getOrder(actualId);
      }
      return null;
    } catch {
      return null;
    }
  }

  async getOrders(limit = 100): Promise<StoredOrderRecord[]> {
    try {
      if (this.kv) {
        const iter = this.kv.list<StoredOrderRecord>({ prefix: ["orders"] });
        const list: StoredOrderRecord[] = [];
        for await (const entry of iter) {
          if (entry.value) list.push(entry.value);
        }
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return list.slice(0, limit);
      }
      const ids = await this.client.zrevrange(`${this.prefix}orders:timeline`, 0, limit - 1);
      if (ids.length === 0) return [];
      const raws = await this.client.hmget(`${this.prefix}orders`, ...ids);
      return raws.filter((r): r is string => Boolean(r)).map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  }

  async hasActiveOrder(symbol: string, side: "LONG" | "SHORT"): Promise<boolean> {
    try {
      const orders = await this.getOrders(200);
      return orders.some((o) => {
        if (o.symbol.toUpperCase() !== symbol.toUpperCase()) return false;
        if (o.side !== side) return false;
        return o.status === "NEW" || o.status === "OPEN";
      });
    } catch {
      return false;
    }
  }

  async getActiveOpenOrders(symbol?: string, limit = 500): Promise<StoredOrderRecord[]> {
    try {
      const orders = await this.getOrders(1000);
      return orders
        .filter((o) => {
          if (o.status !== "OPEN") return false;
          if (symbol && o.symbol.toUpperCase() !== symbol.toUpperCase()) return false;
          return true;
        })
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  async recordOrderFillProgress(
    idOrCloidOrOid: string,
    fillSize: number,
  ): Promise<{ promoted: boolean; currentStatus?: OrderStatus }> {
    try {
      const order = await this.getOrderByCloidOrOid(idOrCloidOrOid);
      if (!order) return { promoted: false };

      const prevFilled = order.filledSz || 0;
      const newFilled = prevFilled + fillSize;
      order.filledSz = newFilled;
      order.updatedAt = new Date().toISOString();

      let promoted = false;
      // 90%以上の約定で NEW -> OPEN
      if (order.sz > 0 && newFilled >= (order.sz * 0.9 - 1e-9)) {
        if (order.status === "NEW") {
          order.status = "OPEN";
          promoted = true;
          console.info(
            `[SignalExecutionStore] 🎯 約定率90%以上達成 (${newFilled}/${order.sz}): status を NEW -> OPEN に更新 [ID: ${order.id}]`,
          );
        }
      }

      await this.saveOrder(order);

      // OPEN昇格時にSlack通知 (自身の注文のみ)
      if (promoted && this.slackNotifier) {
        // 🔍 自身が発注した注文かどうかをチェック
        if (order.source === 'surge-dip-bot') {
          console.info(`[SignalExecutionStore] ✅ 自身の注文の約定昇格: ${order.symbol} ${order.side} -> Slack通知を送信`);
          const entryPrice = order.avgPx && order.avgPx > 0 ? order.avgPx : order.price;
          const size = order.filledSz && order.filledSz > 0 ? order.filledSz : order.sz;
          const notionalUsd = order.targetSizeUsd || Math.round(entryPrice * size * 100) / 100;
          await this.slackNotifier.notifyPositionOpened({
            coin: order.symbol,
            side: order.side === "LONG" ? "BUY" : "SELL",
            price: entryPrice,
            size,
            notionalUsd,
            id: order.id,
          }).catch((err) =>
            console.warn(`[SignalExecutionStore] Slack notifyPositionOpened error:`, err)
          );
        } else {
          console.info(`[SignalExecutionStore] ℹ️ 他のBOTの約定昇格: ${order.symbol} ${order.side} -> Slack通知をスキップ`);
        }
      }

      return { promoted, currentStatus: order.status };
    } catch (e) {
      console.error("[SignalExecutionStore] recordOrderFillProgress エラー:", toError(e).message);
      return { promoted: false };
    }
  }

  async closeOpenOrders(
    symbol: string,
    closedSize: number,
    tpOrderId?: string,
    exitPrice?: number,
  ): Promise<{ closedCount: number; closedTotalSize: number; closedOrders: StoredOrderRecord[] }> {
    const result = {
      closedCount: 0,
      closedTotalSize: 0,
      closedOrders: [] as StoredOrderRecord[],
    };
    if (closedSize <= 0) return result;

    try {
      const openOrders = await this.getActiveOpenOrders(symbol, 500);
      // 建値(price)が有利な順（LONGは低値優先、SHORTは高値優先）
      openOrders.sort((a, b) => {
        if (a.side === "LONG") {
          return a.price - b.price;
        } else {
          return b.price - a.price;
        }
      });

      let remainingToClose = closedSize;
      const nowIso = new Date().toISOString();

      for (const order of openOrders) {
        if (remainingToClose <= 0) break;
        const effectiveSize = order.filledSz && order.filledSz > 0 ? order.filledSz : order.sz;

        order.status = "CLOSED";
        order.closedAt = nowIso;
        order.updatedAt = nowIso;
        if (tpOrderId) {
          order.closedByTpId = tpOrderId;
        }

        await this.saveOrder(order);

        result.closedCount++;
        result.closedTotalSize += effectiveSize;
        result.closedOrders.push(order);

        const entryPrice = order.avgPx && order.avgPx > 0 ? order.avgPx : order.price;
        const exitPx = exitPrice ?? entryPrice;
        const isLong = order.side === "LONG";
        const pnlPct = isLong
          ? ((exitPx - entryPrice) / entryPrice) * 100
          : ((entryPrice - exitPx) / entryPrice) * 100;
        const pnlUsd = isLong
          ? (exitPx - entryPrice) * effectiveSize
          : (entryPrice - exitPx) * effectiveSize;

        if (this.slackNotifier) {
          await this.slackNotifier.notifyPositionClosed({
            coin: order.symbol,
            side: isLong ? "BUY" : "SELL",
            entryPrice,
            exitPrice: exitPx,
            size: effectiveSize,
            pnlUsd: Math.round(pnlUsd * 100) / 100,
            pnlPct: Math.round(pnlPct * 100) / 100,
            id: order.id,
            reason: "TAKE_PROFIT",
          }).catch((err) =>
            console.warn(`[SignalExecutionStore] Slack notifyPositionClosed error:`, err)
          );
        }

        remainingToClose -= effectiveSize;
        console.info(
          `[SignalExecutionStore] 🔒 注文クローズ (TP決済連動): ID=${order.id}, 建値=$${order.price}, サイズ=${effectiveSize}, 残決済=${
            Math.max(0, remainingToClose).toFixed(4)
          }`,
        );
      }

      return result;
    } catch (e) {
      console.error("[SignalExecutionStore] closeOpenOrders エラー:", toError(e).message);
      return result;
    }
  }

  /**
   * TP約定時の決済記録および建玉クローズ処理
   */
  async recordTpOrderFilled(
    tpOrderOrSymbolOrId: StoredTpOrderRecord | string,
    exitPriceOrSize?: number,
    maybeClosedSize?: number,
    maybeTpOrderId?: string,
  ): Promise<{ closedCount: number; closedTotalSize: number; closedOrders: StoredOrderRecord[] }> {
    if (typeof tpOrderOrSymbolOrId === "object") {
      await this.saveTpOrder(tpOrderOrSymbolOrId);
      return await this.closeOpenOrders(
        tpOrderOrSymbolOrId.symbol,
        tpOrderOrSymbolOrId.size,
        tpOrderOrSymbolOrId.id,
        tpOrderOrSymbolOrId.price,
      );
    }

    // 単一注文ID指定の場合
    const singleOrder = await this.getOrderByCloidOrOid(tpOrderOrSymbolOrId);
    if (singleOrder && (singleOrder.status === "OPEN" || singleOrder.status === "NEW")) {
      const exitPx = exitPriceOrSize ?? singleOrder.price;
      const effectiveSize = maybeClosedSize ??
        (singleOrder.filledSz && singleOrder.filledSz > 0 ? singleOrder.filledSz : singleOrder.sz);
      const nowIso = new Date().toISOString();

      singleOrder.status = "CLOSED";
      singleOrder.closedAt = nowIso;
      singleOrder.updatedAt = nowIso;
      if (maybeTpOrderId) singleOrder.closedByTpId = maybeTpOrderId;
      await this.saveOrder(singleOrder);

      const entryPrice = singleOrder.avgPx && singleOrder.avgPx > 0
        ? singleOrder.avgPx
        : singleOrder.price;
      const isLong = singleOrder.side === "LONG";
      const pnlPct = isLong
        ? ((exitPx - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPx) / entryPrice) * 100;
      const pnlUsd = isLong
        ? (exitPx - entryPrice) * effectiveSize
        : (entryPrice - exitPx) * effectiveSize;

      if (this.slackNotifier) {
        await this.slackNotifier.notifyPositionClosed({
          coin: singleOrder.symbol,
          side: isLong ? "BUY" : "SELL",
          entryPrice,
          exitPrice: exitPx,
          size: effectiveSize,
          pnlUsd: Math.round(pnlUsd * 100) / 100,
          pnlPct: Math.round(pnlPct * 100) / 100,
          id: singleOrder.id,
          reason: "TAKE_PROFIT",
        }).catch((err) =>
          console.warn(`[SignalExecutionStore] Slack notifyPositionClosed error:`, err)
        );
      }

      return {
        closedCount: 1,
        closedTotalSize: effectiveSize,
        closedOrders: [singleOrder],
      };
    }

    // シンボル指定の場合: recordTpOrderFilled(symbol, closedSize, exitPrice, tpOrderId)
    const symbol = tpOrderOrSymbolOrId;
    const closedSize = typeof exitPriceOrSize === "number" ? exitPriceOrSize : 0;
    const exitPrice = typeof maybeClosedSize === "number" ? maybeClosedSize : undefined;
    return await this.closeOpenOrders(symbol, closedSize, maybeTpOrderId, exitPrice);
  }

  // --- TP Orders ---
  async saveTpOrder(order: StoredTpOrderRecord): Promise<void> {
    try {
      if (this.kv) {
        await this.kv.set(["tp_orders", order.id], order);
      }
      await this.client.hset(`${this.prefix}tp_orders`, order.id, JSON.stringify(order));
    } catch (e) {
      console.error("[SignalExecutionStore] TP注文保存エラー:", toError(e).message);
    }
  }

  async getTpOrders(limit = 100): Promise<StoredTpOrderRecord[]> {
    try {
      if (this.kv) {
        const iter = this.kv.list<StoredTpOrderRecord>({ prefix: ["tp_orders"] });
        const list: StoredTpOrderRecord[] = [];
        for await (const entry of iter) {
          if (entry.value) list.push(entry.value);
        }
        list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return list.slice(0, limit);
      }
      const raws = await this.client.hvals(`${this.prefix}tp_orders`);
      return raws.map((s) => JSON.parse(s)).slice(0, limit);
    } catch {
      return [];
    }
  }

  // --- Cooldowns ---
  async isGlobalTpCooldownActive(): Promise<boolean> {
    try {
      const val = await this.client.get(`${this.prefix}cooldown:tp_global`);
      return Boolean(val);
    } catch {
      return false;
    }
  }

  async setGlobalTpCooldown(durationMs = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      await this.client.set(`${this.prefix}cooldown:tp_global`, "1", "PX", durationMs);
    } catch (e) {
      console.error("[SignalExecutionStore] TPクールダウン設定エラー:", toError(e).message);
    }
  }

  async isInsufficientActive(): Promise<boolean> {
    try {
      const key = this.dbPath === ":memory:" || this.dbPath?.includes("test")
        ? `${this.prefix}system:insufficient_cooldown`
        : "hl:system:insufficient_cooldown";
      const val = await this.client.get(key);
      return Boolean(val);
    } catch {
      return false;
    }
  }

  async setInsufficientCooldown(reason: string): Promise<void> {
    try {
      const payload = {
        active: true,
        reason,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
      const key = this.dbPath === ":memory:" || this.dbPath?.includes("test")
        ? `${this.prefix}system:insufficient_cooldown`
        : "hl:system:insufficient_cooldown";
      await this.client.set(key, JSON.stringify(payload), "EX", 3600);
    } catch (e) {
      console.error("[SignalExecutionStore] 証拠金不足クールダウン設定エラー:", toError(e).message);
    }
  }

  // --- Bot ON / OFF Flag ---
  async isBotEnabled(): Promise<boolean> {
    try {
      const val = await this.client.get("hl:flags:surge_dip:enabled");
      if (val === null) {
        // デフォルトは環境変数 AUTO_ORDER_ENABLED (未設定なら true)
        const envVal = Deno.env.get("AUTO_ORDER_ENABLED");
        return envVal === undefined || envVal === "true";
      }
      return val === "true" || val === "1";
    } catch {
      return true;
    }
  }

  async setBotEnabled(enabled: boolean): Promise<void> {
    try {
      await this.client.set("hl:flags:surge_dip:enabled", enabled ? "true" : "false");
    } catch (e) {
      console.error("[SignalExecutionStore] ボット有効化フラグ更新エラー:", toError(e).message);
    }
  }

  // --- エラーログ ({prefix}errors) ---
  async recordError(err: unknown, context = "General"): Promise<void> {
    try {
      const errorObj = toError(err);
      const message = errorObj.message;
      const stack = errorObj.stack;
      const errorEntry = {
        timestamp: new Date().toISOString(),
        service: "surge-dip-trade-bot",
        level: "ERROR",
        context,
        message,
        stack,
      };
      const key = `${this.prefix}errors`;
      await this.client.lpush(key, JSON.stringify(errorEntry));
      await this.client.ltrim(key, 0, 99);
      await this.client.publish(`${this.prefix}events:errors`, JSON.stringify(errorEntry));

      if (this.slackNotifier) {
        this.slackNotifier.notifyError(`surge-dip-trade-bot [${context}]`, errorObj).catch(
          () => {},
        );
      }
    } catch (e) {
      console.error("[SignalExecutionStore] Failed to record error:", toError(e).message);
    }
  }

  async getRecentErrors(
    limit = 100,
  ): Promise<
    Array<
      {
        timestamp: string;
        service: string;
        level: string;
        context: string;
        message: string;
        stack?: string;
      }
    >
  > {
    try {
      const key = `${this.prefix}errors`;
      const rawList = await this.client.lrange(key, 0, limit - 1);
      return rawList.map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return {
            timestamp: new Date().toISOString(),
            service: "surge-dip-trade-bot",
            level: "ERROR",
            context: "Unknown",
            message: s,
          };
        }
      });
    } catch {
      return [];
    }
  }

  async clearErrors(): Promise<void> {
    try {
      await this.client.del(`${this.prefix}errors`);
    } catch (err) {
      console.error("[SignalExecutionStore] Failed to clear errors:", toError(err).message);
    }
  }
}
