import type { RangeLabel } from "./price_range.ts";

/** シグナルの売買方向 (LONG = BUY 指値、SHORT = SELL 指値) */
export type SignalSide = "LONG" | "SHORT";

/** 登録するシグナル (D1 の signals テーブル 1 行分に対応) */
export interface TradeSignal {
  /** 銘柄シンボル (例: "BTC") */
  symbol: string;
  /** 売買方向 */
  side: SignalSide;
  /** 判定時の価格 */
  price: number;
  /** シグナル種別 (例: "ENTRY_24H") */
  signalType: string;
  /** 発行元ラベル */
  source: string;
  /** 注文サイズ (USD) */
  targetSize: number;
  /** 判定に使った下落率または上昇率 (%)。DCA シグナルは worker に合わせて未設定 (D1 では NULL) */
  changePct?: number;
  /** 判定時刻 (エポックミリ秒) */
  timestamp: number;
}

/** 期間ごとの閾値 (%) */
export type PeriodThresholds = Record<RangeLabel, number>;

/** シグナル判定の閾値設定 */
export interface SignalThresholds {
  /** BUY: 期間高値からの下落率の閾値 (以上で発火) */
  dip: PeriodThresholds;
  /** SELL: 期間安値からの上昇率の閾値 (超過で発火。24H のみ以上) */
  surge: PeriodThresholds;
  /** BUY の 24H 以外の期間判定に必須の、24H 高値からの最低下落率 (%) */
  additionalDip24h: number;
  /** SELL の 24H 以外の期間判定に必須の、24H 安値からの最低上昇率 (%) */
  additionalSurge24h: number;
}

/** 発行元ラベル (signals.source) */
export const SIGNAL_SOURCE = "hl-price-listener";

/** 期間別の注文サイズ (USD)。期間が長いほど大きくする */
export const TARGET_SIZE_BY_WINDOW_USD: Readonly<Record<RangeLabel, number>> = {
  "24H": 200,
  "7D": 240,
  "30D": 280,
  "90D": 320,
  "180D": 360,
  "360D": 400,
};

/** 既定の閾値 (buyer-worker / seller-worker の既定値と同じ) */
export const DEFAULT_SIGNAL_THRESHOLDS: Readonly<SignalThresholds> = {
  dip: { "24H": 38.2, "7D": 50, "30D": 61.8, "90D": 70, "180D": 80, "360D": 90 },
  surge: { "24H": 61.8, "7D": 161.8, "30D": 261.8, "90D": 361.8, "180D": 461.8, "360D": 561.8 },
  additionalDip24h: 3.82,
  additionalSurge24h: 3.82,
};

/** 期間ラベルからシグナル種別を作る (例: "7D" → "ENTRY_7D") */
export function signalTypeOf(label: RangeLabel): string {
  return `ENTRY_${label}`;
}
