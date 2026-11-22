/**
 * hl-btc-dca-bot / hl-multi-dca-bot: Redis 永続化ストア
 * 4時間足ローソク足キャッシュ、期間価格統計、シグナル台帳、注文・約定履歴を Redis で管理
 */

import { Redis } from 'ioredis';
import type {
  Kline4h,
  PriceStatsRecord,
  TradeSignal,
  TradeSide,
  OrderRecord,
  OrderFillRecord,
  TpOrderRecord,
  TpTimeframe,
  OrderStatus,
} from '../types.ts';
import { logger } from '../logger.ts';
import { getJstIsoString } from './time_helper.ts';
import { ok, err, type Result } from '../result.ts';
import { KvStoreError, NotFoundError, toError } from '../errors.ts';
import type { ISlackNotifier as SlackNotifier } from './slack_notifier_type.ts';

/**
 * 外部（hl-surge-dip-trade-bot / evaluator / 共有Redis）の価格統計オブジェクトを PriceStatsRecord 型に正規化
 */
export function normalizeToPriceStatsRecord(raw: any, coin: string): PriceStatsRecord {
  const c = (raw.coin || coin).toUpperCase();
  const currentPrice = Number(raw.currentPrice ?? raw.lastPrice ?? 0);
  const updatedAt = typeof raw.updatedAt === 'number'
    ? new Date(raw.updatedAt).toISOString()
    : (raw.updatedAt ? String(raw.updatedAt) : getJstIsoString());

  return {
    coin: c,
    updatedAt,
    currentPrice,
    maxPrice24h: Number(raw.maxPrice24h ?? 0),
    maxPrice7d: Number(raw.maxPrice7d ?? 0),
    maxPrice30d: Number(raw.maxPrice30d ?? 0),
    maxPrice90d: Number(raw.maxPrice90d ?? 0),
    maxPrice180d: Number(raw.maxPrice180d ?? raw.maxPrice90d ?? 0),
    maxPrice360d: Number(raw.maxPrice360d ?? raw.maxPrice180d ?? raw.maxPrice90d ?? 0),
    minPrice24h: Number(raw.minPrice24h ?? 0),
    minPrice7d: Number(raw.minPrice7d ?? 0),
    minPrice30d: Number(raw.minPrice30d ?? 0),
    minPrice90d: Number(raw.minPrice90d ?? 0),
    minPrice180d: Number(raw.minPrice180d ?? raw.minPrice90d ?? 0),
    minPrice360d: Number(raw.minPrice360d ?? raw.minPrice180d ?? raw.minPrice90d ?? 0),
    change24hPct: raw.change24hPct !== undefined
      ? Number(raw.change24hPct)
      : (raw.change24h !== undefined ? Number(raw.change24h) : undefined),
  };
}

export class DcaKvStore {
  private client!: InstanceType<typeof Redis>;
  private kv!: Deno.Kv;
  private readonly redisUrl: string;
  private readonly prefix: string;
  private readonly dbPath?: string;
  private readonly isTest: boolean;
  private readonly botEnabledKey: string;
  private readonly serviceName: string;
  private notifier?: SlackNotifier;

  constructor(dbPath?: string, prefix?: string, notifier?: SlackNotifier) {
    this.redisUrl = Deno.env.get('REDIS_URL') || 'redis://localhost:6379';
    let envPath = Deno.env.get('KV_PATH');
    if (envPath && envPath.startsWith('/app/')) {
      try {
        Deno.statSync('/app');
      } catch {
        envPath = `.${envPath.slice(4)}`;
      }
    }
    this.dbPath = dbPath || envPath || './data/kv.sqlite';

    this.isTest = dbPath === ':memory:' || Boolean(dbPath?.includes('test')) || Boolean(prefix?.includes('test'));
    if (this.isTest) {
      const rand = Math.random().toString(36).substring(2, 9);
      this.prefix = `hl:dca:test:${Date.now()}:${rand}:`;
    } else {
      this.prefix = prefix || Deno.env.get('REDIS_STORE_PREFIX') || 'hl:dca:';
    }
    this.botEnabledKey = Deno.env.get('BOT_ENABLED_KEY') || 'hl:btc_dca:enabled';
    this.serviceName = 'btc-dca-bot';
    if (notifier) {
      this.notifier = notifier;
    }
  }

  setNotifier(notifier: SlackNotifier): void {
    this.notifier = notifier;
  }

  async init(): Promise<void> {
    try {
      // 1. Deno KV (SQLite) 初期化 (orders, tp_orders, fills 永続化用)
      if (this.dbPath && this.dbPath !== ':memory:' && this.dbPath.includes('/')) {
        const lastSlash = this.dbPath.lastIndexOf('/');
        const dir = this.dbPath.slice(0, lastSlash);
        try {
          await Deno.mkdir(dir, { recursive: true });
        } catch {
          // ignore if directory exists
        }
      }
      this.kv = await Deno.openKv(this.dbPath);
      logger.info(`[DcaKvStore] Deno KV (SQLite) 初期化完了: ${this.dbPath || 'default'}`);

      // 2. Redis 初期化 (Pub/Sub, KLine, 統計キャッシュ用)
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
      });

