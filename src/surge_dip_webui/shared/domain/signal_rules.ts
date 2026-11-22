import { type PriceRange, RANGE_WINDOWS, type RangeLabel } from "./price_range.ts";
import {
  SIGNAL_SOURCE,
  type SignalSide,
  type SignalThresholds,
  signalTypeOf,
  TARGET_SIZE_BY_WINDOW_USD,
  type TradeSignal,
} from "./trade_signal.ts";
import { err, ok, type Result } from "../result.ts";
import { SignalError } from "../errors.ts";

/** 期間ラベルからレンジを引く関数 (未集計なら null) */
export type RangeLookup = (label: RangeLabel) => PriceRange | null;

/** 判定の入力 (1 銘柄の最新価格) */
export interface SignalInput {
  symbol: string;
  price: number;
  timestamp: number;
}

/** 高値からの下落率 (%)。高値が有効でなければ null */
export function calcDropPct(high: number, price: number): number | null {
  if (!(high > 0)) return null;
  return ((high - price) / high) * 100;
}

/** 安値からの上昇率 (%)。安値が有効でなければ null */
export function calcRisePct(low: number, price: number): number | null {
  if (!(low > 0)) return null;
  return ((price - low) / low) * 100;
}

/** シグナルを組み立てる */
function buildSignal(
  input: SignalInput,
  side: SignalSide,
  label: RangeLabel,
  changePct: number,
): TradeSignal {
  return {
    symbol: input.symbol,
    side,
    price: input.price,
    signalType: signalTypeOf(label),
    source: SIGNAL_SOURCE,
    targetSize: TARGET_SIZE_BY_WINDOW_USD[label],
    changePct,
    timestamp: input.timestamp,
  };
}

/**
 * 方向ごとの差異を表す判定仕様。
 * measure は期間レンジから変動率を求め、fires は閾値を超えたかを判定する
 */
interface SideRule {
  side: SignalSide;
  measure: (range: PriceRange, price: number) => number | null;
  thresholds: (t: SignalThresholds) => Record<RangeLabel, number>;
  additional24h: (t: SignalThresholds) => number;
  /** 24H は常に以上、期間判定は方向により以上 / 超過 */
  fires: (label: RangeLabel, pct: number, threshold: number) => boolean;
}

const BUY_RULE: SideRule = {
  side: "LONG",
  measure: (range, price) => calcDropPct(range.high, price),
  thresholds: (t) => t.dip,
  additional24h: (t) => t.additionalDip24h,
  fires: (_label, pct, threshold) => pct >= threshold,
};

const SELL_RULE: SideRule = {
  side: "SHORT",
  measure: (range, price) => calcRisePct(range.low, price),
  thresholds: (t) => t.surge,
  additional24h: (t) => t.additionalSurge24h,
  fires: (label, pct, threshold) => (label === "24H" ? pct >= threshold : pct > threshold),
};

/**
 * 24H を最優先、次に 7D → 360D の順に評価し、最初に一致したシグナルを返す。
 * 24H のレンジが無い・無効な場合は、追加条件を判定できないため何も返さない
 */
function evaluateSide(
  rule: SideRule,
  input: SignalInput,
  ranges: RangeLookup,
  thresholds: SignalThresholds,
): TradeSignal | null {
  const range24h = ranges("24H");
  if (!range24h) return null;
  const pct24h = rule.measure(range24h, input.price);
  if (pct24h === null) return null;

  const limits = rule.thresholds(thresholds);
  if (rule.fires("24H", pct24h, limits["24H"])) {
    return buildSignal(input, rule.side, "24H", pct24h);
  }
  // 24H 以外の期間は、24H でも一定以上動いていることが必須条件
  if (pct24h < rule.additional24h(thresholds)) return null;

  for (const { label } of RANGE_WINDOWS) {
    if (label === "24H") continue;
    const range = ranges(label);
    const pct = range ? rule.measure(range, input.price) : null;
    if (pct !== null && rule.fires(label, pct, limits[label])) {
      return buildSignal(input, rule.side, label, pct);
    }
  }
  return null;
}

/** BUY (LONG) シグナルを判定する。期間高値からの下落率が閾値以上で発火 */
export function evaluateBuySignal(
  input: SignalInput,
  ranges: RangeLookup,
  thresholds: SignalThresholds,
): TradeSignal | null {
  return evaluateSide(BUY_RULE, input, ranges, thresholds);
}

/** SELL (SHORT) シグナルを判定する。24H は上昇率が閾値以上、期間は閾値を超過で発火 */
export function evaluateSellSignal(
  input: SignalInput,
  ranges: RangeLookup,
  thresholds: SignalThresholds,
): TradeSignal | null {
  return evaluateSide(SELL_RULE, input, ranges, thresholds);
}

/**
 * Result-based signal criteria check for BUY or SELL.
 */
export function checkSignalCriteria(
  rule: "BUY" | "SELL",
  input: SignalInput,
  ranges: RangeLookup,
  thresholds: SignalThresholds,
): Result<TradeSignal | null, SignalError> {
  if (!input.symbol || typeof input.price !== "number" || !Number.isFinite(input.price) || input.price <= 0) {
    return err(new SignalError(`Invalid SignalInput: symbol=${input.symbol}, price=${input.price}`));
  }
  const signal = rule === "BUY"
    ? evaluateBuySignal(input, ranges, thresholds)
    : evaluateSellSignal(input, ranges, thresholds);
  return ok(signal);
}

