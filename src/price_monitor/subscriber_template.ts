/**
 * Hyperliquid Redis Pub/Sub 汎用購読クライアント (TypeScript / Deno)
 *
 * 参考: hl-close-bot の RedisPositionStore パターン
 * - クエリ用 client と購読専用 subClient を分離
 * - 価格 (prices)、注文 (orders)、ポジション (positions)、約定 (fills) を型安全に購読
 * - 監視対象コイン / ユーザーアドレスの自動フィルタリング
 * - 自動再接続 & グレースフルシャットダウン対応
 */

import { Redis } from "ioredis";

// ============================================================================
// イベントペイロードの型定義
// ============================================================================

export interface PriceEventPayload {
  timestamp: number;
  prices: Record<string, number>;
}

export interface OrderEventPayload {
  user: string;
  timestamp: number;
  update: {
    order: {
      coin: string;
      side: "B" | "A";
      limitPx: string;
      sz: string;
      oid: number;
      timestamp: number;
      origSz?: string;
      cloid?: string;
    };
    status: "open" | "filled" | "canceled" | "triggered" | "rejected" | "marginCanceled";
    statusTimestamp?: number;
  };
}

export interface PositionData {
  coin: string;
  szi: string;
  entryPx?: string;
  positionValue?: string;
  unrealizedPnl?: string;
  returnOnEquity?: string;
  liquidationPx?: string | null;
  marginUsed?: string;
}

export interface PositionEventPayload {
  user: string;
  timestamp: number;
  positions: PositionData[];
}

export interface FillRecord {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  closedPnl?: string;
  fee?: string;
  hash?: string;
  oid?: number;
  cloid?: string;
}

export interface FillEventPayload {
  user: string;
  timestamp: number;
  fills: FillRecord[];
}

// ============================================================================
// クライアント設定オプション
// ============================================================================

export interface HlSubscriberOptions {
  redisUrl?: string;
  prefix?: string;
  targetUser?: string;
  targetCoins?: string[];
  onLog?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

// ============================================================================
// HlRedisSubscriber クラス実装
// ============================================================================

export class HlRedisSubscriber {
  private client: InstanceType<typeof Redis>;
  private subClient: InstanceType<typeof Redis>;
  private readonly prefix: string;
  private readonly targetUser?: string;
  private readonly targetCoinsSet?: Set<string>;
  private readonly onLog: (msg: string) => void;
  private readonly onError: (err: unknown) => void;
  private isClosed = false;

  // コールバックリスナー
  private priceListeners: Array<(prices: Record<string, number>, timestamp: number) => void> = [];
  private orderListeners: Array<
    (update: OrderEventPayload["update"], user: string, timestamp: number) => void
  > = [];
  private positionListeners: Array<
    (positions: PositionData[], user: string, timestamp: number) => void
  > = [];
  private fillListeners: Array<(fills: FillRecord[], user: string, timestamp: number) => void> = [];

