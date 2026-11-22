/**
 * Redis Pub/Sub 新規オーダー依頼パブリッシャー (BOT 共通)
 *
 * 各 BOT は自前で Hyperliquid へ発注せず、トレードシグナル検知時に注文データを
 * REDIS_ORDER_CHANNEL (既定 hl:events:orders:new) へ PUBLISH する。
 * 実際の発注は coin-trade-bot が購読して実行し、結果を結果トピックへ返す。
 */

import { Redis } from 'ioredis';

export const DEFAULT_ORDER_CHANNEL = 'hl:events:orders:new';
export const DEFAULT_ORDER_RESULT_CHANNEL = 'hl:events:orders:result';

export interface OrderRequestMessage {
  id: string;
  /** 発行元 BOT 種別 (例: btc-dca-bot) */
  source: string;
  /** 発行元 BOT の識別ID (複数インスタンス区別用) */
  botId: string;
  coin: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  /** 数量のドル換算 (price × size) */
  notionalUsd: number;
  orderType: 'Alo' | 'Gtc' | 'Ioc';
  reduceOnly: boolean;
  /** Hyperliquid cloid (0x + 32桁hex) */
  cloid: string;
  signalId?: string;
  timestamp: number;
}

export interface OrderResultMessage {
  requestId: string;
  source: string;
  botId?: string;
  coin: string;
  side: 'BUY' | 'SELL';
  status: 'resting' | 'filled' | 'rejected' | 'error' | 'dry_run' | 'skipped';
  size?: number;
  notionalUsd?: number;
  error?: string;
  oid?: number;
  cloid?: string;
}

export interface OrderPublisherLog {
  error(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
}

export interface OrderPublisherOptions {
  redisUrl: string;
  /** BOT 種別 (例: btc-dca-bot) */
  source: string;
  /** BOT 識別ID (未指定時は source) */
  botId?: string;
  channel?: string;
  resultChannel?: string;
  log?: OrderPublisherLog;
}

export class OrderPublisher {
  readonly source: string;
  readonly botId: string;
  readonly channel: string;
  private readonly redisUrl: string;
  private readonly resultChannel: string;
  private readonly log: OrderPublisherLog;
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(options: OrderPublisherOptions) {
    this.redisUrl = options.redisUrl;
    this.source = options.source;
    this.botId = options.botId || options.source;
    this.channel = options.channel || DEFAULT_ORDER_CHANNEL;
    this.resultChannel = options.resultChannel || DEFAULT_ORDER_RESULT_CHANNEL;
    this.log = options.log ?? { error: console.error, warn: console.warn };
  }

  /** 環境変数 (REDIS_URL / REDIS_ORDER_CHANNEL / REDIS_ORDER_RESULT_CHANNEL / BOT_ID) から生成 */
  static fromEnv(source: string, log?: OrderPublisherLog): OrderPublisher {
    return new OrderPublisher({
      redisUrl: Deno.env.get('REDIS_URL') || 'redis://localhost:6379',
      source,
      botId: Deno.env.get('BOT_ID') || undefined,
      channel: Deno.env.get('REDIS_ORDER_CHANNEL') || undefined,
      resultChannel: Deno.env.get('REDIS_ORDER_RESULT_CHANNEL') || undefined,
      log,
    });
  }

  private getPub(): Redis {
    if (!this.pub) {
      this.pub = new Redis(this.redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true });
      this.pub.on('error', (e: unknown) => this.log.error('[OrderPublisher] Redis エラー:', e));
    }
    return this.pub;
  }

  /**
   * 新規オーダー依頼を PUBLISH する。
   * @returns 受信した購読者数 (0 の場合 coin-trade-bot が未起動で依頼は失われている)
   */
  async publish(message: OrderRequestMessage): Promise<number> {
    return await this.getPub().publish(this.channel, JSON.stringify(message));
  }

  /** coin-trade-bot からの発注結果トピックを購読する (自 botId 宛のみ通知) */
  async subscribeResults(onResult: (r: OrderResultMessage) => void): Promise<void> {
    if (this.sub) return;
    this.sub = new Redis(this.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.sub.on('error', (e: unknown) => this.log.error('[OrderPublisher:Sub] Redis エラー:', e));
    this.sub.on('message', (ch: string, raw: string) => {
      if (ch !== this.resultChannel) return;
      try {
        const r = JSON.parse(raw) as OrderResultMessage;
        if ((r.botId ?? r.source) === this.botId) onResult(r);
      } catch (e: unknown) {
        this.log.warn('[OrderPublisher:Sub] 結果パース失敗:', e);
      }
    });
    await this.sub.subscribe(this.resultChannel);
  }

  async close(): Promise<void> {
    await this.sub?.quit().catch(() => {});
    await this.pub?.quit().catch(() => {});
    this.sub = null;
    this.pub = null;
  }
}
