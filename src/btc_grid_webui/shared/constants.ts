/**
 * btc-grid-deno: 定数および設定リゾルバ
 */

import type { GridConfig, TpTimeframe } from './types.ts';

export const APP_NAME = 'btc-grid-deno';
export const COIN = 'BTC';
export const DEFAULT_HY_API = 'https://api.hyperliquid.xyz';

export const TP_TIMEFRAMES: readonly TpTimeframe[] = ['24H', '7D', '30D', '90D', '180D', '360D'];

export const TP_TIMEFRAME_WINDOW_MS: Record<TpTimeframe, number> = {
  '24H': 24 * 60 * 60 * 1000,
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000,
  '90D': 90 * 24 * 60 * 60 * 1000,
  '180D': 180 * 24 * 60 * 60 * 1000,
  '360D': 360 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_GRID_CONFIG: GridConfig = {
  coin: 'BTC',
  apiUrl: DEFAULT_HY_API,
  isMainnet: true,
  tzOffsetHours: 9, // JST (UTC+9)
  traceIdDisplayLength: 4,
  lockTtlSec: 60,
  priceCacheTtlSec: 300,
  minPositionNotionalUsd: 1,

  gridStepUsd: 1000,
  gridOffsetUsd: 0,
  gridOrderSizeUsd: 2000,
  tpCloseSizeUsd: 2000,
  marketCloseSlippage: 0.005,
  tpThreshold24h: 6.18,
  tpThreshold7d: 16.18,
  tpThreshold30d: 26.18,
  tpThreshold90d: 36.18,
  tpThreshold180d: 46.18,
  tpThreshold360d: 56.18,
  checkIntervalSec: 300, // 5分
};

/**
 * 環境変数から設定をロードし、デフォルト値とマージする
 */
export function loadGridConfig(): GridConfig {
  return {
    coin: (Deno.env.get('COIN') || DEFAULT_GRID_CONFIG.coin).toUpperCase(),
    apiUrl: Deno.env.get('HY_API_URL') || DEFAULT_GRID_CONFIG.apiUrl,
    isMainnet: parseBool(Deno.env.get('HY_IS_MAINNET'), DEFAULT_GRID_CONFIG.isMainnet),
    tzOffsetHours: parseNum(Deno.env.get('TZ_OFFSET_HOURS'), DEFAULT_GRID_CONFIG.tzOffsetHours),
    traceIdDisplayLength: parseNum(Deno.env.get('TRACE_ID_DISPLAY_LENGTH'), DEFAULT_GRID_CONFIG.traceIdDisplayLength),
    lockTtlSec: parseNum(Deno.env.get('LOCK_TTL_SEC'), DEFAULT_GRID_CONFIG.lockTtlSec),
    priceCacheTtlSec: parseNum(Deno.env.get('PRICE_CACHE_TTL_SEC'), DEFAULT_GRID_CONFIG.priceCacheTtlSec),
    minPositionNotionalUsd: parseNum(Deno.env.get('MIN_POSITION_NOTIONAL_USD'), DEFAULT_GRID_CONFIG.minPositionNotionalUsd),

    gridStepUsd: parseNum(Deno.env.get('GRID_STEP_USD'), DEFAULT_GRID_CONFIG.gridStepUsd),
    gridOffsetUsd: parseNum(Deno.env.get('GRID_OFFSET_USD'), DEFAULT_GRID_CONFIG.gridOffsetUsd),
    gridOrderSizeUsd: parseNum(Deno.env.get('GRID_ORDER_SIZE_USD'), DEFAULT_GRID_CONFIG.gridOrderSizeUsd),
    tpCloseSizeUsd: parseNum(Deno.env.get('TP_CLOSE_SIZE_USD'), DEFAULT_GRID_CONFIG.tpCloseSizeUsd),
    marketCloseSlippage: parseNum(Deno.env.get('MARKET_CLOSE_SLIPPAGE'), DEFAULT_GRID_CONFIG.marketCloseSlippage),
    tpThreshold24h: parseNum(Deno.env.get('TP_THRESHOLD_24H'), DEFAULT_GRID_CONFIG.tpThreshold24h),
    tpThreshold7d: parseNum(Deno.env.get('TP_THRESHOLD_7D'), DEFAULT_GRID_CONFIG.tpThreshold7d),
    tpThreshold30d: parseNum(Deno.env.get('TP_THRESHOLD_30D'), DEFAULT_GRID_CONFIG.tpThreshold30d),
    tpThreshold90d: parseNum(Deno.env.get('TP_THRESHOLD_90D'), DEFAULT_GRID_CONFIG.tpThreshold90d),
    tpThreshold180d: parseNum(Deno.env.get('TP_THRESHOLD_180D'), DEFAULT_GRID_CONFIG.tpThreshold180d),
    tpThreshold360d: parseNum(Deno.env.get('TP_THRESHOLD_360D'), DEFAULT_GRID_CONFIG.tpThreshold360d),
    checkIntervalSec: parseNum(Deno.env.get('CHECK_INTERVAL_SEC'), DEFAULT_GRID_CONFIG.checkIntervalSec),
  };
}

function parseNum(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : defaultVal;
}

function parseBool(val: string | undefined, defaultVal: boolean): boolean {
  if (val === undefined || val === null || val === '') return defaultVal;
  const lower = val.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return defaultVal;
}
