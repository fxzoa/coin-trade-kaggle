/**
 * close-trader-webui: データ型定義
 */

export interface CloseRecord {
  id: string;
  timestamp: string;
  timestampMs: number;
  coin: string;
  side: "LONG" | "SHORT";
  closeAction: "BUY" | "SELL";
  size: number;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  profitPct: number;
  thresholdPct: number;
  source: "EVENT" | "POLL" | "MANUAL";
  cloid?: string;
  reason?: string;
}

export interface CloseHistoryFilter {
  coin?: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}

export interface CloseStats {
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRatePct: number;
  totalPnlUsd: number;
  avgProfitPct: number;
  avgPnlUsd: number;
  lastCloseTime: string | null;
}

export type OrderSide = "BUY" | "SELL";
export type OrderStatus = "resting" | "filled" | "rejected" | "error" | "dry_run" | "skipped";

export interface OrderRecord {
  id: string;
  requestId: string;
  timestamp: string;
  timestampMs: number;
  source: string;
  botId: string;
  coin: string;
  side: OrderSide;
  status: OrderStatus;
  price: number;
  size: number;
  notionalUsd: number;
  cloid?: string;
  oid?: number;
  filledSize?: number;
  avgPx?: number;
  error?: string;
}

export interface OrderHistoryFilter {
  coin?: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}

export interface OrderStats {
  totalOrders: number;
  filledOrders: number;
  restingOrders: number;
  failedOrders: number;
  dryRunOrders: number;
  totalNotionalUsd: number;
  lastOrderTime: string | null;
}

export interface WebUiConfig {
  port: number;
  redisUrl: string;
  redisOrderResultChannel: string;
  redisOrderHistoryKey: string;
  redisCloseChannel: string;
  redisCloseHistoryKey: string;
  logLevel: string;
}
