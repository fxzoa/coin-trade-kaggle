/**
 * 他 BOT 向け Slack 通知キュー クライアント (Producer Client)
 *
 * 使い方:
 * ```typescript
 * import { SlackAlertClient } from './src/client.ts';
 *
 * const alert = new SlackAlertClient({ redisUrl: 'redis://127.0.0.1:6379' });
 * await alert.sendOrderOpen({
 *   coin: 'BTC',
 *   action: 'LONG',
 *   signalType: 'DipLong_7D',
 *   markPrice: 65000,
 *   targetSize: 0.05,
 *   notionalUsd: 3250,
 * });
 * ```
 */

import type { Redis, RedisOptions } from "ioredis";
import type {
  SendClosePositionAlertRequest,
  SendErrorAlertRequest,
  SendFillEventAlertRequest,
  SendInfoAlertRequest,
  SendOrderCanceledAlertRequest,
  SendOrderOpenAlertRequest,
  SendTextMessageRequest,
  SlackQueueMessage,
} from "./types.ts";
import { createRedisClient } from "./queue/connection.ts";
import { QueueProducer } from "./queue/producer.ts";
import { DEFAULT_REDIS_QUEUE_KEY } from "./constants.ts";

export interface SlackAlertClientConfig {
  redisUrl?: string;
  redisOptions?: RedisOptions;
  queueKey?: string;
  workerName?: string;
}

export class SlackAlertClient {
  private readonly redis: Redis;
  private readonly producer: QueueProducer;
  private readonly workerName?: string;
  private isExternalRedis = false;

  constructor(config: SlackAlertClientConfig = {}) {
    const queueKey = config.queueKey || DEFAULT_REDIS_QUEUE_KEY;
    this.workerName = config.workerName;

    if (config.redisOptions) {
      this.redis = createRedisClient(config.redisOptions);
    } else {
      const url = config.redisUrl || Deno.env.get("REDIS_URL") ||
        "redis://127.0.0.1:6379";
      this.redis = createRedisClient(url);
    }

    this.producer = new QueueProducer(this.redis, queueKey);
  }

  /**
   * 既存の Redis インスタンスからクライアントを初期化
   */
  public static fromExistingRedis(
    redis: Redis,
    queueKey: string = DEFAULT_REDIS_QUEUE_KEY,
    workerName?: string,
  ): SlackAlertClient {
    const client = Object.create(
      SlackAlertClient.prototype,
    ) as SlackAlertClient;
    // @ts-ignore private injection
    client.redis = redis;
    // @ts-ignore private injection
    client.producer = new QueueProducer(redis, queueKey);
    // @ts-ignore private injection
    client.workerName = workerName;
    // @ts-ignore private injection
    client.isExternalRedis = true;
    return client;
  }

  /**
   * 汎用ディスパッチ
   */
  public async dispatch(
    type: string,
    payload: Record<string, unknown>,
    traceId?: string,
  ): Promise<number> {
    const message: SlackQueueMessage = {
      type,
      payload: payload as unknown as Record<string, unknown>,
      worker: this.workerName,
      traceId,
      timestamp: Date.now(),
    };
    return await this.producer.push(message);
  }

  /**
   * テキスト通知
   */
  public async sendText(req: SendTextMessageRequest): Promise<number> {
    return await this.dispatch(
      "TEXT",
      req as unknown as Record<string, unknown>,
      req.traceId,
    );
  }

  /**
   * エラーアラート通知
   */
  public async sendError(req: SendErrorAlertRequest): Promise<number> {
    return await this.dispatch(
      "ERROR",
      req as unknown as Record<string, unknown>,
      req.traceId,
    );
  }

  /**
   * 情報・ステータス通知
   */
  public async sendInfo(req: SendInfoAlertRequest): Promise<number> {
    return await this.dispatch(
      "INFO",
      req as unknown as Record<string, unknown>,
      req.traceId,
    );
  }

  /**
   * 新規発注・DCA増玉通知
   */
  public async sendOrderOpen(req: SendOrderOpenAlertRequest): Promise<number> {
    return await this.dispatch(
      "ORDER_OPEN",
      req as unknown as Record<string, unknown>,
      req.traceId,
    );
  }

  /**
   * 注文キャンセル通知
   */
  public async sendOrderCanceled(
    req: SendOrderCanceledAlertRequest,
  ): Promise<number> {
    return await this.dispatch(
      "ORDER_CANCELED",
      req as unknown as Record<string, unknown>,
      req.traceId,
    );
  }

  /**
   * ポジション決済 (TP/SL) 通知
   */
  public async sendClosePosition(
    req: SendClosePositionAlertRequest,
  ): Promise<number> {
    return await this.dispatch(
      "CLOSE_POSITION",
      req as unknown as Record<string, unknown>,
      req.traceId,
    );
  }

  /**
   * 約定 (FILL) 通知
   */
  public async sendFill(req: SendFillEventAlertRequest): Promise<number> {
    return await this.dispatch(
      "FILL",
      req as unknown as Record<string, unknown>,
      req.traceId,
    );
  }

  /**
   * キューの現在の長さを取得
   */
  public async getQueueLength(): Promise<number> {
    return await this.producer.getQueueLength();
  }

  /**
   * 接続切断
   */
  public async close(): Promise<void> {
    if (!this.isExternalRedis) {
      await this.redis.quit();
    }
  }
}
