/**
 * multi-dca-bot: DCA シグナル純粋評価モジュール
 */

import {
  DCA_TIMEFRAME_WINDOW_MS,
  getSignalType,
} from '../../shared/constants.ts';
import type {
  DcaTimeframe,
  TradeSide,
  PriceStatsRecord,
  TradeSignal,
  DcaConfig,
} from '../../shared/types.ts';
import { getJstIsoString } from '../../shared/helpers/time_helper.ts';
import { ok, err, type Result } from '../../shared/result.ts';

export interface DcaCandidateEvaluation {
  timeframe: DcaTimeframe;
  side: TradeSide;
  signalType: string;
  changePct: number;    // 下落率または上昇率 (%)
  thresholdPct: number;
  basePx: number;       // 基準価格 (LONG: 高値, SHORT: 最低値)
  currentPx: number;
  windowMs: number;
  signal: TradeSignal;
}

export interface PeriodRule {
  timeframe: DcaTimeframe;
  side: TradeSide;
  label: string;
  statMaxKey: keyof PriceStatsRecord;
  statMinKey: keyof PriceStatsRecord;
  getLongThreshold: (cfg: DcaConfig) => number;
  getShortThreshold: (cfg: DcaConfig) => number;
}

export const PERIOD_RULES: readonly PeriodRule[] = [
  {
    timeframe: '360D',
    side: 'LONG',
    label: '360D',
    statMaxKey: 'maxPrice360d',
    statMinKey: 'minPrice360d',
    getLongThreshold: (cfg) => cfg.dipThreshold360d,
    getShortThreshold: (cfg) => cfg.surgeThreshold360d,
  },
  {
    timeframe: '180D',
    side: 'LONG',
    label: '180D',
    statMaxKey: 'maxPrice180d',
    statMinKey: 'minPrice180d',
    getLongThreshold: (cfg) => cfg.dipThreshold180d,
    getShortThreshold: (cfg) => cfg.surgeThreshold180d,
  },
  {
    timeframe: '90D',
    side: 'LONG',
    label: '90D',
    statMaxKey: 'maxPrice90d',
    statMinKey: 'minPrice90d',
    getLongThreshold: (cfg) => cfg.dipThreshold90d,
    getShortThreshold: (cfg) => cfg.surgeThreshold90d,
  },
  {
    timeframe: '30D',
    side: 'LONG',
    label: '30D',
    statMaxKey: 'maxPrice30d',
    statMinKey: 'minPrice30d',
    getLongThreshold: (cfg) => cfg.dipThreshold30d,
    getShortThreshold: (cfg) => cfg.surgeThreshold30d,
  },
  {
    timeframe: '7D',
    side: 'LONG',
    label: '7D',
    statMaxKey: 'maxPrice7d',
    statMinKey: 'minPrice7d',
    getLongThreshold: (cfg) => cfg.dipThreshold7d,
    getShortThreshold: (cfg) => cfg.surgeThreshold7d,
  },
  {
    timeframe: '24H',
    side: 'LONG',
    label: '24H',
    statMaxKey: 'maxPrice24h',
    statMinKey: 'minPrice24h',
    getLongThreshold: (cfg) => cfg.dipThreshold24h,
    getShortThreshold: (cfg) => cfg.surgeThreshold24h,
  },
];

/**
 * 個別期間ルールに対する DCA LONG シグナル適格性を評価する (Result 型判定)
 */
export function evaluatePeriodDcaCandidate(
  rule: PeriodRule,
  upperCoin: string,
  currentPx: number,
  stats: PriceStatsRecord,
  config: DcaConfig,
  dip24hPct: number | null
): Result<DcaCandidateEvaluation, string> {
  const maxPx = Number(stats[rule.statMaxKey]);
  if (!maxPx || maxPx <= 0) {
    return err(`${rule.timeframe} の有効な高値統計が存在しません`);
  }

  // 24H 以外の期間は、過去 24H で少なくとも additionalDipThreshold24h (%) 下落していることが追加条件
  if (rule.timeframe !== '24H') {
    if (dip24hPct === null || dip24hPct < config.additionalDipThreshold24h) {
      return err(`24H 下落率 (${dip24hPct?.toFixed(2)}%) が追加下落閾値 (${config.additionalDipThreshold24h}%) 未満です`);
    }
  }

  const dipPct = ((maxPx - currentPx) / maxPx) * 100;
  const threshold = rule.getLongThreshold(config);

  if (dipPct >= threshold) {
    const signalType = getSignalType(upperCoin, rule.timeframe, 'LONG');
    const nowIso = getJstIsoString();
    const id = `sig_${Date.now()}_${upperCoin}_LONG_${rule.timeframe}`;

    const signal: TradeSignal = {
      id,
      coin: upperCoin,
      side: 'LONG',
      timeframe: rule.timeframe,
      signalType,
      basePx: maxPx,
      currentPx,
      changePct: Math.round(dipPct * 100) / 100,
      thresholdPct: threshold,
      windowMs: DCA_TIMEFRAME_WINDOW_MS[rule.timeframe],
      status: 'NEW',
      createdAt: nowIso,
    };

    return ok({
      timeframe: rule.timeframe,
      side: 'LONG',
      signalType,
      changePct: dipPct,
      thresholdPct: threshold,
      basePx: maxPx,
      currentPx,
      windowMs: DCA_TIMEFRAME_WINDOW_MS[rule.timeframe],
      signal,
    });
  }

  return err(`下落率 ${dipPct.toFixed(2)}% は閾値 ${threshold}% 未満です`);
}

