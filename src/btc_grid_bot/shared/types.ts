/**
 * btc-grid-deno: 型定義
 */

export type TpTimeframe = '24H' | '7D' | '30D' | '90D' | '180D' | '360D';

export interface GridConfig {
  coin: string;                 // 対象通貨銘柄 (既定値: 'BTC')
  apiUrl: string;               // Hyperliquid API URL
  isMainnet: boolean;           // メインネットフラグ (falseでテストネット)
  tzOffsetHours: number;        // タイムゾーンオフセット (時間, 既定値: 9 = JST)
  traceIdDisplayLength: number; // ログ表示用 traceId 桁数 (既定値: 4)
  lockTtlSec: number;           // 排他ロックTTL (秒, 既定値: 60)
  priceCacheTtlSec: number;     // 価格キャッシュ有効秒数 (既定値: 300)
  minPositionNotionalUsd: number; // TP判定対象とする最小ポジション額 (USD, 既定値: 1)

  gridStepUsd: number;          // 節目間隔 (例: 1000ドル)
  gridOffsetUsd: number;        // オフセット (例: 0ドル)
  gridOrderSizeUsd: number;     // 節目BuyLimit注文サイズ (例: 2000ドル)
  tpCloseSizeUsd: number;       // TP決済注文サイズ (例: 2000ドル)
  marketCloseSlippage: number;  // TP決済時のスリッページ許容率 (例: 0.005 = 0.5%)
  tpThreshold24h: number;       // 24H安値からの上昇率閾値 (%)
  tpThreshold7d: number;        // 7D安値からの上昇率閾値 (%)
  tpThreshold30d: number;       // 30D安値からの上昇率閾値 (%)
  tpThreshold90d: number;       // 90D安値からの上昇率閾値 (%)
  tpThreshold180d: number;      // 180D安値からの上昇率閾値 (%)
  tpThreshold360d: number;      // 360D安値からの上昇率閾値 (%)
  checkIntervalSec: number;     // 定期チェック間隔 (秒)
}

export interface PriceStats {
  markPrice: number;
  change24h: number;
  minPrice24h?: number;
  minPrice7d?: number;
  minPrice30d?: number;
  minPrice90d?: number;
  minPrice180d?: number;
  minPrice360d?: number;
  updatedAt: number;
}

export interface LivePositionState {
  coin: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPx: number;
}

export interface ActiveGridOrder {
  orderId?: number;
  cloid: string;
  limitPrice: number;
  size: number;
  side: 'LONG' | 'SHORT';
  timestamp: number;
}

export type GridAction = 'PLACE' | 'KEEP' | 'SKIP' | 'NONE';

export interface GridCheckResult {
  traceId: string;
  timestamp: string;
  durationMs: number;
  markPrice: number;
  gridAction: GridAction;
  gridLevel?: number;
  placedOrderId?: string;
  tpFiredTimeframes: TpTimeframe[];
  tpClosedUsd: number;
  error?: string;
}

export type TraceRecord = GridCheckResult;

export type OrderStatus = 'NEW' | 'OPEN' | 'CLOSED' | 'CANCEL' | 'CANCELLED' | 'FILLED' | 'REJECTED';

/**
 * 1. 新規節目グリッド発注テーブル レコード
 */
export interface GridOrderRecord {
  id: string; // cloid または orderId
  cloid: string;
  coin: string;
  level: number;
  price: number;
  size: number;
  filledSize?: number;
  notionalUsd: number;
  status: OrderStatus;
  closedAt?: string;
  closedByTpId?: string;
  source: 'btc-grid-bot' | 'external'; // 注文発行元を追跡
  createdAt: string;
  updatedAt: string;
}

/**
 * 2. TP（利確）発注テーブル レコード
 */
export interface TpOrderRecord {
  id: string; // cloid または orderId
  cloid: string;
  coin: string;
  timeframe: TpTimeframe;
  risePct: number;
  threshold: number;
  price: number;
  size: number;
  filledSize?: number;
  notionalUsd: number;
  status: OrderStatus;
  source: 'btc-grid-bot' | 'external'; // 注文発行元を追跡
  createdAt: string;
  updatedAt: string;
}

/**
 * 3. 約定オーダー (Fills) テーブル レコード
 */
export interface OrderFillRecord {
  fillId: string;
  orderId?: number;
  cloid?: string;
  coin: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  notionalUsd: number;
  fee: number;
  closedPnl: number;
  /** 受信時刻 (JST ISO文字列)。再送された約定では毎回変わるため、保存キーには使わない */
  timestamp: string;
  /** 取引所が報告した約定時刻 (epoch ms)。保存キーの冪等性を保つために使う */
  exchangeTime?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  count?: number;
  error?: string;
  timestamp?: number;
}

