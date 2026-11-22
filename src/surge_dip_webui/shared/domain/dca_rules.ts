import { SIGNAL_SOURCE, type SignalSide, type TradeSignal } from "./trade_signal.ts";

/**
 * DCA (ナンピン) の定数。buyer-worker / seller-worker の constants.ts と同じ値
 * (worker 側に環境変数での上書きは無いため、本アプリでも定数のみ)
 */
export const DCA_TIER1_THRESHOLD_PCT = 40.0;
export const DCA_TIER2_THRESHOLD_PCT = 80.0;
/** 追加注文サイズ = 発火時点の既存ポジション残高 × この倍率 */
export const DCA_SIZE_MULTIPLIER = 2;
/** Tier1 発動上限: ポジション残高 (USD) がこれ以下のときのみ */
export const DCA_TIER1_MAX_POSITION_USD = 700;
/** Tier2 発動上限: ポジション残高 (USD) がこれ以下のときのみ */
export const DCA_TIER2_MAX_POSITION_USD = 1200;
export const SIGNAL_TYPE_DCA_40 = "DCA_40";
export const SIGNAL_TYPE_DCA_80 = "DCA_80";

/** D1 positions テーブルの OPEN ポジション 1 行 (DCA 判定に使う列のみ) */
export interface OpenPosition {
  /** 銘柄シンボル (例: "SOL") */
  coin: string;
  /** 売買方向 (LONG = 買い持ち、SHORT = 売り持ち) */
  side: SignalSide;
  /** エントリー価格 */
  entryPx: number;
  /** ポジション残高 (USD)。D1 が NULL の場合は 0 とみなす (worker と同じ) */
  positionValue: number;
}

/** DCA シグナル登録前に D1 から集める既存件数 */
export interface DcaExistingCounts {
  /** 同一 coin・side・signal_type の NEW シグナル件数 */
  signalNewCount: number;
  /** 同一 coin・side の NEW 注文件数 */
  orderNewCount: number;
}

/** 発火段階 (Tier1 → Tier2 の順に評価し、両方成立し得る) */
const TIERS = [
  {
    signalType: SIGNAL_TYPE_DCA_40,
    thresholdPct: DCA_TIER1_THRESHOLD_PCT,
    maxPositionUsd: DCA_TIER1_MAX_POSITION_USD,
  },
  {
    signalType: SIGNAL_TYPE_DCA_80,
    thresholdPct: DCA_TIER2_THRESHOLD_PCT,
    maxPositionUsd: DCA_TIER2_MAX_POSITION_USD,
  },
] as const;

/**
 * エントリー価格に対する逆行率 (%)。LONG は下落、SHORT は上昇が逆行。
 * 負値は含み益側 (逆行していない) を表す
 */
export function adverseDeviationPct(side: SignalSide, entryPx: number, markPx: number): number {
  return side === "LONG"
    ? ((entryPx - markPx) / entryPx) * 100
    : ((markPx - entryPx) / entryPx) * 100;
}

/**
 * 1 ポジションと現在価格から DCA シグナルを判定する純粋関数 (worker の evaluateDcaSignals と同じ判定)。
 * Tier1 (DCA_40: 逆行率 40% 以上かつ残高 700 USD 以下) と Tier2 (DCA_80: 80% 以上かつ 1200 USD 以下)
 * は独立に評価し、両方成立すれば 2 件返す。追加サイズは残高 × 2。
 * 期間統計・タイムウィンドウ等の通常シグナルの条件は適用しない。
 * エントリー価格または現在価格が 0 以下の場合は空配列。
 * シグナルの変動率 (changePct) は worker に合わせて設定しない (D1 では NULL)
 *
 * @param position OPEN ポジション
 * @param markPx 現在価格 (allMids の中間価格)
 * @param timestamp 判定時刻 (エポックミリ秒)
 */
export function evaluateDcaSignals(
  position: OpenPosition,
  markPx: number,
  timestamp: number,
): TradeSignal[] {
  if (!position.coin || position.entryPx <= 0 || !(markPx > 0)) return [];
  const deviationPct = adverseDeviationPct(position.side, position.entryPx, markPx);
  return TIERS
    .filter((t) => deviationPct >= t.thresholdPct && position.positionValue <= t.maxPositionUsd)
    .map((t) => ({
      symbol: position.coin,
      side: position.side,
      price: markPx,
      signalType: t.signalType,
      source: SIGNAL_SOURCE,
      targetSize: position.positionValue * DCA_SIZE_MULTIPLIER,
      timestamp,
    }));
}
