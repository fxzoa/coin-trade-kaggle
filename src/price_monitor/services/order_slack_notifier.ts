/**
 * Order Slack Notifier
 *
 * Routes orderUpdates and userFills events to dedicated Slack channels
 * based on order status, side, and realized PnL.
 *
 * Channel routing:
 *  - status: "open"      → SLACK_CHANNEL_ORD_OPEN  + BUY/SELL
 *  - status: "triggered" → SLACK_CHANNEL_ORD_TP
 *  - status: "filled"    → BUY/SELL
 *  - status: "canceled" / "rejected" / "marginCanceled" → SLACK_CHANNEL_NOTIFY
 *  - userFills.closedPnl > 0  → SLACK_CHANNEL_CLOSE_PLUS
 *  - userFills.closedPnl <= 0 → SLACK_CHANNEL_CLOSE_MINUS
 */

import { Redis } from "ioredis";
import type { HlOrderUpdate, HlUserFill } from "../../shared/price_monitor/types.ts";

// ---------------------------------------------------------------------------
// Channel config
// ---------------------------------------------------------------------------

export interface OrderSlackChannels {
  notify: string;
  error: string;
  buy: string;
  sell: string;
  closePlus: string;
  closeMinus: string;
  ordOpen: string;
  ordTp: string;
}

export interface OrderSlackNotifierOptions {
  redisUrl: string;
  queueKey: string;
  channels: OrderSlackChannels;
  onLog?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// JST formatter
// ---------------------------------------------------------------------------

function formatJst(epochMs: number): string {
  const jst = new Date(epochMs + 9 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${
    pad(jst.getUTCHours())
  }:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())} JST`;
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function sideLabel(side: "B" | "A"): string {
  return side === "B" ? "🟢 BUY" : "🔴 SELL";
}

const SERVICE_NAME = "price-change-monitor";

/** 全メッセージ共通のサービス名ヘッダー */
function serviceHeader(): string {
  return `*サービス:* \`${SERVICE_NAME}\``;
}

function buildOrderUpdateMessage(update: HlOrderUpdate): string {
  const { order, status, statusTimestamp } = update;
  const { coin, side, limitPx, sz, oid } = order;

  const statusEmoji: Record<string, string> = {
    open: "📂",
    filled: "✅",
    triggered: "🎯",
    canceled: "❌",
    rejected: "🚫",
    marginCanceled: "⚠️",
  };

  const lines = [
    serviceHeader(),
    `${statusEmoji[status] ?? "📋"} *[Order ${status.toUpperCase()}]*`,
    `*コイン:* \`${coin}\`  |  *売買:* ${sideLabel(side)}`,
    `*価格:* $${Number(limitPx).toLocaleString(undefined, { maximumFractionDigits: 6 })}`,
    `*数量:* ${sz}`,
    `*注文ID:* \`${oid}\``,
    `*時刻:* ${formatJst(statusTimestamp)}`,
  ];

  return lines.join("\n");
}

function buildUserFillMessage(fill: HlUserFill): string {
  const { coin, side, px, sz, closedPnl, fee, time } = fill;
  const pnl = Number(closedPnl);
  const pnlStr = pnl >= 0
    ? `+$${pnl.toFixed(1)} :large_green_circle:`
    : `-$${Math.abs(pnl).toFixed(1)} 🔴`;

  const lines = [
    serviceHeader(),
    `💰 *[Fill / Closed Position]*`,
    `*コイン:* \`${coin}\`  |  *売買:* ${sideLabel(side)}`,
    `*約定価格:* $${Number(px).toLocaleString(undefined, { maximumFractionDigits: 6 })}`,
    `*数量:* ${sz}`,
    `*実現損益:* ${pnlStr}`,
    `*手数料:* $${Number(fee).toFixed(1)}`,
    `*時刻:* ${formatJst(time)}`,
    `---`,
    serviceHeader(),
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Channel router
// ---------------------------------------------------------------------------

function routeOrderUpdate(
  update: HlOrderUpdate,
  channels: OrderSlackChannels,
): string[] {
  const { status, order: { side } } = update;
  const targets: string[] = [];

  switch (status) {
    case "open":
      targets.push(channels.ordOpen);
      targets.push(side === "B" ? channels.buy : channels.sell);
      break;

    case "triggered":
      targets.push(channels.ordTp);
      break;

    case "filled":
      targets.push(side === "B" ? channels.buy : channels.sell);
      break;

    case "canceled":
    case "rejected":
    case "marginCanceled":
      targets.push(channels.notify);
      break;

    default:
      targets.push(channels.notify);
  }

  // Deduplicate (in case buy/sell == notify)
  return [...new Set(targets)];
}

function routeUserFill(
  fill: HlUserFill,
  channels: OrderSlackChannels,
): string[] {
  const pnl = Number(fill.closedPnl);
  const targets: string[] = [];

  // Only route fills that actually closed a position (closedPnl != 0 or dir contains "Close")
  const isClose = pnl !== 0 || (fill.dir?.toLowerCase().includes("close") ?? false);
  if (isClose) {
    targets.push(pnl > 0 ? channels.closePlus : channels.closeMinus);
  }

  return [...new Set(targets)];
}

// ---------------------------------------------------------------------------
// Notifier class
// ---------------------------------------------------------------------------

export class OrderSlackNotifier {
  private redis: Redis;
  private queueKey: string;
  private channels: OrderSlackChannels;
  private onLog: (msg: string) => void;

  constructor(opts: OrderSlackNotifierOptions) {
    this.queueKey = opts.queueKey;
    this.channels = opts.channels;
    this.onLog = opts.onLog ?? console.log;

    this.redis = new Redis(opts.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    });
    this.redis.on("error", (err: Error) => {
      this.onLog(`[OrderSlackNotifier] Redis error: ${err.message}`);
    });
  }

  /**
   * Push a text message to the Slack queue for a specific channel.
   */
  private async pushToQueue(channelId: string, text: string): Promise<void> {
    const payload = JSON.stringify({
      type: "TEXT",
      worker: "price-change-monitor",
      timestamp: Date.now(),
      payload: { channel: channelId, text },
    });
    await this.redis.lpush(this.queueKey, payload);
  }

  /**
   * Notify Slack when an orderUpdate event is received.
   */
  public async notifyOrderUpdate(update: HlOrderUpdate): Promise<void> {
    const targets = routeOrderUpdate(update, this.channels);
    const text = buildOrderUpdateMessage(update);

    for (const channelId of targets) {
      try {
        await this.pushToQueue(channelId, text);
        this.onLog(
          `[OrderSlackNotifier] orderUpdate → ${channelId} (${update.status} ${update.order.coin})`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onLog(`[OrderSlackNotifier] Failed to push to ${channelId}: ${msg}`);
      }
    }
  }

  /**
   * Notify Slack when a userFill event is received (closed position PnL routing).
   */
  public async notifyUserFill(fill: HlUserFill): Promise<void> {
    const targets = routeUserFill(fill, this.channels);
    if (targets.length === 0) return; // Open fills (no closedPnl) skipped

    const text = buildUserFillMessage(fill);

    for (const channelId of targets) {
      try {
        await this.pushToQueue(channelId, text);
        this.onLog(
          `[OrderSlackNotifier] userFill → ${channelId} (pnl=${fill.closedPnl} ${fill.coin})`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onLog(`[OrderSlackNotifier] Failed to push to ${channelId}: ${msg}`);
      }
    }
  }

  /**
   * Gracefully close the internal Redis connection.
   */
  public async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // ignore
    }
  }
}