/**
 * 個別期間ルールに対する DCA SHORT シグナル適格性を評価する (Result 型判定)
 */
export function evaluatePeriodShortCandidate(
  rule: PeriodRule,
  upperCoin: string,
  currentPx: number,
  stats: PriceStatsRecord,
  config: DcaConfig,
  surge24hPct: number | null
): Result<DcaCandidateEvaluation, string> {
  const minPx = Number(stats[rule.statMinKey]);
  if (!minPx || minPx <= 0) {
    return err(`${rule.timeframe} の有効な安値統計が存在しません`);
  }

  // 24H 以外の期間は、過去 24H で少なくとも additionalSurgeThreshold24h (%) 上昇していることが追加条件
  if (rule.timeframe !== '24H') {
    if (surge24hPct === null || surge24hPct < config.additionalSurgeThreshold24h) {
      return err(`24H 上昇率 (${surge24hPct?.toFixed(2)}%) が追加上昇閾値 (${config.additionalSurgeThreshold24h}%) 未満です`);
    }
  }

  const surgePct = ((currentPx - minPx) / minPx) * 100;
  const threshold = rule.getShortThreshold(config);

  if (surgePct >= threshold) {
    const signalType = getSignalType(upperCoin, rule.timeframe, 'SHORT');
    const nowIso = getJstIsoString();
    const id = `sig_${Date.now()}_${upperCoin}_SHORT_${rule.timeframe}`;

    const signal: TradeSignal = {
      id,
      coin: upperCoin,
      side: 'SHORT',
      timeframe: rule.timeframe,
      signalType,
      basePx: minPx,
      currentPx,
      changePct: Math.round(surgePct * 100) / 100,
      thresholdPct: threshold,
      windowMs: DCA_TIMEFRAME_WINDOW_MS[rule.timeframe],
      status: 'NEW',
      createdAt: nowIso,
    };

    return ok({
      timeframe: rule.timeframe,
      side: 'SHORT',
      signalType,
      changePct: surgePct,
      thresholdPct: threshold,
      basePx: minPx,
      currentPx,
      windowMs: DCA_TIMEFRAME_WINDOW_MS[rule.timeframe],
      signal,
    });
  }

  return err(`上昇率 ${surgePct.toFixed(2)}% は閾値 ${threshold}% 未満です`);
}

/**
 * 対象通貨の現在価格と期間統計からエントリーシグナル候補を評価する
 * - LONG: 高値からの下落率 (dipPct) が閾値以上
 * - SHORT: 最低値からの上昇率 (surgePct) が閾値以上
 * - 長期 (360D) から順に評価
 */
export function evaluateDcaCandidates(
  coin: string,
  currentPx: number,
  stats: PriceStatsRecord,
  config: DcaConfig
): DcaCandidateEvaluation[] {
  const candidates: DcaCandidateEvaluation[] = [];
  const upperCoin = coin.toUpperCase();

  if (currentPx <= 0) return candidates;

  // 直近 24H の高値・安値からの変化率 (24H以外の期間判定における追加必須条件)
  const maxPrice24h = Number(stats.maxPrice24h);
  const minPrice24h = Number(stats.minPrice24h);
  const dip24hPct = maxPrice24h > 0 ? ((maxPrice24h - currentPx) / maxPrice24h) * 100 : null;
  const surge24hPct = minPrice24h > 0 ? ((currentPx - minPrice24h) / minPrice24h) * 100 : null;

  // 1. LONG 判定 (高値からの下落)
  for (const rule of PERIOD_RULES) {
    const res = evaluatePeriodDcaCandidate(rule, upperCoin, currentPx, stats, config, dip24hPct);
    if (res.ok) {
      candidates.push(res.value);
      // 同方向は最も長期の 1 件のみ採用 (360D -> 24H の順で最初に合致したもの)
      break;
    }
  }

  // 2. SHORT 判定 (最低値からの急騰)
  for (const rule of PERIOD_RULES) {
    const res = evaluatePeriodShortCandidate(rule, upperCoin, currentPx, stats, config, surge24hPct);
    if (res.ok) {
      candidates.push(res.value);
      // 同方向は最も長期の 1 件のみ採用
      break;
    }
  }

  return candidates;
}
