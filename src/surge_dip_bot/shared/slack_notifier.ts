/**
 * Slack 通知クライアント: 取引ライフサイクル通知 (NEW ORDER, OPEN POSITION, CLOSE POSITION) およびエラー通知
 */

import { Redis } from "ioredis";

type SlackQueuePublisher = (message: {
  type: SlackMessageType;
  worker: string;
  timestamp: number;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

const QUEUE_KEY = Deno.env.get("REDIS_QUEUE_KEY") ??
  Deno.env.get("SLACK_QUEUE_KEY") ?? "slack:alert:queue";
const REDIS_URL = Deno.env.get("REDIS_URL") ?? "redis://127.0.0.1:6379";

async function enqueueSlackMessage(
  message: Parameters<SlackQueuePublisher>[0],
): Promise<boolean> {
  const redis = new Redis(REDIS_URL, {
    connectTimeout: 1_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => attempt === 1 ? 200 : null,
  });
  redis.on("error", () => {});

  try {
    await redis.lpush(QUEUE_KEY, JSON.stringify(message));
    return true;
  } catch (error) {
    console.warn("[SlackNotifier] Could not enqueue Slack message:", error);
    return false;
  } finally {
    redis.disconnect();
  }
}

export interface SlackNotifierOptions {
  webhookUrl?: string;
  fetchFn?: typeof fetch;
  botName?: string;
  queuePublisher?: SlackQueuePublisher;
}

type SlackMessageType =
  | "ORD_OPEN"
  | "ORD_TP"
  | "BUY"
  | "SELL"
  | "CLOSE_PLUS"
  | "CLOSE_MINUS"
  | "ERROR"
  | "INFO"
  | "TEXT";

export interface NewOrderNotificationParams {
  coin: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  notionalUsd: number;
  orderType: string;
  id: string;
}

export interface PositionOpenedNotificationParams {
  coin: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  notionalUsd: number;
  id: string;
}

export interface PositionClosedNotificationParams {
  coin: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnlUsd?: number;
  pnlPct?: number;
  id: string;
  reason?: string;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function formatJstNow(): string {
  const d = new Date(Date.now() + JST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${
    pad(d.getUTCHours())
  }:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} JST`;
}

export class SlackNotifier {
  private readonly webhookUrl?: string;
  private readonly fetchFn: typeof fetch;
  private readonly botName: string;
  private readonly disabled: boolean;
  private readonly queuePublisher: SlackQueuePublisher;

  constructor(options?: SlackNotifierOptions) {
    this.webhookUrl = options?.webhookUrl;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.botName = options?.botName ?? "Surge DIP Trader";
    this.disabled = options?.webhookUrl === "";
    this.queuePublisher = options?.queuePublisher ?? enqueueSlackMessage;
  }

  /**
   * 1. NEW ORDER: 新規指値発注時の通知
   */
  async notifyNewOrder(params: {
    coin: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    notionalUsd: number;
    orderType: string;
    id: string;
  }): Promise<boolean> {
    if (this.disabled) {
      console.debug("[SlackNotifier] Notifications are disabled.");
      return false;
    }

    const sideEmoji = params.side === "BUY" ? "🟢" : "🔴";
    const sideLabel = params.side === "BUY" ? "買い (BUY)" : "売り (SELL)";
    const text = [
      `🤖 *ボット:* ${this.botName}`,
      `🆕 *[新規発注 / NEW ORDER]* ${sideEmoji} *${sideLabel}* \`${params.coin}\``,
      `• *価格:* $${
        params.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
      }`,
      `• *数量:* ${params.size} ${params.coin}`,
      `• *約定代金:* $${params.notionalUsd.toFixed(2)}`,
      `• *注文種別:* ${params.orderType}`,
      `• *注文ID:* \`${params.id}\``,
      `• *時刻:* ${formatJstNow()}`,
    ].join("\n");

    return await this.postMessage({ text }, "ORD_OPEN");
  }

  /**
   * 2. OPEN POSITION: 約定によるポジション成立時の通知
   */
  async notifyPositionOpened(params: {
    coin: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    notionalUsd: number;
    id: string;
  }): Promise<boolean> {
    if (this.disabled) {
      console.debug("[SlackNotifier] Notifications are disabled.");
      return false;
    }

    const sideEmoji = params.side === "BUY" ? "🟢" : "🔴";
    const sideLabel = params.side === "BUY" ? "買い (BUY)" : "売り (SELL)";
    const text = [
      `🤖 *ボット:* ${this.botName}`,
      `🚀 *[建玉オープン / OPEN POSITION]* ${sideEmoji} *${sideLabel}* \`${params.coin}\``,
      `• *建値:* $${
        params.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
      }`,
      `• *数量:* ${params.size} ${params.coin}`,
      `• *約定代金:* $${params.notionalUsd.toFixed(2)}`,
      `• *注文ID:* \`${params.id}\``,
      `• *時刻:* ${formatJstNow()}`,
    ].join("\n");

    return await this.postMessage({ text }, params.side);
  }

  /**
   * 3. CLOSE POSITION: ポジション決済(利確等)時の通知
   */
  async notifyPositionClosed(params: {
    coin: string;
    side: "BUY" | "SELL";
    entryPrice: number;
    exitPrice: number;
    size: number;
    pnlUsd?: number;
    pnlPct?: number;
    id: string;
    reason?: string;
  }): Promise<boolean> {
    if (this.disabled) {
      console.debug("[SlackNotifier] Notifications are disabled.");
      return false;
    }

    const sideEmoji = params.side === "BUY" ? "🟢" : "🔴";
    const sideLabel = params.side === "BUY" ? "買い (BUY)" : "売り (SELL)";
    const pnlUsd = params.pnlUsd ?? 0;
    const pnlPct = params.pnlPct ?? 0;
    const isProfit = pnlUsd >= 0;
    const pnlEmoji = isProfit ? "💰" : "🔻";
    const pnlFormattedUsd = isProfit
      ? `+$${pnlUsd.toFixed(1)}`
      : `-$${Math.abs(pnlUsd).toFixed(1)}`;
    const pnlFormattedPct = isProfit ? `+${pnlPct.toFixed(1)}%` : `${pnlPct.toFixed(1)}%`;

    const pnlString = params.pnlUsd !== undefined
      ? `${pnlEmoji} ${pnlFormattedUsd} (${pnlFormattedPct})`
      : "N/A";

    const lines = [
      `🤖 *ボット:* ${this.botName}`,
      `🏁 *[決済完了 / CLOSE POSITION]* ${sideEmoji} *${sideLabel}* \`${params.coin}\``,
      `• *建値:* $${
        params.entryPrice.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      }`,
      `• *決済価格:* $${
        params.exitPrice.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 6,
        })
      }`,
      `• *数量:* ${params.size} ${params.coin}`,
      `• *実現損益:* ${pnlString}`,
      `• *注文ID:* \`${params.id}\``,
    ];

    if (params.reason) {
      lines.push(`• *決済理由:* ${params.reason}`);
    }
    lines.push(`• *時刻:* ${formatJstNow()}`);

    const type: SlackMessageType = params.pnlUsd === undefined
      ? "INFO"
      : params.pnlUsd >= 0
      ? "CLOSE_PLUS"
      : "CLOSE_MINUS";
    return await this.postMessage({ text: lines.join("\n") }, type);
  }

  /**
   * エラー発生時の通知
   */
  async notifyError(process: string, err: unknown): Promise<boolean> {
    if (this.disabled) {
      console.debug("[SlackNotifier] Notifications are disabled.");
      return false;
    }

    const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);
    const text = [
      `🤖 *ボット:* ${this.botName}`,
      `🚨 *[エラー発生 / ERROR]* in \`${process}\``,
      "```",
      errMsg.slice(0, 1500),
      "```",
      `• *発生時刻:* ${formatJstNow()}`,
    ].join("\n");

    return await this.postMessage({ text }, "ERROR");
  }

  private async postMessage(
    payload: Record<string, unknown>,
    type: SlackMessageType,
  ): Promise<boolean> {
    if (this.disabled) return false;
    if (!this.webhookUrl) {
      return await this.queuePublisher({
        type,
        worker: this.botName,
        timestamp: Date.now(),
        payload,
      });
    }

    try {
      const res = await this.fetchFn(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, type }),
      });

      if (!res.ok) {
        console.warn(`[SlackNotifier] Webhook response not ok: ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      console.warn(`[SlackNotifier] Webhook request error:`, e);
      return false;
    }
  }
}
