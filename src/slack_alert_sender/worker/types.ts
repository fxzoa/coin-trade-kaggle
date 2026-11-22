/**
 * ドメインエンティティおよび型定義
 */

export interface SendTextMessageRequest {
  text: string;
  channel?: string;
  worker?: string;
  traceId?: string;
  traceparent?: string;
}

export interface SendErrorAlertRequest {
  errorMessage: string;
  context?: string;
  coin?: string;
  stackTrace?: string;
  channel?: string;
  worker?: string;
  traceId?: string;
  traceparent?: string;
  apiTimestamp?: string | number;
}

export interface SendInfoAlertRequest {
  message: string;
  context?: string;
  channel?: string;
  worker?: string;
  traceId?: string;
  traceparent?: string;
  apiTimestamp?: string | number;
}

export interface SendOrderOpenAlertRequest {
  coin: string;
  action: "LONG" | "SHORT";
  signalType: string; // 例: 'SurgeShort_24H', 'DipLong_7D', 'DCA_1'
  markPrice: number;
  targetSize: number;
  notionalUsd: number;
  triggerReason?: string;
  priceChangeFromP0Pct?: number; // DCA時のP0乖離率
  mode?: string;
  worker?: string;
  channel?: string;
  traceId?: string;
  traceparent?: string;
  apiTimestamp?: string | number;
}

export interface SendClosePositionAlertRequest {
  coin: string;
  side: "LONG" | "SHORT";
  size: number;
  avgEntryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  profitPct: number;
  reason?: string;
  mode?: string;
  worker?: string;
  channel?: string;
  traceId?: string;
  traceparent?: string;
  apiTimestamp?: string | number;
}

export interface SendOrderCanceledAlertRequest {
  coin: string;
  signalType: string;
  cloid: string;
  reason: string;
  mode?: string;
  worker?: string;
  channel?: string;
  traceId?: string;
  traceparent?: string;
  apiTimestamp?: string | number;
}

export interface SendFillEventAlertRequest {
  coin: string;
  side: "BUY" | "SELL" | "B" | "A";
  px: number;
  sz: number;
  notionalUsd?: number;
  fee?: number;
  tid?: string | number;
  cloid?: string;
  dir?: string; // 例: 'Open Long', 'Close Short'
  closedPnl?: number; // 決済時の確定損益
  mode?: string;
  worker?: string;
  channel?: string;
  traceId?: string;
  traceparent?: string;
  apiTimestamp?: string | number;
}

export type AlertNotificationType =
  | "TEXT"
  | "ERROR"
  | "INFO"
  | "ORD_OPEN"
  | "ORD_TP"
  | "BUY"
  | "SELL"
  | "CLOSE_PLUS"
  | "CLOSE_MINUS"
  | "ORDER_OPEN"
  | "ORDER_CANCELED"
  | "CLOSE_POSITION"
  | "FILL";

export interface BaseQueueMessage {
  id?: string;
  worker?: string;
  traceId?: string;
  traceparent?: string;
  timestamp?: number;
}

export type SlackQueueMessage =
  & BaseQueueMessage
  & (
    | { type: "TEXT"; payload: SendTextMessageRequest }
    | { type: "ERROR"; payload: SendErrorAlertRequest }
    | { type: "INFO"; payload: SendInfoAlertRequest }
    | {
      type:
        | "ORD_OPEN"
        | "ORD_TP"
        | "BUY"
        | "SELL"
        | "CLOSE_PLUS"
        | "CLOSE_MINUS";
      payload: Record<string, unknown> & { text?: string; channel?: string };
    }
    | { type: "ORDER_OPEN"; payload: SendOrderOpenAlertRequest }
    | { type: "ORDER_CANCELED"; payload: SendOrderCanceledAlertRequest }
    | { type: "CLOSE_POSITION"; payload: SendClosePositionAlertRequest }
    | { type: "FILL"; payload: SendFillEventAlertRequest }
    | { type: string; payload: Record<string, unknown> }
  );

export interface NotificationResult {
  ok: boolean;
  channel: string;
  error?: string;
  ts?: string;
  /** 送信を試みた本文 (履歴保存用) */
  text?: string;
}

export interface ChannelConfig {
  channelNotify?: string;
  channelError?: string;
  channelBuy?: string;
  channelSell?: string;
  channelClosePlus?: string;
  channelCloseMinus?: string;
  channelOrdOpen?: string;
  channelOrdTp?: string;
}

export interface AppConfig {
  slackBotToken: string;
  notificationsEnabled: boolean;
  redisUrl: string;
  redisQueueKey: string;
  channels: ChannelConfig;
  historyDbPath: string;
  historyRetentionDays: number;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
}
