const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 集計期間の定義 (キャッシュのキーと期間の長さ) */
export const RANGE_WINDOWS = [
  { label: "24H", ms: 24 * HOUR_MS },
  { label: "7D", ms: 7 * DAY_MS },
  { label: "30D", ms: 30 * DAY_MS },
  { label: "90D", ms: 90 * DAY_MS },
  { label: "180D", ms: 180 * DAY_MS },
  { label: "360D", ms: 360 * DAY_MS },
] as const;

/** 集計期間のラベル */
export type RangeLabel = typeof RANGE_WINDOWS[number]["label"];

/** ある期間の最高値・最低値 */
export interface PriceRange {
  high: number;
  low: number;
}

/** 1銘柄の期間別レンジ (その期間に足が無ければ null) */
export type SymbolRanges = Record<RangeLabel, PriceRange | null>;