      this.client.on('error', (err) => {
        logger.error(`[DcaKvStore/Redis] エラー:`, err);
      });

      await this.client.ping();
      logger.info(`[DcaKvStore] Redis データストア初期化完了: ${this.redisUrl} (Prefix: ${this.prefix})`);
    } catch (err: unknown) {
      const error = toError(err);
      logger.error(`[DcaKvStore] 初期化失敗:`, error);
      throw new KvStoreError('DcaKvStore 初期化失敗', { cause: error });
    }
  }

  async pingRedis(): Promise<boolean> {
    try {
      if (!this.client) return false;
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
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

  // ==========================================
  // 1. 4時間足 KLINE キャッシュ (klines_4h)
  // ==========================================
  async saveKline(kline: Kline4h): Promise<void> {
    try {
      const zkey = `${this.prefix}klines:${kline.coin.toUpperCase()}`;
      await this.client.zadd(zkey, kline.t, JSON.stringify(kline));
      // 直近 2500 本を保持
      await this.client.zremrangebyrank(zkey, 0, -2501);
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] KLINE 保存エラー:`, toError(err));
    }
  }

  async saveKlinesBatch(klines: Kline4h[]): Promise<void> {
    if (klines.length === 0) return;
    try {
      const pipeline = this.client.pipeline();
      for (const kline of klines) {
        const zkey = `${this.prefix}klines:${kline.coin.toUpperCase()}`;
        pipeline.zadd(zkey, kline.t, JSON.stringify(kline));
      }
      await pipeline.exec();
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] KLINE バッチ保存エラー:`, toError(err));
    }
  }

  async getRecentKlines(coin: string, count = 2160): Promise<Kline4h[]> {
    try {
      const zkey = `${this.prefix}klines:${coin.toUpperCase()}`;
      // 最新の count 本を昇順で取得
      const rawList = await this.client.zrange(zkey, -count, -1);
      return rawList.map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  }

  // ==========================================
  // 2. 期間価格統計 (price_stats)
  // ==========================================
  async savePriceStats(stats: PriceStatsRecord): Promise<void> {
    const res = await this.savePriceStatsResult(stats);
    if (!res.ok) {
      logger.error(`[DcaKvStore] 期間価格統計保存エラー:`, res.error);
    }
  }

  async savePriceStatsResult(stats: PriceStatsRecord): Promise<Result<void, KvStoreError>> {
    try {
      const serialized = JSON.stringify(stats);
      const hashKey = `${this.prefix}price_stats`;
      const pipeline = this.client.pipeline();
      pipeline.hset(hashKey, stats.coin.toUpperCase(), serialized);
      if (!this.isTest) {
        pipeline.hset('hl:price_stats', stats.coin.toUpperCase(), serialized);
      }
      await pipeline.exec();
      return ok(undefined);
    } catch (e: unknown) {
      const error = new KvStoreError(`期間価格統計保存エラー: ${stats.coin}`, { cause: toError(e) });
      return err(error);
    }
  }

  async getPriceStats(coin: string): Promise<PriceStatsRecord | null> {
    const upper = coin.toUpperCase();
    try {
      // テスト時はモックやローカル保存データを優先
      if (this.isTest) {
        const localRaw = await this.client.hget(`${this.prefix}price_stats`, upper);
        if (localRaw) {
          return normalizeToPriceStatsRecord(JSON.parse(localRaw), upper);
        }
      }

      // 1. 共有 Redis ハッシュ: hl:price_stats (最新アクティブ)
      const sharedRaw = await this.client.hget('hl:price_stats', upper);
      if (sharedRaw) {
        try {
          return normalizeToPriceStatsRecord(JSON.parse(sharedRaw), upper);
        } catch (e) {
          logger.warn(`[DcaKvStore] hl:price_stats パース失敗:`, toError(e));
        }
      }

      // 2. ローカル prefix ハッシュ (${this.prefix}price_stats)
      const hashKey = `${this.prefix}price_stats`;
      const fallbackRaw = await this.client.hget(hashKey, upper);
      if (fallbackRaw) {
        return normalizeToPriceStatsRecord(JSON.parse(fallbackRaw), upper);
      }

      // 3. 共有 Redis 個別キー: hl:evaluator:price_stats:{coin} (バックアップ)
      const singleRaw = await this.client.get(`hl:evaluator:price_stats:${upper}`);
      if (singleRaw) {
        try {
          return normalizeToPriceStatsRecord(JSON.parse(singleRaw), upper);
        } catch (e) {
          logger.warn(`[DcaKvStore] hl:evaluator:price_stats:${upper} パース失敗:`, toError(e));
        }
      }

      return null;
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] getPriceStats エラー (${upper}):`, toError(err));
      return null;
    }
  }

  async findPriceStats(coin: string): Promise<Result<PriceStatsRecord, NotFoundError | KvStoreError>> {
    try {
      const stats = await this.getPriceStats(coin);
      if (!stats) {
        return err(new NotFoundError(`価格統計が見つかりません: ${coin}`));
      }
      return ok(stats);
    } catch (e: unknown) {
      return err(new KvStoreError(`価格統計取得エラー: ${coin}`, { cause: toError(e) }));
    }
  }

  async getAllPriceStats(): Promise<PriceStatsRecord[]> {
    try {
      if (this.isTest) {
        const hashKey = `${this.prefix}price_stats`;
        const localAll = await this.client.hgetall(hashKey);
        if (localAll && Object.keys(localAll).length > 0) {
          return Object.entries(localAll).map(([coin, s]) => normalizeToPriceStatsRecord(JSON.parse(s), coin));
        }
      }

      // 最新のリアルタイム価格マップ (hl:prices) を取得
      let livePrices: Record<string, string> = {};
      try {
        livePrices = await this.client.hgetall('hl:prices') || {};
      } catch {
        // ignore
      }

      // 1. 共有ハッシュ hl:price_stats を最優先で取得 (リアルタイム同期元)
      const sharedAll = await this.client.hgetall('hl:price_stats');
      if (sharedAll && Object.keys(sharedAll).length > 0) {
        return Object.entries(sharedAll).map(([coin, s]) => {
          const rec = normalizeToPriceStatsRecord(JSON.parse(s), coin);
          const livePx = parseFloat(livePrices[coin.toUpperCase()] ?? '');
          if (!isNaN(livePx) && livePx > 0) {
            rec.currentPrice = livePx;
          }
          return rec;
        });
      }

      // 2. ローカル prefix ハッシュ (${this.prefix}price_stats)
      const hashKey = `${this.prefix}price_stats`;
      const localAll = await this.client.hgetall(hashKey);
      if (localAll && Object.keys(localAll).length > 0) {
        return Object.entries(localAll).map(([coin, s]) => {
          const rec = normalizeToPriceStatsRecord(JSON.parse(s), coin);
          const livePx = parseFloat(livePrices[coin.toUpperCase()] ?? '');
          if (!isNaN(livePx) && livePx > 0) {
            rec.currentPrice = livePx;
          }
          return rec;
        });
      }

      return [];
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] getAllPriceStats エラー:`, toError(err));
      return [];
    }
  }

  async findAllPriceStats(): Promise<Result<PriceStatsRecord[], KvStoreError>> {
    try {
      const all = await this.getAllPriceStats();
      return ok(all);
    } catch (e: unknown) {
      return err(new KvStoreError('価格統計一覧取得失敗', { cause: toError(e) }));
    }
  }

  // ==========================================
  // 3. DCA シグナル管理 (signals)
  // ==========================================
  async saveSignal(signal: TradeSignal): Promise<void> {
    try {
      const hashKey = `${this.prefix}signals`;
      const zkey = `${this.prefix}signals:timeline`;
      const score = new Date(signal.createdAt).getTime() || Date.now();

      const pipeline = this.client.pipeline();
      pipeline.hset(hashKey, signal.id, JSON.stringify(signal));
      pipeline.zadd(zkey, score, signal.id);

      // コイン・方向別インデックス (クールダウン・重複判定用)
      // 発注成功 (status === 'EXECUTED') の場合のみ重複除外インデックスに登録し、
      // 発注拒否・失敗時は重複ロックをかけずに次回スキャンでリトライ可能にする
      if (signal.status === 'EXECUTED') {
        const coinSideZkey = `${this.prefix}signals:${signal.coin.toUpperCase()}:${signal.side}`;
        pipeline.zadd(coinSideZkey, score, signal.id);
      }

      await pipeline.exec();
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] シグナル保存エラー:`, toError(err));
    }
  }

  async getSignal(id: string): Promise<TradeSignal | null> {
    try {
      const hashKey = `${this.prefix}signals`;
      const raw = await this.client.hget(hashKey, id);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async findSignal(id: string): Promise<Result<TradeSignal, NotFoundError>> {
    const signal = await this.getSignal(id);
    if (!signal) {
      return err(new NotFoundError(`シグナルが見つかりません: ${id}`));
    }
    return ok(signal);
  }

  async getSignals(limit = 100): Promise<TradeSignal[]> {
    try {
      const zkey = `${this.prefix}signals:timeline`;
      const ids = await this.client.zrevrange(zkey, 0, limit - 1);
      if (ids.length === 0) return [];

      const hashKey = `${this.prefix}signals`;
      const raws = await this.client.hmget(hashKey, ...ids);
      return raws.filter((r): r is string => Boolean(r)).map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  }

  async hasRecentSignal(coin: string, side: TradeSide, windowMs: number): Promise<boolean> {
    try {
      const coinSideZkey = `${this.prefix}signals:${coin.toUpperCase()}:${side}`;
      const thresholdTime = Date.now() - windowMs;
      // thresholdTime 以降のシグナル数をカウント
      const count = await this.client.zcount(coinSideZkey, thresholdTime, '+inf');
      return count > 0;
    } catch {
      return false;
    }
  }

  // ==========================================
  // 4. 注文・約定履歴 (orders & order_fills)
  // orders は Deno KV (SQLite) に永続化し、Redis キャッシュも同期
  // ==========================================
  async saveOrder(order: OrderRecord): Promise<void> {
    try {
      if (this.kv) {
        await this.kv.set(['orders', order.id], order);
        if (order.cloid && order.cloid !== order.id) {
          await this.kv.set(['orders_by_cloid', order.cloid], order.id);
        }
      }

      const hashKey = `${this.prefix}orders`;
      const zkey = `${this.prefix}orders:timeline`;
      const score = new Date(order.createdAt).getTime() || Date.now();

      const pipeline = this.client.pipeline();
      pipeline.hset(hashKey, order.id, JSON.stringify(order));
      pipeline.zadd(zkey, score, order.id);

      if (order.cloid && order.cloid !== order.id) {
        pipeline.hset(`${this.prefix}orders_by_cloid`, order.cloid, order.id);
      }

      await pipeline.exec();
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] 注文保存エラー:`, toError(err));
    }
  }

  async getOrder(id: string): Promise<OrderRecord | null> {
    try {
      if (this.kv) {
        const entry = await this.kv.get<OrderRecord>(['orders', id]);
        if (entry.value) return entry.value;
      }
      const hashKey = `${this.prefix}orders`;
      const raw = await this.client.hget(hashKey, id);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async findOrder(id: string): Promise<Result<OrderRecord, NotFoundError>> {
    const order = await this.getOrder(id);
    if (!order) {
      return err(new NotFoundError(`注文が見つかりません: ${id}`));
    }
    return ok(order);
  }

  async getOrderByCloid(cloid: string): Promise<OrderRecord | null> {
    try {
      if (this.kv) {
        const mappedId = await this.kv.get<string>(['orders_by_cloid', cloid]);
        if (mappedId.value) {
          const entry = await this.kv.get<OrderRecord>(['orders', mappedId.value]);
          if (entry.value) return entry.value;
        }
      }
      const actualId = await this.client.hget(`${this.prefix}orders_by_cloid`, cloid);
      return await this.getOrder(actualId || cloid);
    } catch {
      return null;
    }
  }

  async findOrderByCloid(cloid: string): Promise<Result<OrderRecord, NotFoundError>> {
    const order = await this.getOrderByCloid(cloid);
    if (!order) {
      return err(new NotFoundError(`Cloid に対応する注文が見つかりません: ${cloid}`));
    }
    return ok(order);
  }

  async deleteOrder(id: string): Promise<void> {
    try {
      const existing = await this.getOrder(id);
      if (this.kv) {
        await this.kv.delete(['orders', id]);
        if (existing?.cloid) {
          await this.kv.delete(['orders_by_cloid', existing.cloid]);
        }
      }
      const pipeline = this.client.pipeline();
      if (existing?.cloid) {
        pipeline.hdel(`${this.prefix}orders_by_cloid`, existing.cloid);
      }
      pipeline.hdel(`${this.prefix}orders`, id);
      pipeline.zrem(`${this.prefix}orders:timeline`, id);
      await pipeline.exec();
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] 注文削除エラー:`, toError(err));
    }
  }

  async getOrders(limit = 100): Promise<OrderRecord[]> {
    try {
      if (this.kv) {
        const iter = this.kv.list<OrderRecord>({ prefix: ['orders'] });
        const list: OrderRecord[] = [];
        for await (const entry of iter) {
          if (entry.value) list.push(entry.value);
        }
        list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return list.slice(0, limit);
      }
      const zkey = `${this.prefix}orders:timeline`;
      const ids = await this.client.zrevrange(zkey, 0, limit - 1);
      if (ids.length === 0) return [];

      const hashKey = `${this.prefix}orders`;
      const raws = await this.client.hmget(hashKey, ...ids);
      return raws.filter((r): r is string => Boolean(r)).map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  }

  /**
   * 現在保有中のアクティブな買い注文 (status === 'OPEN') を取得
   */
  async getActiveOpenOrders(coin?: string, limit = 500): Promise<OrderRecord[]> {
    try {
      const allOrders = await this.getOrders(1000);
      return allOrders
        .filter((o) => {
          if (o.status !== 'OPEN') return false;
          if (coin && o.coin.toUpperCase() !== coin.toUpperCase()) return false;
          return o.side === 'BUY';
        })
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 未約定または保有中 (NEW または OPEN) の注文が存在するか確認 (二重発注防止)
   */
  async hasActiveOrder(coin: string, side: 'BUY' | 'SELL' = 'BUY'): Promise<boolean> {
    try {
      const orders = await this.getOrders(200);
      return orders.some((o) => {
        if (o.coin.toUpperCase() !== coin.toUpperCase()) return false;
        if (o.side !== side) return false;
        return o.status === 'NEW' || o.status === 'OPEN';
      });
    } catch {
      return false;
    }
  }

  /**
   * 部分約定または約定累計を反映し、90%以上約定した場合は NEW -> OPEN に昇格する
   */
  async recordOrderFillProgress(idOrCloid: string, fillSize: number): Promise<{ promoted: boolean; currentStatus?: OrderStatus }> {
    try {
      let order = await this.getOrder(idOrCloid);
      if (!order) {
        order = await this.getOrderByCloid(idOrCloid);
      }
      if (!order) return { promoted: false };

      const prevFilled = order.filledSize || 0;
      const newFilled = prevFilled + fillSize;
      order.filledSize = newFilled;
      order.updatedAt = getJstIsoString();

      let promoted = false;
      // 部分約定時、約定サイズが注文サイズの90%以上の場合は NEW -> OPEN に昇格 (浮動小数点誤差を考慮)
      if (order.size > 0 && newFilled >= (order.size * 0.9 - 1e-9)) {
        if (order.status === 'NEW') {
          order.status = 'OPEN';
          promoted = true;
          logger.info(`[DcaKvStore] 🎯 約定率90%以上達成 (${newFilled}/${order.size} BTC): status を NEW -> OPEN に変更 [ID: ${order.id}]`);
          if (this.notifier) {
            try {
              const notional = order.notionalUsd || Math.round(order.price * order.size * 100) / 100;
              await this.notifier.notifyPositionOpened({
                coin: order.coin,
                side: order.side,
                price: order.price,
                size: order.size,
                notionalUsd: notional,
                id: order.id,
              });
            } catch (notifyErr: unknown) {
              logger.error('[DcaKvStore] notifyPositionOpened 送信エラー:', toError(notifyErr));
            }
          }
        }
      }

      await this.saveOrder(order);
      return { promoted, currentStatus: order.status };
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] recordOrderFillProgress エラー:`, toError(err));
      return { promoted: false };
    }
  }

  async updateOrderStatus(idOrCloid: string, status: OrderStatus): Promise<boolean> {
    try {
      let order = await this.getOrder(idOrCloid);
      if (!order) {
        order = await this.getOrderByCloid(idOrCloid);
      }
      if (!order) return false;

      order.status = status;
      order.updatedAt = getJstIsoString();
      await this.saveOrder(order);
      return true;
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] 注文ステータス更新エラー:`, toError(err));
      return false;
    }
  }

  /**
   * TP利確約定時、決済された数量(BTC)に相当する OPEN なDCA買い建玉を CLOSED に更新する
   * 優先順位: 建値(price)が低い順 (同値の場合は古い順)
   */
  async closeOpenOrders(
    coin: string,
    closedSizeBtc: number,
    tpOrderId?: string,
    exitPrice?: number,
  ): Promise<{ closedCount: number; closedTotalSize: number; closedOrders: OrderRecord[] }> {
    const result = {
      closedCount: 0,
      closedTotalSize: 0,
      closedOrders: [] as OrderRecord[],
    };

    if (closedSizeBtc <= 0) return result;

    try {
      const openOrders = await this.getActiveOpenOrders(coin, 500);
      // 建値が低い順、同値なら作成日時が古い順
      openOrders.sort((a, b) => {
        if (a.price !== b.price) {
          return a.price - b.price;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

      let remainingToClose = closedSizeBtc;
      const nowIso = getJstIsoString();

      for (const order of openOrders) {
        if (remainingToClose <= 0) break;

        const effectiveSize = order.filledSize && order.filledSize > 0 ? order.filledSize : order.size;

        order.status = 'CLOSED';
        order.closedAt = nowIso;
        order.updatedAt = nowIso;
        if (tpOrderId) {
          order.closedByTpId = tpOrderId;
        }

        await this.saveOrder(order);

        result.closedCount++;
        result.closedTotalSize += effectiveSize;
        result.closedOrders.push(order);

        remainingToClose -= effectiveSize;
        logger.info(`[DcaKvStore] 🔒 DCA注文クローズ (TP約定連動): ID=${order.id}, 買建値=$${order.price}, サイズ=${effectiveSize} BTC, 残決済=${Math.max(0, remainingToClose).toFixed(4)} BTC`);

        if (exitPrice !== undefined && exitPrice > 0) {
          const buyPrice = order.price;
          const isBuy = order.side === 'BUY';
          const pnlUsd = isBuy ? (exitPrice - buyPrice) * effectiveSize : (buyPrice - exitPrice) * effectiveSize;
          const pnlPct = buyPrice > 0 ? (isBuy ? (exitPrice - buyPrice) / buyPrice : (buyPrice - exitPrice) / buyPrice) * 100 : 0;

          if (this.notifier) {
            try {
              await this.notifier.notifyPositionClosed({
                coin: order.coin,
                side: order.side,
                entryPrice: buyPrice,
                exitPrice,
                size: effectiveSize,
                pnlUsd,
                pnlPct,
                id: order.id,
              });
            } catch (notifyErr: unknown) {
              logger.error('[DcaKvStore] notifyPositionClosed 送信エラー:', toError(notifyErr));
            }
          }
        }
      }

      return result;
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] closeOpenOrders エラー:`, toError(err));
      return result;
    }
  }

  /**
   * TP利確約定を記録し、対象の建玉ステータスを CLOSED に更新して PnL を算出し Slack 通知を行う
   * 注文ID単体をクローズする場合: recordTpOrderFilled(orderId, exitPrice, tpOrderId)
   * 通貨と数量でオープン注文を一括クローズする場合: recordTpOrderFilled(coin, closedSize, exitPrice, tpOrderId)
   */
  async recordTpOrderFilled(
    orderIdOrCoin: string,
    exitPriceOrSize: number,
    exitPriceOrTpId?: number | string,
    tpOrderId?: string,
  ): Promise<{ closedCount: number; closedTotalSize: number; closedOrders: OrderRecord[] } | (OrderRecord | null)> {
    // パターン1: 単一の注文IDが指定された場合
    let singleOrder = await this.getOrder(orderIdOrCoin);
    if (!singleOrder) {
      singleOrder = await this.getOrderByCloid(orderIdOrCoin);
    }

    if (singleOrder && typeof exitPriceOrTpId !== 'number') {
      const exitPrice = exitPriceOrSize;
      const tpId = typeof exitPriceOrTpId === 'string' ? exitPriceOrTpId : tpOrderId;
      const nowIso = getJstIsoString();

      singleOrder.status = 'CLOSED';
      singleOrder.closedAt = nowIso;
      singleOrder.updatedAt = nowIso;
      if (tpId) {
        singleOrder.closedByTpId = tpId;
      }
      await this.saveOrder(singleOrder);

      const buyPrice = singleOrder.price;
      const effectiveSize = singleOrder.filledSize && singleOrder.filledSize > 0 ? singleOrder.filledSize : singleOrder.size;
      const isBuy = singleOrder.side === 'BUY';
      const pnlUsd = isBuy ? (exitPrice - buyPrice) * effectiveSize : (buyPrice - exitPrice) * effectiveSize;
      const pnlPct = buyPrice > 0 ? (isBuy ? (exitPrice - buyPrice) / buyPrice : (buyPrice - exitPrice) / buyPrice) * 100 : 0;

      logger.info(`[DcaKvStore] 🔒 DCA注文クローズ (TP約定): ID=${singleOrder.id}, 買建値=$${buyPrice}, 決済値=$${exitPrice}, PnL=$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

      if (this.notifier) {
        try {
          await this.notifier.notifyPositionClosed({
            coin: singleOrder.coin,
            side: singleOrder.side,
            entryPrice: buyPrice,
            exitPrice,
            size: effectiveSize,
            pnlUsd,
            pnlPct,
            id: singleOrder.id,
          });
        } catch (notifyErr: unknown) {
          logger.error('[DcaKvStore] notifyPositionClosed 送信エラー:', toError(notifyErr));
        }
      }

      return singleOrder;
    }

    // パターン2: 通貨と数量でオープン注文を一括クローズする場合
    const coin = orderIdOrCoin;
    const closedSize = exitPriceOrSize;
    const exitPrice = typeof exitPriceOrTpId === 'number' ? exitPriceOrTpId : 0;
    const tpId = typeof exitPriceOrTpId === 'string' ? exitPriceOrTpId : tpOrderId;

    return await this.closeOpenOrders(coin, closedSize, tpId, exitPrice);
  }

  // --- TP注文 (tp_orders) ---
  async saveTpOrder(order: TpOrderRecord): Promise<void> {
    try {
      if (this.kv) {
        await this.kv.set(['tp_orders', order.id], order);
        if (order.cloid && order.cloid !== order.id) {
          await this.kv.set(['tp_orders_by_cloid', order.cloid], order.id);
        }
      }
      const hashKey = `${this.prefix}tp_orders`;
      await this.client.hset(hashKey, order.id, JSON.stringify(order));
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] TP注文保存エラー:`, toError(err));
    }
  }

  async getTpOrders(limit = 100): Promise<TpOrderRecord[]> {
    try {
      if (this.kv) {
        const iter = this.kv.list<TpOrderRecord>({ prefix: ['tp_orders'] });
        const list: TpOrderRecord[] = [];
        for await (const entry of iter) {
          if (entry.value) list.push(entry.value);
        }
        list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return list.slice(0, limit);
      }
      const hashKey = `${this.prefix}tp_orders`;
      const raws = await this.client.hvals(hashKey);
      return raws.map((s) => JSON.parse(s)).slice(0, limit);
    } catch {
      return [];
    }
  }

  // --- TP クールダウン ---
  async isTpCooldownActive(timeframe: TpTimeframe): Promise<boolean> {
    try {
      const key = `${this.prefix}cooldown:${timeframe}`;
      const val = await this.client.get(key);
      return Boolean(val);
    } catch {
      return false;
    }
  }

  async setTpCooldown(timeframe: TpTimeframe, durationMs: number): Promise<void> {
    try {
      const key = `${this.prefix}cooldown:${timeframe}`;
      await this.client.set(key, '1', 'PX', durationMs);
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] TP クールダウン設定エラー:`, toError(err));
    }
  }

  // --- 全期間共通 TP グローバルクールダウン (最低24H) ---
  async isGlobalTpCooldownActive(): Promise<boolean> {
    const res = await this.findGlobalTpCooldownActive();
    return res.ok ? res.value : false;
  }

  async findGlobalTpCooldownActive(): Promise<Result<boolean, KvStoreError>> {
    try {
      const key = `${this.prefix}cooldown:tp_global`;
      const val = await this.client.get(key);
      return ok(Boolean(val));
    } catch (e: unknown) {
      return err(new KvStoreError('TP グローバルクールダウン確認エラー', { cause: toError(e) }));
    }
  }

  async setGlobalTpCooldown(durationMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    const res = await this.setGlobalTpCooldownResult(durationMs);
    if (!res.ok) {
      logger.error(`[DcaKvStore] TP グローバルクールダウン設定エラー:`, res.error);
    }
  }

  async setGlobalTpCooldownResult(durationMs: number = 24 * 60 * 60 * 1000): Promise<Result<void, KvStoreError>> {
    try {
      const key = `${this.prefix}cooldown:tp_global`;
      await this.client.set(key, '1', 'PX', durationMs);
      return ok(undefined);
    } catch (e: unknown) {
      return err(new KvStoreError('TP グローバルクールダウン設定エラー', { cause: toError(e) }));
    }
  }

  // ==========================================
  // 約定履歴 (order_fills & 共有 hl:fills:{user})
  // ==========================================
  async saveFill(fill: OrderFillRecord): Promise<void> {
    try {
      const score = new Date(fill.timestamp).getTime() || Date.now();
      const zkey = `${this.prefix}order_fills`;
      await this.client.zadd(zkey, score, JSON.stringify(fill));
      // 最新 1000 件を保持
      await this.client.zremrangebyrank(zkey, 0, -1001);
    } catch (err: unknown) {
      logger.error(`[DcaKvStore] 約定保存エラー:`, toError(err));
    }
  }

  async getFills(limit = 100): Promise<OrderFillRecord[]> {
    try {
      const zkey = `${this.prefix}order_fills`;
      const rawList = await this.client.zrevrange(zkey, 0, limit - 1);
      return rawList.map((s) => JSON.parse(s));
    } catch (err: unknown) {
      logger.error('[DcaKvStore] 約定履歴取得エラー:', toError(err));
      return [];
    }
  }

  async getRecentSignals(limit = 100): Promise<TradeSignal[]> {
    return this.getSignals(limit);
  }

  async getRecentOrders(limit = 100): Promise<OrderRecord[]> {
    return this.getOrders(limit);
  }

  /**
   * 共有 Redis (`hl:fills:{user.toLowerCase()}`) から最新約定を取得
   */
  async getSharedUserFills(user: string, limit = 50): Promise<any[]> {
    if (!user) return [];
    try {
      const key = `hl:fills:${user.toLowerCase()}`;
      const stop = Math.max(0, limit - 1);
      const items = await this.client.lrange(key, 0, stop);
      return items.map((item: string) => {
        try {
          return JSON.parse(item);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (err: unknown) {
      logger.warn(`[DcaKvStore] 共有約定履歴取得エラー (${user}):`, toError(err));
      return [];
    }
  }

  /**
   * Result 型で共有約定履歴を取得
   */
  async findSharedUserFills(user: string, limit = 50): Promise<Result<any[], KvStoreError>> {
    try {
      const fills = await this.getSharedUserFills(user, limit);
      return ok(fills);
    } catch (e: unknown) {
      return err(new KvStoreError(`共有約定履歴取得エラー: ${user}`, { cause: toError(e) }));
    }
  }

  /**
   * 共有約定履歴の最終更新時刻 (Unix ms) を取得
   */
  async getSharedFillsUpdatedAt(user: string): Promise<number | null> {
    if (!user) return null;
    try {
      const raw = await this.client.get(`hl:fills:${user.toLowerCase()}:updated_at`);
      return raw ? parseInt(raw, 10) : null;
    } catch (err: unknown) {
      logger.warn(`[DcaKvStore] 約定更新時刻取得エラー (${user}):`, toError(err));
      return null;
    }
  }

  /**
   * 共有約定履歴を OrderFillRecord 形式に変換して取得
   */
  async getSharedFillsAsRecords(user: string, limit = 50, targetCoins?: string[]): Promise<OrderFillRecord[]> {
    const rawFills = await this.getSharedUserFills(user, limit);
    const upperCoins = targetCoins ? new Set(targetCoins.map((c) => c.toUpperCase())) : null;

    const records: OrderFillRecord[] = [];
    for (const f of rawFills) {
      const coin = (f.coin || '').toUpperCase();
      if (upperCoins && !upperCoins.has(coin)) continue;

      const px = parseFloat(f.px || '0');
      const sz = parseFloat(f.sz || '0');
      records.push({
        fillId: f.hash || `${f.tid || Date.now()}_${f.oid}`,
        orderId: f.oid,
        cloid: f.cloid,
        coin,
        side: f.side === 'B' ? 'BUY' : 'SELL',
        price: px,
        size: sz,
        notionalUsd: Math.round(px * sz * 100) / 100,
        fee: parseFloat(f.fee || '0'),
        closedPnl: parseFloat(f.closedPnl || '0'),
        timestamp: typeof f.time === 'number' ? new Date(f.time).toISOString() : (f.timestamp || getJstIsoString()),
      });
    }
    return records;
  }

  async getRecentFills(limit = 100, walletAddress?: string): Promise<OrderFillRecord[]> {
    const local = await this.getFills(limit);
    if (local.length > 0 || !walletAddress) {
      return local;
    }
    return await this.getSharedFillsAsRecords(walletAddress, limit);
  }

  async findRecentFills(limit = 100, walletAddress?: string): Promise<Result<OrderFillRecord[], KvStoreError>> {
    try {
      const fills = await this.getRecentFills(limit, walletAddress);
      return ok(fills);
    } catch (e: unknown) {
      return err(new KvStoreError('約定履歴一覧取得エラー', { cause: toError(e) }));
    }
  }

  // ==========================================
  // ボット稼働可否フラグ (ON/OFF)
  // ==========================================
  async isBotEnabled(): Promise<boolean> {
    const res = await this.findBotEnabled();
    return res.ok ? res.value : true;
  }

  async findBotEnabled(): Promise<Result<boolean, KvStoreError>> {
    try {
      const val = await this.client.get(this.botEnabledKey);
      if (val === null) return ok(true);
      return ok(val === 'true' || val === '1');
    } catch (e: unknown) {
      return err(new KvStoreError('ボット稼働フラグ取得エラー', { cause: toError(e) }));
    }
  }

  async setBotEnabled(enabled: boolean): Promise<void> {
    const res = await this.setBotEnabledResult(enabled);
    if (!res.ok) {
      logger.error('[KvStore] ボット稼働フラグ設定エラー:', res.error);
    }
  }

  async setBotEnabledResult(enabled: boolean): Promise<Result<void, KvStoreError>> {
    try {
      await this.client.set(this.botEnabledKey, enabled ? 'true' : 'false');
      return ok(undefined);
    } catch (e: unknown) {
      return err(new KvStoreError('ボット稼働フラグ設定エラー', { cause: toError(e) }));
    }
  }

  // ==========================================
  // 6. システム状態 (証拠金不足クールダウン等)
  // ==========================================
  async getInsufficientCooldown(): Promise<{ active: boolean; reason?: string; expiresAt?: string; remainingSec?: number }> {
    const res = await this.findInsufficientCooldown();
    return res.ok ? res.value : { active: false };
  }

  async findInsufficientCooldown(): Promise<Result<{ active: boolean; reason?: string; expiresAt?: string; remainingSec?: number }, KvStoreError>> {
    try {
      const key = this.isTest ? `${this.prefix}system:insufficient_cooldown` : `hl:system:insufficient_cooldown`;
      const val = await this.client.get(key);
      const ttl = await this.client.ttl(key);
      if (!val) return ok({ active: false });
      const parsed = JSON.parse(val);
      return ok({
        active: Boolean(parsed.active),
        reason: parsed.reason,
        expiresAt: parsed.expiresAt,
        remainingSec: ttl > 0 ? ttl : undefined,
      });
    } catch (e: unknown) {
      return err(new KvStoreError('証拠金不足クールダウン取得エラー', { cause: toError(e) }));
    }
  }

  async setInsufficientCooldown(reason: string = 'Insufficient margin to place order', durationSec = 3600): Promise<void> {
    const res = await this.setInsufficientCooldownResult(reason, durationSec);
    if (!res.ok) {
      logger.error('[KvStore] 証拠金不足クールダウン設定エラー:', res.error);
    }
  }

  async setInsufficientCooldownResult(reason: string = 'Insufficient margin to place order', durationSec = 3600): Promise<Result<void, KvStoreError>> {
    try {
      const key = this.isTest ? `${this.prefix}system:insufficient_cooldown` : `hl:system:insufficient_cooldown`;
      const val = JSON.stringify({
        active: true,
        reason,
        setAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + durationSec * 1000).toISOString(),
      });
      await this.client.set(key, val, 'EX', durationSec);
      return ok(undefined);
    } catch (e: unknown) {
      return err(new KvStoreError('証拠金不足クールダウン設定エラー', { cause: toError(e) }));
    }
  }

  async clearInsufficientCooldown(): Promise<void> {
    try {
      const key = this.isTest ? `${this.prefix}system:insufficient_cooldown` : `hl:system:insufficient_cooldown`;
      await this.client.del(key);
    } catch (err: unknown) {
      logger.error('[KvStore] 証拠金不足クールダウン解除エラー:', toError(err));
    }
  }

  // ==========================================
  // エラーログ ({prefix}errors)
  // ==========================================
  async recordError(err: unknown, context = 'General'): Promise<void> {
    try {
      const error = toError(err);
      const errorEntry = {
        timestamp: getJstIsoString(),
        service: this.serviceName,
        level: 'ERROR',
        context,
        message: error.message,
        stack: error.stack,
      };
      const key = `${this.prefix}errors`;
      await this.client.lpush(key, JSON.stringify(errorEntry));
      await this.client.ltrim(key, 0, 99);
      await this.client.publish(`${this.prefix}events:errors`, JSON.stringify(errorEntry));
    } catch (e: unknown) {
      console.error('[KvStore] Failed to record error:', toError(e));
    }
  }

  async getRecentErrors(limit = 100): Promise<Array<{ timestamp: string; service: string; level: string; context: string; message: string; stack?: string }>> {
    try {
      const key = `${this.prefix}errors`;
      const rawList = await this.client.lrange(key, 0, limit - 1);
      return rawList.map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return { timestamp: getJstIsoString(), service: this.serviceName, level: 'ERROR', context: 'Unknown', message: s };
        }
      });
    } catch (err: unknown) {
      logger.error('[KvStore] エラーログ取得失敗:', toError(err));
      return [];
    }
  }

  async clearErrors(): Promise<void> {
    try {
      await this.client.del(`${this.prefix}errors`);
    } catch (err: unknown) {
      console.error('[KvStore] Failed to clear errors:', toError(err));
    }
  }
}