  constructor(options: HlSubscriberOptions = {}) {
    const redisUrl = options.redisUrl || Deno.env.get("REDIS_URL") || "redis://localhost:6379";
    this.prefix = options.prefix || Deno.env.get("REDIS_KEY_PREFIX") || "hl:";
    this.targetUser = options.targetUser ? options.targetUser.toLowerCase() : undefined;
    this.targetCoinsSet = options.targetCoins
      ? new Set(options.targetCoins.map((c) => c.toUpperCase()))
      : undefined;
    this.onLog = options.onLog ?? console.log;
    this.onError = options.onError ?? console.error;

    // クエリ用 Redis クライアント (HGET, GET 用)
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (this.isClosed) return null;
        return Math.min(times * 500, 5000);
      },
    });

    // 購読専用 Redis クライアント (Pub/Sub 中は他コマンドを受付不可のため独立させる)
    this.subClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => {
        if (this.isClosed) return null;
        return Math.min(times * 500, 5000);
      },
    });

    this.subClient.on("connect", () => {
      this.onLog(`[HlRedisSubscriber] ✅ Redis に接続しました: ${redisUrl}`);
    });

    this.subClient.on("error", (err: unknown) => {
      if (!this.isClosed) {
        this.onError(`[HlRedisSubscriber] ❌ Redis エラー: ${err}`);
      }
    });

    this.subClient.on("message", (channel: string, message: string) => {
      this.handleIncomingMessage(channel, message);
    });
  }

  /**
   * 1. 価格イベントのリスナー登録
   */
  onPrices(callback: (prices: Record<string, number>, timestamp: number) => void): this {
    this.priceListeners.push(callback);
    return this;
  }

  /**
   * 2. 注文更新イベントのリスナー登録
   */
  onOrders(
    callback: (update: OrderEventPayload["update"], user: string, timestamp: number) => void,
  ): this {
    this.orderListeners.push(callback);
    return this;
  }

  /**
   * 3. ポジション更新イベントのリスナー登録
   */
  onPositions(
    callback: (positions: PositionData[], user: string, timestamp: number) => void,
  ): this {
    this.positionListeners.push(callback);
    return this;
  }

  /**
   * 4. 約定イベントのリスナー登録
   */
  onFills(callback: (fills: FillRecord[], user: string, timestamp: number) => void): this {
    this.fillListeners.push(callback);
    return this;
  }

  /**
   * 購読を開始する
   */
  async start(): Promise<void> {
    const channels = [
      `${this.prefix}events:prices`,
      `${this.prefix}events:orders`,
      `${this.prefix}events:positions`,
      `${this.prefix}events:fills`,
    ];
    await this.subClient.subscribe(...channels);
    this.onLog(`[HlRedisSubscriber] 📡 購読開始: ${channels.join(", ")}`);
  }

  /**
   * 受信メッセージのパースとフィルタリング
   */
  private handleIncomingMessage(channel: string, messageStr: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(messageStr);
    } catch (err) {
      this.onError(`[HlRedisSubscriber] メッセージJSONパースエラー (${channel}): ${err}`);
      return;
    }

    if (!raw || typeof raw !== "object") return;
    const data = raw as Record<string, unknown>;

    // 1. 最新価格イベント (hl:events:prices)
    if (channel === `${this.prefix}events:prices` && data.prices) {
      let prices = data.prices as Record<string, number>;
      const timestamp = Number(data.timestamp || Date.now());

      // 対象通貨が指定されていればフィルタリング
      if (this.targetCoinsSet) {
        const filtered: Record<string, number> = {};
        for (const [coin, px] of Object.entries(prices)) {
          if (this.targetCoinsSet.has(coin.toUpperCase())) {
            filtered[coin] = px;
          }
        }
        prices = filtered;
      }

      if (Object.keys(prices).length > 0) {
        for (const listener of this.priceListeners) {
          listener(prices, timestamp);
        }
      }
      return;
    }

    // ユーザーアドレスの一致確認 (orders / positions / fills)
    const eventUser = typeof data.user === "string" ? data.user.toLowerCase() : undefined;
    if (this.targetUser && eventUser && this.targetUser !== eventUser) {
      return;
    }

    // 2. 注文更新イベント (hl:events:orders)
    if (channel === `${this.prefix}events:orders` && data.update) {
      const payload = raw as OrderEventPayload;
      const coin = payload.update.order?.coin?.toUpperCase();
      if (!this.targetCoinsSet || (coin && this.targetCoinsSet.has(coin))) {
        for (const listener of this.orderListeners) {
          listener(payload.update, payload.user, payload.timestamp);
        }
      }
      return;
    }

    // 3. ポジション更新イベント (hl:events:positions)
    if (channel === `${this.prefix}events:positions` && Array.isArray(data.positions)) {
      const payload = raw as PositionEventPayload;
      const positions = this.targetCoinsSet
        ? payload.positions.filter((p) => this.targetCoinsSet!.has(p.coin.toUpperCase()))
        : payload.positions;

      for (const listener of this.positionListeners) {
        listener(positions, payload.user, payload.timestamp);
      }
      return;
    }

    // 4. 約定イベント (hl:events:fills)
    if (channel === `${this.prefix}events:fills` && Array.isArray(data.fills)) {
      const payload = raw as FillEventPayload;
      const fills = this.targetCoinsSet
        ? payload.fills.filter((f) => this.targetCoinsSet!.has(f.coin.toUpperCase()))
        : payload.fills;

      if (fills.length > 0) {
        for (const listener of this.fillListeners) {
          listener(fills, payload.user, payload.timestamp);
        }
      }
      return;
    }
  }

  /**
   * Redis から対象銘柄の現在中間価格（Mid Price）を取得する
   */
  async getMidPrice(coin: string): Promise<number | null> {
    try {
      const raw = await this.client.hget(`${this.prefix}prices`, coin.toUpperCase());
      if (!raw) return null;
      const parsed = parseFloat(raw);
      return isNaN(parsed) ? null : parsed;
    } catch (err) {
      this.onError(`[HlRedisSubscriber] getMidPrice エラー (${coin}): ${err}`);
      return null;
    }
  }

  /**
   * Redis から全監視銘柄の現在中間価格（Mid Price）ハッシュを取得する
   */
  async getAllPrices(): Promise<Record<string, number>> {
    try {
      const rawMap = await this.client.hgetall(`${this.prefix}prices`);
      const prices: Record<string, number> = {};
      for (const [coin, val] of Object.entries(rawMap)) {
        const num = parseFloat(String(val));
        if (!isNaN(num)) {
          prices[coin] = num;
        }
      }
      return prices;
    } catch (err) {
      this.onError(`[HlRedisSubscriber] getAllPrices エラー: ${err}`);
      return {};
    }
  }

  /**
   * Redis から固定監視銘柄リスト (hl:target_coins) を取得する
   */
  async getTargetCoins(): Promise<string[]> {
    try {
      const raw = await this.client.get(`${this.prefix}target_coins`);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.onError(`[HlRedisSubscriber] getTargetCoins エラー: ${err}`);
      return [];
    }
  }

  /**
   * 切断と終了処理
   */
  async close(): Promise<void> {
    this.isClosed = true;
    try {
      await Promise.all([this.subClient.quit(), this.client.quit()]);
      this.onLog("[HlRedisSubscriber] 🔌 切断完了");
    } catch (err) {
      this.onError(`[HlRedisSubscriber] 切断エラー: ${err}`);
    }
  }
}
