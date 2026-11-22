/**
 * btc-grid-deno: Slack通知アダプタ
 * 環境変数 SLACK_WEBHOOK_URL に直接 HTTP POST で通知を送る
 */

import { logger } from '../../shared/logger.ts';
import { toError } from '../../shared/errors.ts';
import { Redis } from 'ioredis';

export type SlackMessageType =
  | 'ORD_OPEN'
  | 'ORD_TP'
  | 'BUY'
  | 'SELL'
  | 'CLOSE_PLUS'
  | 'CLOSE_MINUS'
  | 'INFO'
  | 'TEXT'
  | 'ERROR';

export interface SlackQueueMessage {
  type: SlackMessageType;
  worker: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

type SlackQueuePublisher = (message: SlackQueueMessage) => Promise<boolean>;

const QUEUE_KEY = Deno.env.get('REDIS_QUEUE_KEY') ??
  Deno.env.get('SLACK_QUEUE_KEY') ?? 'slack:alert:queue';
const REDIS_URL = Deno.env.get('REDIS_URL') ?? 'redis://127.0.0.1:6379';

async function enqueueSlackMessage(message: SlackQueueMessage): Promise<boolean> {
  const redis = new Redis(REDIS_URL, {
    connectTimeout: 1000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => attempt === 1 ? 200 : null,
  });
  redis.on('error', () => {});

  try {
    await redis.lpush(QUEUE_KEY, JSON.stringify(message));
    return true;
  } catch (error: unknown) {
    logger.warn('[SlackNotifier] Slack 通知のキュー登録に失敗:', toError(error));
    return false;
  } finally {
    redis.disconnect();
  }
}

export class SlackNotifier {
  private readonly webhookUrl?: string;
  private readonly botName: string;
  private readonly queuePublisher: SlackQueuePublisher;

  constructor(
    webhookUrl?: string,
    botName: string = 'BTC Grid Trader',
    queuePublisher: SlackQueuePublisher = enqueueSlackMessage,
  ) {
    this.webhookUrl = webhookUrl;
    this.botName = botName;
    this.queuePublisher = queuePublisher;
  }

  async send(
    text: string,
    blocks?: unknown[],
    type: SlackMessageType = 'TEXT',
    details: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (this.webhookUrl !== undefined) {
      if (!this.webhookUrl) {
        logger.debug(`[SlackNotifier] SLACK_WEBHOOK_URL 未設定のためスキップ: ${text}`);
        return false;
      }

      try {
        const payload: Record<string, unknown> = { text };
        if (blocks && Array.isArray(blocks) && blocks.length > 0) {
          payload.blocks = blocks;
        }

        const res = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          logger.warn(`[SlackNotifier] 通知送信失敗 (HTTP ${res.status}): ${await res.text()}`);
          return false;
        }
        return true;
      } catch (err: unknown) {
        logger.error(`[SlackNotifier] 送信中に例外発生:`, toError(err));
        return false;
      }
    }

    return await this.queuePublisher({
      type,
      worker: this.botName,
      timestamp: Date.now(),
      payload: { ...details, text, ...(blocks ? { blocks } : {}) },
    });
  }

