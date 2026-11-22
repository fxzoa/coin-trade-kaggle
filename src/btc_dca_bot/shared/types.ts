/**
 * dca-deno: 型定義
 */

export type TradeSide = 'LONG' | 'SHORT';

export type DcaTimeframe = '24H' | '7D' | '30D' | '90D' | '180D' | '360D';

/**
 * 4時間足ローソク足 (KLINE) キャッシュモデル
 */
export interface Kline4h {
  coin: string;
  t: number;  // 開始時間 (ミリ秒UNIX)
  T: number;  // 終了時間 (ミリ秒UNIX)
  o: number;  // 始値
  h: number;  // 高値
  l: number;  // 安値
  c: number;  // 終値
  v: number;  // 出来高
  n?: number; // 取引回数
  isClosed: boolean; // 確定足か否か
}

/**
 * 通貨別 期間価格統計モデル
 */
export interface PriceStatsRecord {
  coin: string;
  updatedAt: string;
  currentPrice: number;
  
  // 期間最高値 (LONG: 高値からの下落率判定用)
  maxPrice24h: number;
  maxPrice7d: number;
  maxPrice30d: number;
  maxPrice90d: number;
  maxPrice180d: number;
  maxPrice360d: number;

  // 期間最安値 (SHORT: 安値からの急騰率判定用)
  minPrice24h: number;
  minPrice7d: number;
  minPrice30d: number;
  minPrice90d: number;
  minPrice180d: number;
  minPrice360d: number;

  // 直近 24H 変化率 (%)
  change24hPct?: number;
}

/**
 * 検出された DCA エントリーシグナル
 */
export interface TradeSignal {
  id: string; // sig_YYYYMMDD_HHmmss_xxx
  coin: string;
  side: TradeSide;
  timeframe: DcaTimeframe;
  signalType: string;
  basePx: number;      // 基準価格 (LONG: 高値, SHORT: 最低値)
  currentPx: number;   // 判定時現在価格
  changePct: number;   // 乖離率 (%)
  thresholdPct: number;// 発火閾値 (%)
  windowMs: number;    // 重複除外期間 (ms)
  status: 'NEW' | 'EXECUTED' | 'DISMISSED';
  createdAt: string;   // JST ISO
  executedAt?: string;
  orderId?: number;
  cloid?: string;
  error?: string;
  unexecutedReason?: string;
}

export type OrderStatus = 'NEW' | 'OPEN' | 'CLOSED' | 'CANCEL' | 'CANCELLED' | 'FILLED' | 'REJECTED';
export type TpTimeframe = '24H' | '7D' | '30D' | '90D' | '180D' | '360D';

/**
 * 注文記録
 */
export interface OrderRecord {
  id: string;
  cloid: string;
  oid?: number;
  signalId?: string;
  coin: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  filledSize?: number;
  notionalUsd: number;
  status: OrderStatus;
  closedAt?: string;
  closedByTpId?: string;
  source: 'btc-dca-bot' | 'external'; // 注文発行元を追跡
  createdAt: string;
  updatedAt: string;
}

/**
 * TP（利確）発注テーブル レコード
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
  createdAt: string;
  updatedAt: string;
}

/**
 * 約定履歴
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
  timestamp: string;
}

/**
 * DCA設定
 */
export interface DcaConfig {
  targetCoins: string[];
  autoOrderEnabled: boolean;
  defaultOrderSizeUsd: number;
  
  // LONG 下落閾値 (%)
  dipThreshold24h: number;
  dipThreshold7d: number;
  dipThreshold30d: number;
  dipThreshold90d: number;
  dipThreshold180d: number;
  dipThreshold360d: number;
  additionalDipThreshold24h: number;

  // SHORT 上昇閾値 (%)
  surgeThreshold24h: number;
  surgeThreshold7d: number;
  surgeThreshold30d: number;
  surgeThreshold90d: number;
  surgeThreshold180d: number;
  surgeThreshold360d: number;
  additionalSurgeThreshold24h: number;

  scanIntervalSec: number;
  apiUrl: string;
  wsUrl: string;
  isMainnet: boolean;
  port: number;
}
