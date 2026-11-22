/**
 * hl-btc-grid-bot: Redis 永続化・状態ストア
 * ローカル SQLite (Deno KV) から Redis への完全移行実装
 */

import { Redis } from 'ioredis';
import type {
  TpTimeframe,
  PriceStats,
  GridOrderRecord,
  TpOrderRecord,
  OrderStatus,
  OrderFillRecord,
  LivePositionState,
  ActiveGridOrder,
  GridConfig,
  TraceRecord,
} from '../types.ts';
import { logger } from '../logger.ts';
import { getJstIsoString } from './time_helper.ts';
import { toError, KvStoreError } from '../errors.ts';
export interface PositionNotifier {
  notifyPositionOpened(payload: {
    coin: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    notionalUsd: number;
    id: string;
  }): Promise<unknown>;
  notifyPositionClosed(payload: {
    coin: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    exitPrice: number;
    size: number;
    pnlUsd: number;
    pnlPct: number;
    id: string;
  }): Promise<unknown>;
}

export class AppKvStore {
  private client!: InstanceType<typeof Redis>;
  private kv!: Deno.Kv;
  private readonly redisUrl: string;
  private readonly prefix: string;
  private readonly dbPath?: string;
  private notifier?: PositionNotifier;

  constructor(dbPath?: string, notifier?: PositionNotifier) {
    this.notifier = notifier;
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

    if (dbPath === ':memory:' || dbPath?.includes('test')) {
      const rand = Math.random().toString(36).substring(2, 9);
      this.prefix = `hl:grid:test:${Date.now()}:${rand}:`;
    } else {
      this.prefix = Deno.env.get('REDIS_KEY_PREFIX') || 'hl:grid:';
    }
  }

  async init(): Promise<void> {
    try {
      // 1. Deno KV (SQLite) の初期化 (OPEN ORDER & CLOSE 履歴の永続化先)
      if (this.dbPath && this.dbPath !== ':memory:' && this.dbPath.includes('/')) {
        const lastSlash = this.dbPath.lastIndexOf('/');
        const dir = this.dbPath.slice(0, lastSlash);
        try {
          await Deno.mkdir(dir, { recursive: true });
        } catch {
          // 既存ディレクトリの場合は無視
        }
      }
      this.kv = await Deno.openKv(this.dbPath);
      logger.info(`[AppKvStore] Deno KV (SQLite) 初期化完了: ${this.dbPath || 'default'}`);

      // 2. Redis クライアントの初期化 (リアルタイム価格・キャッシュ・Pub/Sub用)
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
      });

      this.client.on('error', (err: unknown) => {
        logger.error(`[AppKvStore/Redis] エラー:`, toError(err));
      });