  /**
   * 1. 新規注文発注通知 (NEW ORDER)
   */
  async notifyNewOrder(params: {
    coin: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    notionalUsd: number;
    id: string;
    step?: number;
  }): Promise<boolean> {
    const isBuy = params.side === 'BUY';
    const emoji = isBuy ? '🟢' : '🔴';
    const sideLabel = isBuy ? '買い (BUY)' : '売り (SELL)';
    const stepInfo = params.step !== undefined ? `\n• グリッド節目: $${params.step.toLocaleString()}` : '';
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${emoji} *[新規発注 / NEW ORDER]* ${params.coin} ${sideLabel}\n` +
      `• 注文ID: ${params.id}\n` +
      `• 指値価格: $${params.price.toLocaleString()}\n` +
      `• 数量: ${params.size} ${params.coin} ($${params.notionalUsd.toLocaleString()})` +
      stepInfo;
    return await this.send(text, undefined, 'ORD_OPEN', params);
  }

  /**
   * 2. ポジション保有・約定通知 (OPEN POSITION)
   */
  async notifyPositionOpened(params: {
    coin: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    notionalUsd: number;
    id: string;
  }): Promise<boolean> {
    const isBuy = params.side === 'BUY';
    const emoji = isBuy ? '💎' : '💰';
    const sideLabel = isBuy ? '買い (BUY)' : '売り (SELL)';
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${emoji} *[建玉オープン / OPEN POSITION]* ${params.coin} ${sideLabel}\n` +
      `• 注文ID: ${params.id}\n` +
      `• 約定価格: $${params.price.toLocaleString()}\n` +
      `• ポジションサイズ: ${params.size} ${params.coin} ($${params.notionalUsd.toLocaleString()})`;
    return await this.send(text, undefined, params.side, params);
  }

  /**
   * 3. ポジション決済完了・利益確定通知 (CLOSE POSITION)
   */
  async notifyPositionClosed(params: {
    coin: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    exitPrice: number;
    size: number;
    pnlUsd: number;
    pnlPct: number;
    id: string;
  }): Promise<boolean> {
    const pnlSign = params.pnlUsd >= 0 ? '+' : '';
    const pnlEmoji = params.pnlUsd >= 0 ? '🎉' : '⚠️';
    const sideLabel = params.side === 'BUY' ? '買い (BUY)' : '売り (SELL)';
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${pnlEmoji} *[決済完了 / CLOSE POSITION]* ${params.coin} ${sideLabel}\n` +
      `• 注文ID: ${params.id}\n` +
      `• 建値: $${params.entryPrice.toLocaleString()}\n` +
      `• 決済価格: $${params.exitPrice.toLocaleString()}\n` +
      `• 決済数量: ${params.size} ${params.coin}\n` +
      `• 実現損益: ${pnlSign}$${params.pnlUsd.toFixed(1)} (${pnlSign}${params.pnlPct.toFixed(1)}%)`;
    return await this.send(
      text,
      undefined,
      params.pnlUsd >= 0 ? 'CLOSE_PLUS' : 'CLOSE_MINUS',
      params,
    );
  }

  async notifyGridPlaced(level: number, sizeUsd: number, markPx: number): Promise<boolean> {
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `🟢 [BTC Grid] 節目BuyLimit指値を発注しました\n• 指値レベル: $${level.toLocaleString()}\n• 発注サイズ: $${sizeUsd.toLocaleString()}\n• 現在価格: $${markPx.toLocaleString()}`;
    return await this.send(text, undefined, 'ORD_OPEN', { level, sizeUsd, markPx });
  }

  async notifyTpOrder(params: {
    coin: string;
    timeframe: string;
    risePct: number;
    threshold: number;
    exitPrice: number;
    size: number;
    notionalUsd: number;
    id: string;
  }): Promise<boolean> {
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `🎯 [BTC Grid TP] 利益確定(TP)注文を約定しました\n• 通貨: ${params.coin}\n• 時間枠: ${params.timeframe} (上昇率: +${params.risePct.toFixed(2)}% / 閾値: ${params.threshold}%)\n• 決済価格: $${params.exitPrice.toLocaleString()}\n• 決済数量: ${params.size} ${params.coin} ($${params.notionalUsd.toLocaleString()})\n• 注文ID: ${params.id}`;
    return await this.send(text, undefined, 'ORD_TP', params);
  }

  async notifyError(process: string, errorMessage: string): Promise<boolean> {
    const text = `🚨 [BTC Grid ERROR] ${process} でエラーが発生しました\n${errorMessage}`;
    return await this.send(text, undefined, 'ERROR', {
      processName: process,
      errorMessage,
    });
  }
}
