/**
 * チャンネル解決ロジック
 * 優先順位: 明示指定 (req.channel) > 環境変数 (config) > デフォルト定数 (DEFAULT_CHANNELS)
 */

import { DEFAULT_CHANNELS } from "../constants.ts";
import type {
  ChannelConfig,
  SendClosePositionAlertRequest,
  SendFillEventAlertRequest,
} from "../types.ts";

export function resolveChannel(
  explicitChannel: string | undefined,
  configChannel: string | undefined,
  defaultChannel: string,
): string {
  if (explicitChannel && explicitChannel.trim().length > 0) {
    return explicitChannel.trim();
  }
  if (configChannel && configChannel.trim().length > 0) {
    return configChannel.trim();
  }
  return defaultChannel;
}

/**
 * 1. TEXT: channelNotify -> DEFAULT_CHANNELS.NOTIFY
 */
export function resolveTextChannel(
  explicitChannel: string | undefined,
  config: ChannelConfig,
): string {
  return resolveChannel(
    explicitChannel,
    config.channelNotify,
    DEFAULT_CHANNELS.NOTIFY,
  );
}

/**
 * 2. ERROR: channelError -> DEFAULT_CHANNELS.ERROR
 */
export function resolveErrorChannel(
  explicitChannel: string | undefined,
  config: ChannelConfig,
): string {
  return resolveChannel(
    explicitChannel,
    config.channelError,
    DEFAULT_CHANNELS.ERROR,
  );
}

/**
 * 3. INFO: channelNotify -> DEFAULT_CHANNELS.NOTIFY
 */
export function resolveInfoChannel(
  explicitChannel: string | undefined,
  config: ChannelConfig,
): string {
  return resolveChannel(
    explicitChannel,
    config.channelNotify,
    DEFAULT_CHANNELS.NOTIFY,
  );
}

/**
 * 4. ORDER_OPEN: channelOrdOpen -> DEFAULT_CHANNELS.ORD_OPEN
 */
export function resolveOrderOpenChannel(
  explicitChannel: string | undefined,
  config: ChannelConfig,
): string {
  return resolveChannel(
    explicitChannel,
    config.channelOrdOpen,
    DEFAULT_CHANNELS.ORD_OPEN,
  );
}

/**
 * 5. ORDER_CANCELED (TP注文): channelOrdTp -> DEFAULT_CHANNELS.ORD_TP
 */
export function resolveOrderCanceledChannel(
  explicitChannel: string | undefined,
  config: ChannelConfig,
): string {
  return resolveChannel(
    explicitChannel,
    config.channelOrdTp,
    DEFAULT_CHANNELS.ORD_TP,
  );
}

/**
 * 6. CLOSE_POSITION:
 * req.pnlUsd >= 0: channelClosePlus -> DEFAULT_CHANNELS.CLOSE_PLUS
 * req.pnlUsd < 0:  channelCloseMinus -> DEFAULT_CHANNELS.CLOSE_MINUS
 */
export function resolveClosePositionChannel(
  req: SendClosePositionAlertRequest,
  config: ChannelConfig,
): string {
  const isProfit = req.pnlUsd >= 0;
  const defaultChan = isProfit
    ? DEFAULT_CHANNELS.CLOSE_PLUS
    : DEFAULT_CHANNELS.CLOSE_MINUS;
  const configChan = isProfit
    ? config.channelClosePlus
    : config.channelCloseMinus;
  return resolveChannel(req.channel, configChan, defaultChan);
}

/**
 * 7. FILL (約定):
 * クローズ約定:
 *   closedPnl >= 0 -> channelClosePlus / DEFAULT_CHANNELS.CLOSE_PLUS
 *   closedPnl < 0  -> channelCloseMinus / DEFAULT_CHANNELS.CLOSE_MINUS
 * 新規約定:
 *   side === 'BUY' or 'B' -> channelBuy / DEFAULT_CHANNELS.BUY
 *   それ以外 (SELL)       -> channelSell / DEFAULT_CHANNELS.SELL
 */
export function resolveFillChannel(
  req: SendFillEventAlertRequest,
  config: ChannelConfig,
): string {
  const isClose = (req.dir && req.dir.includes("Close")) ||
    req.closedPnl !== undefined;

  if (isClose) {
    const closedPnl = req.closedPnl ?? 0;
    const isProfit = closedPnl >= 0;
    const defaultChan = isProfit
      ? DEFAULT_CHANNELS.CLOSE_PLUS
      : DEFAULT_CHANNELS.CLOSE_MINUS;
    const configChan = isProfit
      ? config.channelClosePlus
      : config.channelCloseMinus;
    return resolveChannel(req.channel, configChan, defaultChan);
  }

  const rawSide = String(req?.side || "BUY").trim().toUpperCase();
  const isBuy = rawSide === "B" || rawSide === "BUY";
  const defaultChan = isBuy ? DEFAULT_CHANNELS.BUY : DEFAULT_CHANNELS.SELL;
  const configChan = isBuy ? config.channelBuy : config.channelSell;
  return resolveChannel(req?.channel, configChan, defaultChan);
}