      // 疎通確認
      await this.client.ping();
      logger.info(`[AppKvStore] Redis データストア初期化完了: ${this.redisUrl} (Prefix: ${this.prefix})`);
    } catch (err: unknown) {
      const error = toError(err);
      logger.error(`[AppKvStore] 初期化失敗:`, error);
      throw new KvStoreError(`初期化失敗: ${error.message}`, { cause: err });
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

  setNotifier(notifier: PositionNotifier): void {
    this.notifier = notifier;
  }

  // --- 排他ロック (Run Lock) ---
  async acquireLock(key: string = 'run_lock', ttlMs: number = 60000): Promise<boolean> {
    try {
      const lockKey = `${this.prefix}lock:${key}`;
      // SET key val NX PX ttlMs による完全アトミック分散ロック
      const result = await this.client.set(lockKey, Date.now().toString(), 'PX', ttlMs, 'NX');
      return result === 'OK';
    } catch (err: unknown) {
      logger.error(`[AppKvStore] ロック取得エラー:`, toError(err));
      return false;
    }
  }

  async releaseLock(key: string = 'run_lock'): Promise<void> {
    try {
      const lockKey = `${this.prefix}lock:${key}`;
      await this.client.del(lockKey);
    } catch (err: unknown) {
      logger.error(`[AppKvStore] ロック解放エラー:`, toError(err));
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
      logger.error(`[AppKvStore] TP クールダウン設定エラー:`, toError(err));
    }
  }

  // --- 全期間共通 TP グローバルクールダウン (最低24H) ---
  async isGlobalTpCooldownActive(): Promise<boolean> {
    try {
      const key = `${this.prefix}cooldown:tp_global`;
      const val = await this.client.get(key);
      return Boolean(val);
    } catch {
      return false;
    }
  }

  async setGlobalTpCooldown(durationMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      const key = `${this.prefix}cooldown:tp_global`;
      await this.client.set(key, '1', 'PX', durationMs);
    } catch (err: unknown) {
      logger.error(`[AppKvStore] TP グローバルクールダウン設定エラー:`, toError(err));
    }
  }

  // --- 価格統計キャッシュ ---
  async getCachedPriceStats(_maxAgeMs = 5 * 60 * 1000): Promise<PriceStats | null> {
    try {
      const key = `${this.prefix}cache:price_stats`;
      const raw = await this.client.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async setCachedPriceStats(stats: PriceStats, ttlMs = 10 * 60 * 1000): Promise<void> {
    try {
      const key = `${this.prefix}cache:price_stats`;
      await this.client.set(key, JSON.stringify(stats), 'PX', ttlMs);
    } catch (err: unknown) {
      logger.error(`[AppKvStore] 価格統計保存エラー:`, err);
    }
  }

  // --- 最終実行結果 (Last Run) ---
  async saveLastRun(result: unknown): Promise<void> {
    try {
      await this.client.set(`${this.prefix}status:last_run`, JSON.stringify(result));
    } catch (err: unknown) {
      logger.error(`[AppKvStore] 最終実行結果保存エラー:`, toError(err));
    }
  }

  async getLastRun(): Promise<unknown> {
    try {
      const raw = await this.client.get(`${this.prefix}status:last_run`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // --- 現在価格 & 変動率 ---
  private lastKnownChange24h: number | null = null;

  async saveCurrentPrice(price: number, change24h?: number): Promise<void> {
    try {
      if (change24h !== undefined && !isNaN(change24h)) {
        this.lastKnownChange24h = change24h;
      } else if (this.lastKnownChange24h === null) {
        const existing = await this.getCurrentPriceData();
        this.lastKnownChange24h = existing.change24h;
      }

      const payload = {
        price,
        change24h: this.lastKnownChange24h ?? 0,
        updatedAt: Date.now(),
      };
      await this.client.set(`${this.prefix}status:current_price`, JSON.stringify(payload));
    } catch (err: unknown) {
      logger.error(`[AppKvStore] 現在価格保存エラー:`, toError(err));
    }
  }

  async getCurrentPrice(): Promise<number> {
    const data = await this.getCurrentPriceData();
    return data.price;
  }

  async getCurrentPriceData(): Promise<{ price: number; change24h: number; updatedAt: number }> {
    try {
      const raw = await this.client.get(`${this.prefix}status:current_price`);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          price: parsed.price || 0,
          change24h: parsed.change24h || 0,
          updatedAt: parsed.updatedAt || Date.now(),
        };
      }
    } catch {
      // fallback
    }
    return { price: 0, change24h: 0, updatedAt: Date.now() };
  }

  // --- ポジション状態 ---
  async savePositions(positions: Record<string, LivePositionState>): Promise<void> {
    try {
      await this.client.set(`${this.prefix}status:positions`, JSON.stringify(positions));
    } catch (err: unknown) {
      logger.error(`[AppKvStore] ポジション保存エラー:`, toError(err));
    }
  }

  async getPositions(): Promise<Record<string, LivePositionState>> {
    try {
      const raw = await this.client.get(`${this.prefix}status:positions`);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  // --- アクティブ注文 ---
  async saveActiveOrders(orders: ActiveGridOrder[]): Promise<void> {
    try {
      await this.client.set(`${this.prefix}status:active_orders`, JSON.stringify(orders));
    } catch (err: unknown) {
      logger.error(`[AppKvStore] アクティブ注文保存エラー:`, toError(err));
    }
  }

  async getActiveOrders(): Promise<ActiveGridOrder[]> {
    try {
      const raw = await this.client.get(`${this.prefix}status:active_orders`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  // --- ボット設定 ---
  async saveBotConfig(config: GridConfig): Promise<void> {
    try {
      await this.client.set(`${this.prefix}config:bot`, JSON.stringify(config));
    } catch (err: unknown) {
      logger.error(`[AppKvStore] ボット設定保存エラー:`, toError(err));
    }
  }

  async getBotConfig(): Promise<GridConfig | null> {
    try {
      const raw = await this.client.get(`${this.prefix}config:bot`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // --- トレースログ ---
  async saveTrace(record: TraceRecord, _ttlDays = 7): Promise<void> {
    try {
      const score = new Date(record.timestamp).getTime() || Date.now();
      const zkey = `${this.prefix}traces`;
      await this.client.zadd(zkey, score, JSON.stringify(record));
      // 直近 500 件を維持
      await this.client.zremrangebyrank(zkey, 0, -501);
    } catch (err: unknown) {
      logger.error(`[AppKvStore] トレース保存エラー:`, err);
    }
  }

  // --- グリッド注文 (grid_orders) : Deno KV へ保存 ---
  async saveGridOrder(order: GridOrderRecord): Promise<void> {
    try {
      await this.kv.set(['grid_orders', order.id], order);
      if (order.cloid && order.cloid !== order.id) {
        await this.kv.set(['grid_orders_by_cloid', order.cloid], order.id);
      }
    } catch (err: unknown) {
      logger.error(`[AppKvStore] グリッド注文保存エラー (Deno KV):`, toError(err));
    }
  }

  async getGridOrder(id: string): Promise<GridOrderRecord | null> {
    try {
      const entry = await this.kv.get<GridOrderRecord>(['grid_orders', id]);
      return entry.value ?? null;
    } catch {
      return null;
    }
  }

  async getGridOrders(limit = 100): Promise<GridOrderRecord[]> {
    try {
      const iter = this.kv.list<GridOrderRecord>({ prefix: ['grid_orders'] });
      const records: GridOrderRecord[] = [];
      for await (const entry of iter) {
        if (entry.value) records.push(entry.value);
      }
      records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return records.slice(0, limit);
    } catch {
      return [];
    }
  }

  async getActiveGridOrders(limit = 100): Promise<GridOrderRecord[]> {
    try {
      const iter = this.kv.list<GridOrderRecord>({ prefix: ['grid_orders'] });
      const records: GridOrderRecord[] = [];
      for await (const entry of iter) {
        if (entry.value && entry.value.status === 'OPEN') {
          records.push(entry.value);
        }
      }
      records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return records.slice(0, limit);
    } catch {
      return [];
    }
  }

  async deleteGridOrder(id: string): Promise<void> {
    try {
      // 1. Deno KV から削除
      const order = await this.getGridOrder(id);
      await this.kv.delete(['grid_orders', id]);
      if (order?.cloid && order.cloid !== id) {
        await this.kv.delete(['grid_orders_by_cloid', order.cloid]);
      }
      // もし引数が cloid だった場合の逆引き
      const cloidEntry = await this.kv.get<string>(['grid_orders_by_cloid', id]);
      if (cloidEntry?.value) {
        await this.kv.delete(['grid_orders', cloidEntry.value]);
        await this.kv.delete(['grid_orders_by_cloid', id]);
      }

      // 2. Redis の active_orders リストからも除外
      const activeOrders = await this.getActiveOrders();
      const filtered = activeOrders.filter((o) => {
        const orderIdStr = String(o.orderId ?? '');
        const cloidStr = String(o.cloid ?? '');
        return o.cloid !== id && orderIdStr !== id && cloidStr !== id;
      });
      if (filtered.length !== activeOrders.length) {
        await this.saveActiveOrders(filtered);
      }
      logger.info(`[AppKvStore] 節目注文レコード削除完了: ${id}`);
    } catch (err: unknown) {
      logger.error(`[AppKvStore] 節目注文削除エラー:`, toError(err));
    }
  }

  // --- TP注文 (tp_orders) : Deno KV へ保存 ---
  async saveTpOrder(order: TpOrderRecord): Promise<void> {
    try {
      await this.kv.set(['tp_orders', order.id], order);
      if (order.cloid && order.cloid !== order.id) {
        await this.kv.set(['tp_orders_by_cloid', order.cloid], order.id);
      }
    } catch (err: unknown) {
      logger.error(`[AppKvStore] TP注文保存エラー (Deno KV):`, toError(err));
    }
  }

  async getTpOrder(id: string): Promise<TpOrderRecord | null> {
    try {
      const entry = await this.kv.get<TpOrderRecord>(['tp_orders', id]);
      return entry.value ?? null;
    } catch {
      return null;
    }
  }

  async getTpOrders(limit = 100): Promise<TpOrderRecord[]> {
    try {
      const iter = this.kv.list<TpOrderRecord>({ prefix: ['tp_orders'] });
      const records: TpOrderRecord[] = [];
      for await (const entry of iter) {
        if (entry.value) records.push(entry.value);
      }
      records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return records.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 部分約定または約定累計を反映し、90%以上約定した場合は NEW -> OPEN に昇格する
   */
  async recordOrderFillProgress(idOrCloid: string, fillSize: number): Promise<{ promoted: boolean; currentStatus?: OrderStatus }> {
    try {
      let order = await this.getGridOrder(idOrCloid);
      let isGrid = true;
      if (!order) {
        const mappedId = await this.kv.get<string>(['grid_orders_by_cloid', idOrCloid]);
        if (mappedId.value) {
          order = await this.getGridOrder(mappedId.value);
        }
      }
      if (!order) {
        // TP注文かもチェック
        let tp = await this.getTpOrder(idOrCloid);
        if (!tp) {
          const mappedId = await this.kv.get<string>(['tp_orders_by_cloid', idOrCloid]);
          if (mappedId.value) tp = await this.getTpOrder(mappedId.value);
        }
        if (tp) {
          const prevFilled = tp.filledSize || 0;
          const newFilled = prevFilled + fillSize;
          tp.filledSize = newFilled;
          tp.updatedAt = getJstIsoString();
          let promoted = false;
          if (tp.size > 0 && newFilled >= tp.size * 0.9) {
            if (tp.status === 'NEW') {
              tp.status = 'OPEN';
              promoted = true;
              if (this.notifier) {
                const notional = tp.notionalUsd || (tp.price * (tp.filledSize || tp.size));
                await this.notifier.notifyPositionOpened({
                  coin: tp.coin,
                  side: 'SELL',
                  price: tp.price,
                  size: tp.filledSize || tp.size,
                  notionalUsd: Math.round(notional * 100) / 100,
                  id: tp.id,
                });
              }
            }
          }
          await this.saveTpOrder(tp);
          return { promoted, currentStatus: tp.status };
        }
        return { promoted: false };
      }

      const prevFilled = order.filledSize || 0;
      const newFilled = prevFilled + fillSize;
      order.filledSize = newFilled;
      order.updatedAt = getJstIsoString();

      let promoted = false;
      // 部分約定時、約定サイズが注文サイズの90%以上の場合は NEW -> OPEN に昇格
      if (order.size > 0 && newFilled >= order.size * 0.9) {
        if (order.status === 'NEW') {
          order.status = 'OPEN';
          promoted = true;
          logger.info(`[AppKvStore] 🎯 約定率90%以上達成 (${newFilled}/${order.size} BTC): status を NEW -> OPEN に変更 [ID: ${order.id}]`);
          if (this.notifier) {
            const notional = order.notionalUsd || (order.price * (order.filledSize || order.size));
            await this.notifier.notifyPositionOpened({
              coin: order.coin,
              side: 'BUY',
              price: order.price,
              size: order.filledSize || order.size,
              notionalUsd: Math.round(notional * 100) / 100,
              id: order.id,
            });
          }
        }
      }

      await this.saveGridOrder(order);
      return { promoted, currentStatus: order.status };
    } catch (err: unknown) {
      logger.error(`[AppKvStore] recordOrderFillProgress エラー:`, err);
      return { promoted: false };
    }
  }

  async updateGridOrderStatus(idOrCloid: string, status: OrderStatus): Promise<boolean> {
    try {
      let order = await this.getGridOrder(idOrCloid);
      if (!order) {
        const mappedId = await this.kv.get<string>(['grid_orders_by_cloid', idOrCloid]);
        if (mappedId.value) {
          order = await this.getGridOrder(mappedId.value);
        }
      }
      if (!order) return false;

      order.status = status;
      order.updatedAt = getJstIsoString();
      await this.saveGridOrder(order);
      return true;
    } catch (err: unknown) {
      logger.error(`[AppKvStore] グリッド注文ステータス更新エラー (Deno KV):`, err);
      return false;
    }
  }

  /**
   * TP利確約定時、決済された数量(BTC)に相当する OPEN なグリッド買い建玉を CLOSED に更新し、PnL損益計算およびSlack通知を行う
   */
  async recordTpOrderFilled(
    first: number | string | { exitPrice: number; size?: number; tpOrderId?: string; orderId?: string },
    second?: number | string,
    third?: string | number
  ): Promise<{ closedCount: number; closedTotalSize: number; closedOrders: GridOrderRecord[] }> {
    const result = {
      closedCount: 0,
      closedTotalSize: 0,
      closedOrders: [] as GridOrderRecord[],
    };

    let exitPrice = 0;
    let closedSizeBtc = 0;
    let tpOrderId: string | undefined;
    let specificOrderId: string | undefined;

    if (typeof first === 'object' && first !== null) {
      exitPrice = first.exitPrice;
      closedSizeBtc = first.size ?? 0;
      tpOrderId = first.tpOrderId ?? first.orderId;
    } else if (typeof first === 'string') {
      specificOrderId = first;
      if (typeof second === 'number') {
        exitPrice = second;
      }
      if (typeof third === 'number') {
        closedSizeBtc = third;
      } else if (typeof third === 'string') {
        tpOrderId = third;
      }
    } else if (typeof first === 'number') {
      exitPrice = first;
      if (typeof second === 'number') {
        closedSizeBtc = second;
      } else if (typeof second === 'string') {
        tpOrderId = second;
      }
      if (typeof third === 'string') {
        tpOrderId = third;
      } else if (typeof third === 'number') {
        closedSizeBtc = third;
      }
    }

    try {
      if (exitPrice <= 0 && tpOrderId) {
        const tp = await this.getTpOrder(tpOrderId);
        if (tp && tp.price > 0) {
          exitPrice = tp.price;
        }
      }

      const nowIso = getJstIsoString();

      // 特定の1注文のみ指定された場合
      if (specificOrderId) {
        let order = await this.getGridOrder(specificOrderId);
        if (!order) {
          const mappedId = await this.kv.get<string>(['grid_orders_by_cloid', specificOrderId]);
          if (mappedId.value) {
            order = await this.getGridOrder(mappedId.value);
          }
        }
        if (order && order.status === 'OPEN') {
          const effectiveSize = (closedSizeBtc > 0 && closedSizeBtc < (order.filledSize || order.size))
            ? closedSizeBtc
            : (order.filledSize && order.filledSize > 0 ? order.filledSize : order.size);

          order.status = 'CLOSED';
          order.closedAt = nowIso;
          order.updatedAt = nowIso;
          if (tpOrderId) {
            order.closedByTpId = tpOrderId;
          }

          await this.saveGridOrder(order);

          result.closedCount = 1;
          result.closedTotalSize = effectiveSize;
          result.closedOrders.push(order);

          const buyPrice = order.price;
          const gain = (exitPrice - buyPrice) * effectiveSize;
          const pnlPct = buyPrice > 0 ? ((exitPrice - buyPrice) / buyPrice) * 100 : 0;

          if (this.notifier && exitPrice > 0) {
            await this.notifier.notifyPositionClosed({
              coin: order.coin,
              side: 'BUY',
              entryPrice: buyPrice,
              exitPrice,
              size: effectiveSize,
              pnlUsd: Math.round(gain * 100) / 100,
              pnlPct: Math.round(pnlPct * 100) / 100,
              id: order.id,
            });
          }
          return result;
        }
      }

      if (closedSizeBtc <= 0) return result;

      const openOrders = await this.getActiveGridOrders(500);
      // 建値が低い順、同値なら作成日時が古い順
      openOrders.sort((a, b) => {
        if (a.price !== b.price) {
          return a.price - b.price;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

      let remainingToClose = closedSizeBtc;

      for (const order of openOrders) {
        if (remainingToClose <= 0) break;

        const effectiveSize = order.filledSize && order.filledSize > 0 ? order.filledSize : order.size;

        // 建玉をクローズ
        order.status = 'CLOSED';
        order.closedAt = nowIso;
        order.updatedAt = nowIso;
        if (tpOrderId) {
          order.closedByTpId = tpOrderId;
        }

        await this.saveGridOrder(order);

        result.closedCount++;
        result.closedTotalSize += effectiveSize;
        result.closedOrders.push(order);

        remainingToClose -= effectiveSize;
        logger.info(`[AppKvStore] 🔒 グリッド注文クローズ (TP約定連動): ID=${order.id}, 買建値=$${order.price}, サイズ=${effectiveSize} BTC, 残決済=${Math.max(0, remainingToClose).toFixed(4)} BTC`);

        // PnL 計算 & Slack 通知: gain = (exitPrice - buyPrice) * size
        const buyPrice = order.price;
        const gain = (exitPrice - buyPrice) * effectiveSize;
        const pnlPct = buyPrice > 0 ? ((exitPrice - buyPrice) / buyPrice) * 100 : 0;

        if (this.notifier && exitPrice > 0) {
          await this.notifier.notifyPositionClosed({
            coin: order.coin,
            side: 'BUY',
            entryPrice: buyPrice,
            exitPrice,
            size: effectiveSize,
            pnlUsd: Math.round(gain * 100) / 100,
            pnlPct: Math.round(pnlPct * 100) / 100,
            id: order.id,
          });
        }
      }

      return result;
    } catch (err: unknown) {
      logger.error(`[AppKvStore] recordTpOrderFilled エラー:`, err);
      return result;
    }
  }

  /**
   * TP利確約定時、決済された数量(BTC)に相当する OPEN なグリッド買い建玉を CLOSED に更新する
   * 優先順位: 建値(price)が低い順 (同値の場合は古い順)
   */
  async closeOpenGridOrders(
    closedSizeBtc: number,
    tpOrderId?: string,
    exitPrice?: number
  ): Promise<{ closedCount: number; closedTotalSize: number; closedOrders: GridOrderRecord[] }> {
    return await this.recordTpOrderFilled(exitPrice ?? 0, closedSizeBtc, tpOrderId);
  }

  async updateTpOrderStatus(idOrCloid: string, status: OrderStatus): Promise<boolean> {
    try {
      let order = await this.getTpOrder(idOrCloid);
      if (!order) {
        const mappedId = await this.kv.get<string>(['tp_orders_by_cloid', idOrCloid]);
        if (mappedId.value) {
          order = await this.getTpOrder(mappedId.value);
        }
      }
      if (!order) return false;

      order.status = status;
      order.updatedAt = getJstIsoString();
      await this.saveTpOrder(order);
      return true;
    } catch (err: unknown) {
      logger.error(`[AppKvStore] TP注文ステータス更新エラー (Deno KV):`, err);
      return false;
    }
  }

  async getRecentTraces(limit = 50): Promise<TraceRecord[]> {
    try {
      const zkey = `${this.prefix}traces`;
      const rawList = await this.client.zrevrange(zkey, 0, limit - 1);
      return rawList.map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  }

  // --- エラーログ ({prefix}errors) ---
  async recordError(err: unknown, context = 'General'): Promise<void> {
    try {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const errorEntry = {
        timestamp: getJstIsoString(),
        service: 'btc-grid-bot',
        level: 'ERROR',
        context,
        message,
        stack,
      };
      const key = `${this.prefix}errors`;
      await this.client.lpush(key, JSON.stringify(errorEntry));
      await this.client.ltrim(key, 0, 99);
      await this.client.publish(`${this.prefix}events:errors`, JSON.stringify(errorEntry));
    } catch (e: unknown) {
      console.error('[AppKvStore] Failed to record error:', e);
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
          return { timestamp: getJstIsoString(), service: 'btc-grid-bot', level: 'ERROR', context: 'Unknown', message: s };
        }
      });
    } catch {
      return [];
    }
  }

  async clearErrors(): Promise<void> {
    try {
      await this.client.del(`${this.prefix}errors`);
    } catch (err: unknown) {
      logger.error('[AppKvStore] Failed to clear errors:', toError(err));
    }
  }

  // --- 約定履歴 (fills) : Deno KV へ保存 ---
  async saveFill(fill: OrderFillRecord): Promise<void> {
    try {
      // 重複チェック: fillId または exchangeTime_fillId
      const fillIdKey = fill.fillId || `${fill.exchangeTime ?? 0}_${fill.orderId ?? Date.now()}`;
      const existing = await this.kv.get<boolean>(['fill_dedup', fillIdKey]);
      if (existing.value) {
        return; // 重複
      }

      const timestamp = new Date(fill.timestamp).getTime() || Date.now();
      // キー設計: 時系列逆順で取得しやすいように timestamp_id をキーとする
      const fillStoreKey = ['fills', `${timestamp}_${fillIdKey}`];
      await this.kv.atomic()
        .set(fillStoreKey, fill)
        .set(['fill_dedup', fillIdKey], true)
        .commit();

      // 約定時、約定進捗（累計サイズ）を反映し、90%以上約定した場合は NEW -> OPEN に昇格
      const targetId = fill.cloid || (fill.orderId ? fill.orderId.toString() : '');
      if (targetId) {
        await this.recordOrderFillProgress(targetId, fill.size || 0);
      }
    } catch (err: unknown) {
      logger.error(`[AppKvStore] 約定履歴保存エラー (Deno KV):`, toError(err));
    }
  }

  async getFills(limit = 50): Promise<OrderFillRecord[]> {
    try {
      const iter = this.kv.list<OrderFillRecord>({ prefix: ['fills'] }, { limit: limit * 2, reverse: true });
      const records: OrderFillRecord[] = [];
      for await (const entry of iter) {
        if (entry.value) records.push(entry.value);
        if (records.length >= limit) break;
      }
      return records;
    } catch {
      return [];
    }
  }

  async getOrderByCloid(table: 'grid_orders' | 'tp_orders', cloid: string): Promise<GridOrderRecord | TpOrderRecord | null> {
    try {
      const prefix = table === 'grid_orders' ? 'grid_orders_by_cloid' : 'tp_orders_by_cloid';
      const mappedId = await this.kv.get<string>([prefix, cloid]);
      if (!mappedId.value) return null;
      return table === 'grid_orders'
        ? await this.getGridOrder(mappedId.value)
        : await this.getTpOrder(mappedId.value);
    } catch {
      return null;
    }
  }

  // ==========================================
  // ボット稼働可否フラグ (ON/OFF)
  // ==========================================
  async isBotEnabled(): Promise<boolean> {
    try {
      const val = await this.client.get('hl:grid:enabled');
      if (val === null) return true;
      return val === 'true' || val === '1';
    } catch {
      return true;
    }
  }

  async setBotEnabled(enabled: boolean): Promise<void> {
    try {
      await this.client.set('hl:grid:enabled', enabled ? 'true' : 'false');
    } catch (err: unknown) {
      logger.error('[KvStore] ボット稼働フラグ設定エラー:', toError(err));
    }
  }

  // ==========================================
  // システム状態 (証拠金不足クールダウン等)
  // ==========================================
  async getInsufficientCooldown(): Promise<{ active: boolean; reason?: string; expiresAt?: string; remainingSec?: number }> {
    try {
      const key = `hl:system:insufficient_cooldown`;
      const val = await this.client.get(key);
      const ttl = await this.client.ttl(key);
      if (!val) return { active: false };
      const parsed = JSON.parse(val);
      return {
        active: Boolean(parsed.active),
        reason: parsed.reason,
        expiresAt: parsed.expiresAt,
        remainingSec: ttl > 0 ? ttl : undefined,
      };
    } catch {
      return { active: false };
    }
  }
}
