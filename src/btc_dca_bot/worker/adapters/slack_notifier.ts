/**
 * dca-deno: Slack 通知アダプタ
 */

import { logger } from '../../shared/logger.ts';
import type { TradeSignal, OrderFillRecord } from '../../shared/types.ts';
import { formatJstLog } from '../../shared/helpers/time_helper.ts';
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
    botName: string = 'BTC DCA Trader',
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
        logger.debug('[SlackNotifier] SLACK_WEBHOOK_URL 未設定のためスキップ');
        return false;
      }

      try {
        const res = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(blocks ? { text, blocks } : { text }),
        });

        if (!res.ok) {
          logger.warn(`[SlackNotifier] 送信失敗 HTTP ${res.status}`);
          return false;
        }
        return true;
      } catch (err: unknown) {
        logger.error('[SlackNotifier] 送信例外:', toError(err));
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
   * 新規注文発注通知 (NEW ORDER)
   */
  async notifyNewOrder(params: {
    coin: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    notionalUsd: number;
    id: string;
    timeframe?: string;
  }): Promise<boolean> {
    const isBuy = params.side === 'BUY';
    const emoji = isBuy ? '📝' : '🔻';
    const timeframeText = params.timeframe ? ` (${params.timeframe})` : '';
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${emoji} *[新規発注 / NEW ORDER]* ${params.coin} ${params.side}${timeframeText}\n` +
      `• 価格: $${Number(params.price).toLocaleString()}\n` +
      `• 数量: ${params.size} ${params.coin} ($${Number(params.notionalUsd).toLocaleString()})\n` +
      `• 注文ID: ${params.id}\n` +
      `• 発注時刻: ${formatJstLog()}`;

    return await this.send(text, undefined, 'ORD_OPEN', params);
  }

  /**
   * 建玉オープン通知 (OPEN POSITION)
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
    const emoji = isBuy ? '🎯' : '🎯';
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${emoji} *[建玉オープン / OPEN POSITION]* ${params.coin} ${params.side}\n` +
      `• 約定価格: $${Number(params.price).toLocaleString()}\n` +
      `• 建玉数量: ${params.size} ${params.coin} ($${Number(params.notionalUsd).toLocaleString()})\n` +
      `• 注文ID: ${params.id}\n` +
      `• 約定時刻: ${formatJstLog()}`;

    return await this.send(text, undefined, params.side, params);
  }

  /**
   * ポジションクローズ通知 (CLOSE POSITION)
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
    const isProfit = params.pnlUsd >= 0;
    const emoji = isProfit ? '🏁 💰' : '🏁 ⚠️';
    const sign = isProfit ? '+' : '';
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${emoji} *[利確・決済完了 / CLOSE POSITION]* ${params.coin} ${params.side}\n` +
      `• 買建値: $${Number(params.entryPrice).toLocaleString()}\n` +
      `• 決済値: $${Number(params.exitPrice).toLocaleString()}\n` +
      `• 数量: ${params.size} ${params.coin}\n` +
      `• 実現損益: ${sign}$${params.pnlUsd.toFixed(2)} (${sign}${params.pnlPct.toFixed(2)}%)\n` +
      `• 注文ID: ${params.id}\n` +
      `• 決済時刻: ${formatJstLog()}`;

    return await this.send(text, undefined, isProfit ? 'CLOSE_PLUS' : 'CLOSE_MINUS', params);
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
      `🎯 *[TP ORDER]* ${params.coin} (${params.timeframe})\n` +
      `• 上昇率: +${params.risePct.toFixed(2)}% (閾値: ${params.threshold}%)\n` +
      `• 決済価格: $${Number(params.exitPrice).toLocaleString()}\n` +
      `• 決済数量: ${params.size} ${params.coin} ($${Number(params.notionalUsd).toLocaleString()})\n` +
      `• 注文ID: ${params.id}`;
    return await this.send(text, undefined, 'ORD_TP', params);
  }

  /**
   * DCA シグナル発火通知
   */
  async notifySignal(signal: TradeSignal): Promise<boolean> {
    const isLong = signal.side === 'LONG';
    const emoji = isLong ? '🟢' : '🔴';
    const actionJp = isLong ? '押し目買い (LONG)' : '急騰売り (SHORT)';
    const changeLabel = isLong ? '下落率' : '上昇率';
    const baseLabel = isLong ? '期間高値' : '期間安値';

    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${emoji} *[DCA Entry Signal]* ${signal.coin} ${actionJp} (${signal.timeframe})\n` +
      `• 現在価格: $${Number(signal.currentPx).toLocaleString()}\n` +
      `• ${baseLabel}: $${Number(signal.basePx).toLocaleString()}\n` +
      `• ${changeLabel}: *${signal.changePct.toFixed(2)}%* (閾値: ${signal.thresholdPct}%)\n` +
      `• 重複除外枠: ${Math.round(signal.windowMs / 3600000)}時間\n` +
      `• 検知時刻: ${formatJstLog()}`;

    return await this.send(text, undefined, 'INFO', { signal });
  }

  /**
   * 約定通知
   */
  async notifyFill(fill: OrderFillRecord): Promise<boolean> {
    const isBuy = fill.side === 'BUY';
    const emoji = isBuy ? '💎' : '💰';
    const text = `🤖 *ボット:* ${this.botName}\n` +
      `${emoji} *[約定完了]* ${fill.coin} ${fill.side}\n` +
      `• 約定価格: $${Number(fill.price).toLocaleString()}\n` +
      `• 数量: ${fill.size} ${fill.coin} ($${Number(fill.notionalUsd).toLocaleString()})\n` +
      `• 手数料: ${fill.fee}\n` +
      `• 約定時刻: ${formatJstLog()}`;

    return await this.send(text, undefined, fill.side, { ...fill });
  }

  /**
   * エラー通知
   */
  async notifyError(processName: string, error: unknown): Promise<boolean> {
    const errMsg = error instanceof Error ? error.message : String(error);
    const text = `🚨 *[dca-deno エラー]*\n• プロセス: ${processName}\n• 内容: ${errMsg}\n• 発生時刻: ${formatJstLog()}`;
    return await this.send(text, undefined, 'ERROR', {
      processName,
      errorMessage: errMsg,
    });
  }
}
