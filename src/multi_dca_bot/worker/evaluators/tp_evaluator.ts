/**
 * multi-dca-bot: 期間別TP(利確)評価モジュール (純粋関数)
 *
 * 責務: 過去期間 (24H/7D/30D/90D/180D/360D) の安値からの価格上昇率を評価し、
 *       各期間ごとに独立して閾値到達を判定する。
 *
 * 上昇率 = (markPx - minPx) / minPx * 100
 */

import type { PriceStatsRecord, TpTimeframe } from '../../shared/types.ts';
import { ok, err, type Result } from '../../shared/result.ts';

export interface TpCandidate {
  timeframe: TpTimeframe;
  risePct: number;
  threshold: number;
  minPx: number;
}

export interface TpRule {
  timeframe: TpTimeframe;
  getMinPx: (stats: PriceStatsRecord) => number | undefined;
  defaultThreshold: number;
  envKey: string;
}

export const TP_RULES: readonly TpRule[] = [
  { timeframe: '24H', getMinPx: (s) => s.minPrice24h, defaultThreshold: 6.18, envKey: 'TP_THRESHOLD_24H' },
  { timeframe: '7D', getMinPx: (s) => s.minPrice7d, defaultThreshold: 16.18, envKey: 'TP_THRESHOLD_7D' },
  { timeframe: '30D', getMinPx: (s) => s.minPrice30d, defaultThreshold: 26.18, envKey: 'TP_THRESHOLD_30D' },
  { timeframe: '90D', getMinPx: (s) => s.minPrice90d, defaultThreshold: 36.18, envKey: 'TP_THRESHOLD_90D' },
  { timeframe: '180D', getMinPx: (s) => s.minPrice180d, defaultThreshold: 46.18, envKey: 'TP_THRESHOLD_180D' },
  { timeframe: '360D', getMinPx: (s) => s.minPrice360d, defaultThreshold: 56.18, envKey: 'TP_THRESHOLD_360D' },
];

export const TP_TIMEFRAME_WINDOW_MS: Record<TpTimeframe, number> = {
  '24H': 24 * 60 * 60 * 1000,
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000,
  '90D': 90 * 24 * 60 * 60 * 1000,
  '180D': 180 * 24 * 60 * 60 * 1000,
  '360D': 360 * 24 * 60 * 60 * 1000,
};

/**
 * 個別期間ルールに対するTP適格性を評価する (Result 型判定)
 */
export function evaluateTpRule(
  rule: TpRule,
  markPx: number,
  stats: PriceStatsRecord
): Result<TpCandidate, string> {
  if (!markPx || markPx <= 0) {
    return err('無効なマーク価格です');
  }

  const minPx = rule.getMinPx(stats);
  if (!minPx || minPx <= 0) {
    return err(`${rule.timeframe} の有効な安値統計が存在しません`);
  }

  const envVal = Deno.env.get(rule.envKey);
  const threshold = envVal ? parseFloat(envVal) : rule.defaultThreshold;
  const risePct = ((markPx - minPx) / minPx) * 100;

  if (risePct >= threshold) {
    return ok({ timeframe: rule.timeframe, risePct, threshold, minPx });
  }

  return err(`上昇率 ${risePct.toFixed(2)}% は閾値 ${threshold}% 未満です`);
}

/**
 * 期間安値からの上昇率が閾値を超えている期間をすべて抽出する
 */
export function evaluateTpCandidates(
  markPx: number,
  stats: PriceStatsRecord
): TpCandidate[] {
  const candidates: TpCandidate[] = [];
  if (!markPx || markPx <= 0) return candidates;

  for (const rule of TP_RULES) {
    const decision = evaluateTpRule(rule, markPx, stats);
    if (decision.ok) {
      candidates.push(decision.value);
    }
  }

  return candidates;
}
