/**
 * dca-deno: 定数および環境変数設定ローダー
 */

import type { DcaConfig, DcaTimeframe } from './types.ts';

export const APP_NAME = 'dca-deno';
export const DEFAULT_PORT = 8002;
export const DEFAULT_TARGET_COINS = ['ETH', 'ENA', 'NEAR', 'AAVE', 'HYPE', 'TRX', 'LINK'];
export const C_HY_API = 'https://api.hyperliquid.xyz';
export const C_HY_WS = 'wss://api.hyperliquid.xyz/ws';

/**
 * 過去期間重複防止ウィンドウ (ミリ秒)
 */
export const DCA_TIMEFRAME_WINDOW_MS: Record<DcaTimeframe, number> = {
  '24H': 24 * 60 * 60 * 1000,
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000,
  '90D': 90 * 24 * 60 * 60 * 1000,
  '180D': 180 * 24 * 60 * 60 * 1000,
  '360D': 360 * 24 * 60 * 60 * 1000,
};

/**
 * 4時間足本数換算
 */
export const TIMEFRAME_CANDLES_4H_COUNT: Record<DcaTimeframe, number> = {
  '24H': 6,       // 24 / 4
  '7D': 42,       // 7 * 6
  '30D': 180,     // 30 * 6
  '90D': 540,     // 90 * 6
  '180D': 1080,   // 180 * 6
  '360D': 2160,   // 360 * 6
};

// LONG 下落率デフォルト閾値 (%)
export const DEFAULT_DIP_THRESHOLD_24H = 16.18;
export const DEFAULT_DIP_THRESHOLD_7D = 26.18;
export const DEFAULT_DIP_THRESHOLD_30D = 36.18;
export const DEFAULT_DIP_THRESHOLD_90D = 46.18;
export const DEFAULT_DIP_THRESHOLD_180D = 56.18;
export const DEFAULT_DIP_THRESHOLD_360D = 66.18;
export const DEFAULT_ADDITIONAL_DIP_THRESHOLD_24H = 3.82;

// SHORT 急騰率デフォルト閾値 (%)
export const DEFAULT_SURGE_THRESHOLD_24H = 16.18;
export const DEFAULT_SURGE_THRESHOLD_7D = 38.2;
export const DEFAULT_SURGE_THRESHOLD_30D = 61.8;
export const DEFAULT_SURGE_THRESHOLD_90D = 100.0;
export const DEFAULT_SURGE_THRESHOLD_180D = 138.2;
export const DEFAULT_SURGE_THRESHOLD_360D = 161.8;
export const DEFAULT_ADDITIONAL_SURGE_THRESHOLD_24H = 3.82;

export function getSignalType(coin: string, timeframe: DcaTimeframe, side: 'LONG' | 'SHORT'): string {
  const upper = coin.toUpperCase();
  return side === 'LONG' ? `${upper}_ENTRY_${timeframe}` : `${upper}_SHORT_${timeframe}`;
}

function parseNum(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const num = Number(val);
  return Number.isFinite(num) ? num : defaultVal;
}

function parseBool(val: string | undefined, defaultVal: boolean): boolean {
  if (!val) return defaultVal;
  const lower = val.toLowerCase().trim();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  return defaultVal;
}

export function loadDcaConfig(): DcaConfig {
  const coinsEnv = Deno.env.get('TARGET_COINS');
  const targetCoins = coinsEnv
    ? coinsEnv.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_TARGET_COINS;

  return {
    targetCoins: targetCoins.length > 0 ? targetCoins : DEFAULT_TARGET_COINS,
    autoOrderEnabled: parseBool(Deno.env.get('AUTO_ORDER_ENABLED'), false),
    defaultOrderSizeUsd: parseNum(Deno.env.get('DEFAULT_ORDER_SIZE_USD'), 100),
    
    dipThreshold24h: parseNum(Deno.env.get('DIP_THRESHOLD_24H'), DEFAULT_DIP_THRESHOLD_24H),
    dipThreshold7d: parseNum(Deno.env.get('DIP_THRESHOLD_7D'), DEFAULT_DIP_THRESHOLD_7D),
    dipThreshold30d: parseNum(Deno.env.get('DIP_THRESHOLD_30D'), DEFAULT_DIP_THRESHOLD_30D),
    dipThreshold90d: parseNum(Deno.env.get('DIP_THRESHOLD_90D'), DEFAULT_DIP_THRESHOLD_90D),
    dipThreshold180d: parseNum(Deno.env.get('DIP_THRESHOLD_180D'), DEFAULT_DIP_THRESHOLD_180D),
    dipThreshold360d: parseNum(Deno.env.get('DIP_THRESHOLD_360D'), DEFAULT_DIP_THRESHOLD_360D),
    additionalDipThreshold24h: parseNum(Deno.env.get('ADDITIONAL_DIP_THRESHOLD_24H'), DEFAULT_ADDITIONAL_DIP_THRESHOLD_24H),

    surgeThreshold24h: parseNum(Deno.env.get('SURGE_THRESHOLD_24H'), DEFAULT_SURGE_THRESHOLD_24H),
    surgeThreshold7d: parseNum(Deno.env.get('SURGE_THRESHOLD_7D'), DEFAULT_SURGE_THRESHOLD_7D),
    surgeThreshold30d: parseNum(Deno.env.get('SURGE_THRESHOLD_30D'), DEFAULT_SURGE_THRESHOLD_30D),
    surgeThreshold90d: parseNum(Deno.env.get('SURGE_THRESHOLD_90D'), DEFAULT_SURGE_THRESHOLD_90D),
    surgeThreshold180d: parseNum(Deno.env.get('SURGE_THRESHOLD_180D'), DEFAULT_SURGE_THRESHOLD_180D),
    surgeThreshold360d: parseNum(Deno.env.get('SURGE_THRESHOLD_360D'), DEFAULT_SURGE_THRESHOLD_360D),
    additionalSurgeThreshold24h: parseNum(Deno.env.get('ADDITIONAL_SURGE_THRESHOLD_24H'), DEFAULT_ADDITIONAL_SURGE_THRESHOLD_24H),

    scanIntervalSec: parseNum(Deno.env.get('SCAN_INTERVAL_SEC'), 300),
    apiUrl: Deno.env.get('HY_API_URL') || C_HY_API,
    wsUrl: Deno.env.get('HY_WS_URL') || C_HY_WS,
    isMainnet: parseBool(Deno.env.get('HY_IS_MAINNET'), true),
    port: parseNum(Deno.env.get('PORT'), DEFAULT_PORT),
  };
}
