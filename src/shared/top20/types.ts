/**
 * Top20 Volume Tracker: Core Types and Interfaces
 */

/**
 * Top coin snapshot item in the hourly aggregation
 */
export interface TopCoinInfo {
  rank: number;
  name: string;
  symbol: string;
  marketCap: number;
  volume24h: number;         // 過去24時間の取引量 (USD)
  price: number;
  change1hPercent?: number;  // 1時間 価格変動率 (%)
  change24hPercent?: number; // 24時間 価格変動率 (%)
  isUp?: boolean;
  isDown?: boolean;
}

/**
 * KV Database Record schema for hourly volume tracking
 */
export interface TrackerRecord {
  id: number;
  timestamp: number;         // Unix timestamp in milliseconds (aligned to hourly bucket)
  iso_time: string;          // Formatted ISO string (JST / UTC)
  total_volume_24h: number;  // 時価総額TOP20通貨の過去24時間取引量合計 (USD)
  average_volume_24h: number;// 時価総額TOP20通貨の過去24時間取引量平均 (USD)
  total_volume_1h?: number;  // 後方互換用エイリアス
  average_volume_1h?: number;// 後方互換用エイリアス
  top_count: number;         // 集計対象通貨数 (通常 20)
  up_count?: number;         // 1時間で上昇した通貨数
  down_count?: number;       // 1時間で下落した通貨数
  coins?: TopCoinInfo[];     // 各通貨の内訳スナップショット
}

/**
 * Input payload for inserting a new tracker record into KV
 */
export type NewTrackerRecord = Omit<TrackerRecord, 'id'>;

/**
 * Aggregation result returned by market data adapter
 */
export interface Top20Aggregation {
  timestamp: number;
  isoTime: string;
  totalVolume24h: number;
  averageVolume24h: number;
  topCount: number;
  upCount: number;
  downCount: number;
  coins: TopCoinInfo[];
}

/**
 * Generic API response format
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
  timestamp?: number;
}
