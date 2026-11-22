import { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import type { DcaKvStore } from './kv_store.ts';
import type { OrderRecord, OrderFillRecord } from '../types.ts';
import { getJstIsoString } from './time_helper.ts';
import { toError } from '../errors.ts';

export interface RedisSubscriberOptions {
  redisUrl?: string;
  prefix?: string;
  targetCoins: string[];
  walletAddress?: string;
  store: DcaKvStore;
  onCandle?: (candle: any) => void;
  onPriceUpdate?: (coin: string, price: number) => void;
  onOrderUpdate?: (order: OrderRecord) => void;
  onFill?: (fill: OrderFillRecord) => void;
}

export class RedisSubscriberClient {
  private client: InstanceType<typeof Redis>;
  private commandClient: InstanceType<typeof Redis>;
  private readonly targetCoins: string[];
  private readonly walletAddress?: string;
  private readonly store: DcaKvStore;
  private readonly onCandle?: (candle: any) => void;
  private readonly onPriceUpdate?: (coin: string, price: number) => void;
  private readonly onOrderUpdate?: (order: OrderRecord) => void;
  private readonly onFill?: (fill: OrderFillRecord) => void;
  private readonly prefix: string;

  private latestPrices = new Map<string, number>();
  private isClosed = false;

  constructor(options: RedisSubscriberOptions) {
    const redisUrl = options.redisUrl || Deno.env.get('REDIS_URL') || 'redis://localhost:6379';
    this.prefix = options.prefix || Deno.env.get('REDIS_KEY_PREFIX') || 'hl:';
    this.targetCoins = options.targetCoins.map((c) => c.toUpperCase());
    this.walletAddress = options.walletAddress?.toLowerCase();
    this.store = options.store;
    this.onCandle = options.onCandle;
    this.onPriceUpdate = options.onPriceUpdate;
    this.onOrderUpdate = options.onOrderUpdate;
    this.onFill = options.onFill;

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => {
        if (this.isClosed) return null;
        return Math.min(times * 500, 5000);
      },
    });

    this.commandClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (this.isClosed) return null;
        return Math.min(times * 500, 5000);
      },
    });

    this.client.on('connect', () => {
      logger.info(`[RedisSubscriber] ✅ Redis に接続しました: ${redisUrl}`);
    });

    this.client.on('error', (err) => {
      if (!this.isClosed) {
        logger.error(`[RedisSubscriber] ❌ Redis エラー:`, toError(err));
      }
    });

    this.commandClient.on('error', (err) => {
      if (!this.isClosed) {
        logger.error(`[RedisSubscriber/Command] ❌ Redis エラー:`, toError(err));
      }
    });

    this.client.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message).catch((err: unknown) => {
        logger.error('[RedisSubscriber] handleMessage エラー:', toError(err));
      });
    });
  }

  /**
   * 証拠金不足 (Insufficient margin) クールダウンフラグを Redis に設定する (TTL: 1時間)
   * 全ボット共通キー (hl:system:insufficient_cooldown) に設定
   */
  async setInsufficientCooldown(reason: string = 'Insufficient margin to place order'): Promise<void> {
    try {
      const key = 'hl:system:insufficient_cooldown';
      const val = JSON.stringify({
        active: true,
        reason,
        setAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
      await this.commandClient.set(key, val, 'EX', 3600);
      logger.warn(`[RedisSubscriber] 🚨 証拠金不足クールダウンフラグを設定しました (TTL: 1時間, 理由: ${reason})`);
    } catch (err: unknown) {
      logger.error('[RedisSubscriber] クールダウンフラグ設定失敗:', toError(err));
    }
  }

  /**
   * 現在、証拠金不足によるクールダウン中かどうかを確認する
   * 全ボット共通キー (hl:system:insufficient_cooldown) を確認
   */
  async isInsufficientActive(): Promise<boolean> {
    try {
      const key = 'hl:system:insufficient_cooldown';
      const val = await this.commandClient.get(key);
      if (!val) return false;
      const parsed = JSON.parse(val);
      return Boolean(parsed.active);
    } catch (err: unknown) {
      logger.error('[RedisSubscriber] クールダウンフラグ確認失敗:', toError(err));
      return false;
    }
  }

  getPrice(coin: string): number {
    return this.latestPrices.get(coin.toUpperCase()) || 0;
  }

  async start(): Promise<void> {
    this.isClosed = false;
    const channels = [
      `${this.prefix}events:prices`,
      `${this.prefix}events:orders`,
      `${this.prefix}events:fills`,
    ];
    await this.client.subscribe(...channels);
    logger.info(`[RedisSubscriber] 📡 購読開始: ${channels.join(', ')}`);
  }

  async stop(): Promise<void> {
    this.isClosed = true;
    try {
      await this.client.quit();
      await this.commandClient.quit();
      logger.info('[RedisSubscriber] 🔌 切断完了');
    } catch (e: unknown) {
      logger.error('[RedisSubscriber] 切断エラー:', toError(e));
    }
  }

  private async handleMessage(channel: string, raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      // 1. 最新価格イベント
      if (channel === `${this.prefix}events:prices` && parsed.prices) {
        for (const coin of this.targetCoins) {
          const px = parsed.prices[coin];
          if (typeof px === 'number') {
            this.latestPrices.set(coin, px);
            if (this.onPriceUpdate) {
              this.onPriceUpdate(coin, px);
            }
          }
        }
        return;
      }

      // 2. 注文更新イベント
      if (channel === `${this.prefix}events:orders` && parsed.update && parsed.user) {
        if (this.walletAddress && parsed.user.toLowerCase() !== this.walletAddress) return;

        const update = parsed.update;
        const o = update.order;
        if (!o) return;

        // 対象通貨フィルタリング (監視対象外の通貨の注文は無視)
        const coin = (o.coin || '').toUpperCase();
        if (!this.targetCoins.includes(coin)) return;

        const oid = o.oid ? Number(o.oid) : undefined;
        const cloid = o.cloid || '';
        const status = (update.status || 'open').toUpperCase();
        const nowIso = getJstIsoString();

        (async () => {
          let existing: OrderRecord | null = null;
          if (cloid) {
            existing = await this.store.getOrderByCloid(cloid);
          }
          if (!existing && oid) {
            existing = await this.store.getOrder(oid.toString());
          }

          if (existing) {
            if (status === 'FILLED') {
              existing.status = 'OPEN';
            } else if (status === 'CANCELED' || status === 'CANCELLED') {
              existing.status = 'CANCEL';
            } else if (status === 'REJECTED') {
              existing.status = 'REJECTED';
            }
            existing.updatedAt = nowIso;
            await this.store.saveOrder(existing);
            logger.info(`[RedisSubscriber] 📝 注文更新: ${existing.coin} [${existing.id}] -> ${existing.status}`);
            if (this.onOrderUpdate) {
              this.onOrderUpdate(existing);
            }
          }
        })().catch((e: unknown) => logger.error('[RedisSubscriber] 注文更新エラー:', toError(e)));
        return;
      }

      // 3. 約定イベント
      if (channel === `${this.prefix}events:fills` && Array.isArray(parsed.fills)) {
        if (this.walletAddress && parsed.user?.toLowerCase() !== this.walletAddress) return;

        const nowIso = getJstIsoString();
        for (const f of parsed.fills) {
          const coin = (f.coin || '').toUpperCase();
          if (!this.targetCoins.includes(coin)) continue;

          const px = parseFloat(f.px || '0');
          const sz = parseFloat(f.sz || '0');
          const fillRecord: OrderFillRecord = {
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
            timestamp: nowIso,
          };

          this.store.saveFill(fillRecord).catch((e: unknown) => logger.error('[RedisSubscriber] ❌ 約定保存エラー:', toError(e)));
          logger.info(
            `[RedisSubscriber] 🎉 約定検知: ${coin} ${fillRecord.side} 価格=$${px}, 数量=${sz}`
          );

          // 約定進捗を反映し、90%以上約定した場合は NEW -> OPEN に昇格
          const orderTargetId = fillRecord.cloid || (fillRecord.orderId ? fillRecord.orderId.toString() : '');
          if (orderTargetId) {
            this.store.recordOrderFillProgress(orderTargetId, sz).catch((e: unknown) => {
              logger.error('[RedisSubscriber] 約定進捗記録エラー:', toError(e));
            });
          }

          // 🔍 自身が発注した注文かどうかをチェック (cloid または oid で照合)
          let isOwnOrder = false;
          if (fillRecord.cloid) {
            const order = await this.store.getOrderByCloid(fillRecord.cloid);
            if (order && order.source === 'multi-dca-bot') {
              isOwnOrder = true;
            }
          }
          if (!isOwnOrder && fillRecord.orderId) {
            const order = await this.store.getOrder(fillRecord.orderId.toString());
            if (order && order.source === 'multi-dca-bot') {
              isOwnOrder = true;
            }
          }

          // 自身の注文のみ onFill コールバック（Slack通知）を実行
          if (isOwnOrder) {
            logger.info(`[RedisSubscriber] ✅ 自身の注文の約定: ${coin} ${fillRecord.side} -> Slack通知を送信`);
            if (this.onFill) {
              this.onFill(fillRecord);
            }
          } else {
            logger.info(`[RedisSubscriber] ℹ️ 他のBOTの約定: ${coin} ${fillRecord.side} -> Slack通知をスキップ`);
          }
        }
        return;
      }
    } catch (err: unknown) {
      logger.error('[RedisSubscriber] メッセージ処理エラー:', toError(err));
    }
  }
}
