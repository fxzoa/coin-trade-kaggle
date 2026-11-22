import { Redis } from 'ioredis';
import { logger } from '../logger.ts';
import type { AppKvStore } from './kv_store.ts';
import type { OrderFillRecord } from '../types.ts';
import { getJstIsoString } from './time_helper.ts';
import { toError } from '../errors.ts';

export interface RedisSubscriberOptions {
  redisUrl?: string;
  prefix?: string;
  coin?: string;
  walletAddress?: string;
  store: AppKvStore;
  onPriceUpdate?: (update: { coin: string; price: number; timestamp: number }) => void;
  onFill?: (fill: OrderFillRecord) => void;
}

export class RedisSubscriberClient {
  private client: InstanceType<typeof Redis>;
  private commandClient: InstanceType<typeof Redis>;
  private readonly coin: string;
  private readonly walletAddress?: string;
  private readonly store: AppKvStore;
  private readonly onPriceUpdate?: (update: { coin: string; price: number; timestamp: number }) => void;
  private readonly onFill?: (fill: OrderFillRecord) => void;
  private readonly prefix: string;
  private isClosed = false;

  constructor(options: RedisSubscriberOptions) {
    const redisUrl = options.redisUrl || Deno.env.get('REDIS_URL') || 'redis://localhost:6379';
    this.prefix = options.prefix || Deno.env.get('REDIS_KEY_PREFIX') || 'hl:';
    this.coin = (options.coin || 'BTC').toUpperCase();
    this.walletAddress = options.walletAddress?.toLowerCase();
    this.store = options.store;
    this.onPriceUpdate = options.onPriceUpdate;
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

    this.client.on('error', (err: unknown) => {
      if (!this.isClosed) {
        logger.error(`[RedisSubscriber] ❌ Redis エラー:`, toError(err));
      }
    });

    this.commandClient.on('error', (err: unknown) => {
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

  async connect(): Promise<void> {
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
        // 自BOTの対象コイン (BTC) のみが含まれているか厳格フィルタ
        const px = parsed.prices[this.coin];
        if (typeof px === 'number') {
          const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now();
          this.store.saveCurrentPrice(px).catch((e: unknown) => {
            logger.error(`[RedisSubscriber] 価格キャッシュ保存エラー:`, toError(e));
          });
          if (this.onPriceUpdate) {
            this.onPriceUpdate({ coin: this.coin, price: px, timestamp });
          }
        }
        return;
      }

      // 1.1 注文更新イベント (hl:events:orders)
      if (channel === `${this.prefix}events:orders` && parsed.update && parsed.user) {
        if (this.walletAddress && parsed.user.toLowerCase() !== this.walletAddress) return;
        const o = parsed.update?.order;
        if (!o) return;
        // 自BOTの対象コイン以外の注文イベントは完全無視
        if ((o.coin || '').toUpperCase() !== this.coin) return;

        const updateStatus = String(parsed.update.status || '').toLowerCase();
        const targetId = o.cloid || (o.oid ? String(o.oid) : '');

        if (targetId) {
          if (updateStatus === 'filled') {
            // 完全約定したとき、ステータスを OPEN にする
            logger.info(`[RedisSubscriber] 📝 注文約定検知 (status -> OPEN): [ID: ${targetId}]`);
            this.store.updateGridOrderStatus(targetId, 'OPEN').catch((e: unknown) => {
              logger.error(`[RedisSubscriber] 注文ステータス更新エラー (OPEN):`, toError(e));
            });
            this.store.updateTpOrderStatus(targetId, 'OPEN').catch((e: unknown) => {
              logger.debug(`[RedisSubscriber] TP注文ステータス更新無視:`, toError(e).message);
            });
          } else if (updateStatus === 'open') {
            // 部分約定判定: 残サイズ(sz)と当初サイズ(origSz)から約定率を計算
            const origSz = parseFloat(o.origSz || '0');
            const remSz = parseFloat(o.sz || '0');
            if (origSz > 0) {
              const executedSz = Math.max(0, origSz - remSz);
              if (executedSz >= origSz * 0.9) {
                logger.info(`[RedisSubscriber] 📝 部分約定90%達成検知 (status -> OPEN): [ID: ${targetId}] (${executedSz}/${origSz} BTC)`);
                this.store.updateGridOrderStatus(targetId, 'OPEN').catch((e: unknown) => {
                  logger.error(`[RedisSubscriber] 注文ステータス更新エラー (OPEN):`, toError(e));
                });
                this.store.updateTpOrderStatus(targetId, 'OPEN').catch((e: unknown) => {
                  logger.debug(`[RedisSubscriber] TP注文ステータス更新無視:`, toError(e).message);
                });
              }
            }
          } else if (updateStatus === 'canceled' || updateStatus === 'cancelled') {
            // 注文がキャンセルされたら、ステータスを CANCEL にする
            logger.info(`[RedisSubscriber] 📝 注文取消検知 (status -> CANCEL): [ID: ${targetId}]`);
            this.store.updateGridOrderStatus(targetId, 'CANCEL').catch((e: unknown) => {
              logger.error(`[RedisSubscriber] 注文ステータス更新エラー (CANCEL):`, toError(e));
            });
            this.store.updateTpOrderStatus(targetId, 'CANCEL').catch((e: unknown) => {
              logger.debug(`[RedisSubscriber] TP注文ステータス更新無視:`, toError(e).message);
            });
          }
        }
        return;
      }

      // 2. 約定イベント
      if (channel === `${this.prefix}events:fills` && Array.isArray(parsed.fills)) {
        if (this.walletAddress && parsed.user?.toLowerCase() !== this.walletAddress) return;

        const nowIso = getJstIsoString();
        for (const f of parsed.fills) {
          const coin = (f.coin || '').toUpperCase();
          // 自BOTの対象コイン以外の約定は完全無視
          if (coin !== this.coin) continue;

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
          logger.info(`[RedisSubscriber] 🎉 約定検知: ${coin} ${fillRecord.side} 価格=$${px}, 数量=${sz}`);

          // 🔍 自身が発注した注文かどうかをチェック (cloid または oid で照合)
          let isOwnOrder = false;
          if (fillRecord.cloid) {
            const order = await this.store.getOrderByCloid('grid_orders', fillRecord.cloid);
            if (order && order.source === 'btc-grid-bot') {
              isOwnOrder = true;
            }
          }
          if (!isOwnOrder && fillRecord.orderId) {
            const order = await this.store.getGridOrder(fillRecord.orderId.toString());
            if (order && order.source === 'btc-grid-bot') {
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
