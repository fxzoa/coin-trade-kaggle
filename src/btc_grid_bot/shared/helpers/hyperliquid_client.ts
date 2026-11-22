/**
 * btc-grid-deno: Hyperliquid 取引所クライアント
 * Cloudflare 依存を完全に排除し、Web標準 fetch と Deno で動作するスタンドアロン実装
 */

import { logger } from '../logger.ts';
import { COIN, DEFAULT_HY_API } from '../constants.ts';
import type { LivePositionState, ActiveGridOrder, PriceStats } from '../types.ts';
import { type Result, ok, err } from '../result.ts';
import { ConfigError, HyperliquidApiError, OrderError, toError } from '../errors.ts';

/** 節目グリッドBuyLimit の発注仕様 (Redis トピックへ依頼する内容) */
export interface GridBuyOrderSpec {
  coin: string;
  level: number;
  limitPrice: number;
  size: number;
  notionalUsd: number;
  cloid: string;
}

/**
 * 発注パラメータの妥当性を検証する (Result 型)
 */
export function validateOrderPlacement(params: {
  price: number;
  size: number;
}): Result<true, OrderError> {
  if (!Number.isFinite(params.price) || params.price <= 0) {
    return err(new OrderError(`無効な指値価格または数量: price=${params.price}, size=${params.size}`));
  }
  if (!Number.isFinite(params.size) || params.size <= 0) {
    return err(new OrderError(`無効な指値価格または数量: price=${params.price}, size=${params.size}`));
  }
  return ok(true);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** 最安値の期間キー */
type PriceStatsWindow = '24H' | '7D' | '30D' | '90D' | '180D' | '360D';
/** 24H 最安値の集計期間 (1時間足で判定) */
const PRICE_STATS_24H_WINDOW_MS = DAY_MS;
/** 7D 以上の最安値の集計期間 (日足で判定) */
const PRICE_STATS_DAILY_WINDOWS: ReadonlyArray<readonly [PriceStatsWindow, number]> = [
  ['7D', 7 * DAY_MS],
  ['30D', 30 * DAY_MS],
  ['90D', 90 * DAY_MS],
  ['180D', 180 * DAY_MS],
  ['360D', 360 * DAY_MS],
];
/** 日足ローソク足の取得対象期間 (ms) */
const DAILY_CANDLE_LOOKBACK_MS = 365 * DAY_MS;

/** 足の期間 [startMs, startMs + intervalMs) と安値 */
interface CandleLow {
  startMs: number;
  intervalMs: number;
  low: number;
}

/**
 * USD 建て発注額と価格から、数量 (szDecimals 桁に丸め) と名目額 (USD、小数2桁) を算出する
 */
function computeOrderSize(
  sizeUsd: number,
  price: number,
  szDecimals: number
): { targetSize: number; notionalUsd: number } {
  const rawSz = price > 0 ? sizeUsd / price : 0;
  const factor = Math.pow(10, szDecimals);
  const targetSize = Math.round(rawSz * factor) / factor;
  const notionalUsd = Math.round(price * targetSize * 100) / 100;
  return { targetSize, notionalUsd };
}

/**
 * 128-bit 一意な Bot Cloid を生成する
 */
export function generateCloid(prefix: string = 'grid_'): string {
  let prefixHex = '';
  for (let i = 0; i < 4; i++) {
    const charCode = i < prefix.length ? prefix.charCodeAt(i) : 0;
    prefixHex += charCode.toString(16).padStart(2, '0');
  }
  const timeHex = (Date.now() % 0x1000000000000).toString(16).padStart(12, '0');
  const randomBytes = crypto.getRandomValues(new Uint8Array(6));
  const randomHex = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${prefixHex}${timeHex}${randomHex}`.toLowerCase();
}

/** Hyperliquid 無期限先物の価格小数桁の上限 (6 - szDecimals) */
const MAX_PERP_PRICE_DECIMALS = 6;
/** Hyperliquid の価格有効桁数の上限 (整数価格は対象外) */
const MAX_PRICE_SIG_FIGS = 5;

/**
 * 価格を取引所の刻み幅に丸める
 * - 小数桁は (6 - szDecimals) 桁まで
 * - 整数でない価格は有効数字5桁まで (整数価格は桁数制限なし)
 */
export function roundPriceToTickSize(rawPrice: number, szDecimals: number): number {
  if (rawPrice <= 0) return 0;
  const maxDecimals = Math.max(0, MAX_PERP_PRICE_DECIMALS - szDecimals);
  const decimalRounded = Number(rawPrice.toFixed(maxDecimals));
  if (Number.isInteger(decimalRounded)) return decimalRounded;
  // 有効数字5桁を超える整数部は、整数に丸めれば有効な価格になる
  if (decimalRounded >= Math.pow(10, MAX_PRICE_SIG_FIGS)) return Math.round(decimalRounded);
  return Number(decimalRounded.toPrecision(MAX_PRICE_SIG_FIGS));
}

export class HyperliquidClient {
  private readonly apiUrl: string;
  private readonly walletAddress: string;
  private readonly coin: string;
  private assetMetaCache?: { assetIndex: number; szDecimals: number };

  constructor(
    walletAddress: string,
    options?: string | { apiUrl?: string; coin?: string }
  ) {
    if (!walletAddress?.trim()) throw new ConfigError('walletAddress は必須です');
    this.walletAddress = walletAddress.trim();

    if (typeof options === 'string') {
      this.apiUrl = options.replace(/\/$/, '');
      this.coin = COIN;
    } else {
      this.apiUrl = (options?.apiUrl || DEFAULT_HY_API).replace(/\/$/, '');
      this.coin = (options?.coin || COIN).toUpperCase();
    }
  }

  /**
   * Info API をリトライ付きで呼び出す
   */
  async postInfo<T = unknown>(body: Record<string, unknown>, maxRetries = 3): Promise<T> {
    let lastError: Error | unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}/info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          // 全試行が 429 の場合に呼び出し側へ原因を伝えるため、最後のエラーとして保持する
          lastError = new HyperliquidApiError('HTTP 429: レート制限', { statusCode: 429 });
          await res.body?.cancel();
          const waitMs = attempt * 1000;
          logger.warn(`[HyperliquidClient] 429 レート制限検知。${waitMs}ms 待機してリトライします (${attempt}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (!res.ok) {
          const bodyText = await res.text();
          throw new HyperliquidApiError(`HTTP ${res.status}: ${bodyText}`, { statusCode: res.status });
        }

        return (await res.json()) as T;
      } catch (err: unknown) {
        lastError = toError(err);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, attempt * 500));
        }
      }
    }
    throw toError(lastError);
  }

  /**
   * BTCの最良気配値 (BBO) を取得
   */
  async getBbo(): Promise<{ bestBid: number; bestAsk: number }> {
    try {
      const data = await this.postInfo<{ levels?: [{ px: string }[], { px: string }[]] }>({
        type: 'l2Book',
        coin: this.coin,
      });
      const levels = data?.levels;
      if (!levels || levels.length < 2) return { bestBid: 0, bestAsk: Infinity };
      const bids = levels[0] || [];
      const asks = levels[1] || [];
      const bestBid = bids.length > 0 ? parseFloat(bids[0].px) : 0;
      const bestAsk = asks.length > 0 ? parseFloat(asks[0].px) : Infinity;
      return { bestBid, bestAsk };
    } catch (err: unknown) {
      logger.warn('[HyperliquidClient] BBO取得失敗:', toError(err));
      return { bestBid: 0, bestAsk: Infinity };
    }
  }

  /**
   * 対象通貨のメタデータ (assetIndex, szDecimals) を取得 (インメモリキャッシュあり)
   */
  async getAssetMeta(): Promise<{ assetIndex: number; szDecimals: number }> {
    if (this.assetMetaCache) return this.assetMetaCache;

    const data = await this.postInfo<{ universe?: { name: string; szDecimals: number }[] }>({
      type: 'meta',
    });

    const universe = data?.universe || [];
    const index = universe.findIndex((u) => u.name.toUpperCase() === this.coin);
    if (index === -1) {
      throw new HyperliquidApiError(`通貨 ${this.coin} のメタデータが universe に見つかりませんでした`);
    }

    this.assetMetaCache = {
      assetIndex: index,
      szDecimals: universe[index].szDecimals,
    };
    return this.assetMetaCache;
  }

  /**
   * 対象通貨の最新マーク価格および24H変化率を取得
   */
  async getMarkPriceAndChange(): Promise<{ markPrice: number; change24h: number } | null> {
    try {
      const data = await this.postInfo<[
        { universe: { name: string }[] },
        { markPx: string; prevDayPx: string }[]
      ]>({
        type: 'metaAndAssetCtxs',
      });

      if (!Array.isArray(data) || data.length < 2) return null;
      const universe = data[0]?.universe || [];
      const ctxs = data[1] || [];

      const btcIndex = universe.findIndex((u) => u.name.toUpperCase() === this.coin);
      if (btcIndex === -1 || !ctxs[btcIndex]) return null;

      const markPx = parseFloat(ctxs[btcIndex].markPx || '0');
      const prevDayPx = parseFloat(ctxs[btcIndex].prevDayPx || '0');
      const change24h = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;

      return { markPrice: markPx, change24h };
    } catch (err: unknown) {
      logger.warn('[HyperliquidClient] metaAndAssetCtxs 取得失敗:', toError(err));
      return null;
    }
  }

  /**
   * candleSnapshot API からローソク足を取得し、有効な安値のみを返す
   * 取得に失敗した場合は警告を出して空配列を返す (呼び出し側は現在価格でフォールバックする)
   */
  private async fetchCandleLows(interval: '1h' | '1d', intervalMs: number, startTime: number, endTime: number): Promise<CandleLow[]> {
    try {
      const candles = await this.postInfo<Array<{ t: number; l: string }>>({
        type: 'candleSnapshot',
        req: { coin: this.coin, interval, startTime, endTime },
      });
      if (!Array.isArray(candles)) return [];
      return candles
        .map((c) => ({ startMs: c.t, intervalMs, low: parseFloat(c.l) }))
        .filter((c) => c.low > 0);
    } catch (err: unknown) {
      logger.warn(`[HyperliquidClient] candleSnapshot(${interval}) 取得中に警告 (現在価格でフォールバック):`, toError(err));
      return [];
    }
  }

  /**
   * 24H/7D/30D/90D/180D/360D の過去最安値を計算する
   * - 24H: 1時間足のうち直近24時間と期間が重なるものの最安値
   * - 7D 以上: 日足のうち各期間と期間が重なるものの最安値
   * 足の一部だけが期間に掛かる場合も対象に含める (期間外の安値を含み得るため、やや低めに出る)
   */
  async fetchPriceStats(): Promise<PriceStats | null> {
    const current = await this.getMarkPriceAndChange();
    if (!current || current.markPrice <= 0) return null;

    const now = Date.now();
    const [hourly, daily] = await Promise.all([
      this.fetchCandleLows('1h', HOUR_MS, now - PRICE_STATS_24H_WINDOW_MS, now),
      this.fetchCandleLows('1d', DAY_MS, now - DAILY_CANDLE_LOOKBACK_MS, now),
    ]);

    // 期間ごとの最安値 (初期値は現在価格)
    const mins: Record<PriceStatsWindow, number> = {
      '24H': current.markPrice,
      '7D': current.markPrice,
      '30D': current.markPrice,
      '90D': current.markPrice,
      '180D': current.markPrice,
      '360D': current.markPrice,
    };
    const overlaps = (c: CandleLow, windowMs: number) => c.startMs + c.intervalMs > now - windowMs;

    for (const c of hourly) {
      if (overlaps(c, PRICE_STATS_24H_WINDOW_MS)) mins['24H'] = Math.min(mins['24H'], c.low);
    }
    for (const c of daily) {
      for (const [window, windowMs] of PRICE_STATS_DAILY_WINDOWS) {
        if (overlaps(c, windowMs)) mins[window] = Math.min(mins[window], c.low);
      }
    }

    return {
      markPrice: current.markPrice,
      change24h: current.change24h,
      minPrice24h: mins['24H'],
      minPrice7d: mins['7D'],
      minPrice30d: mins['30D'],
      minPrice90d: mins['90D'],
      minPrice180d: mins['180D'],
      minPrice360d: mins['360D'],
      updatedAt: now,
    };
  }

  /**
   * 取引所の出金可能残高（withdrawable）を取得
   */
  async getWithdrawable(): Promise<number> {
    try {
      const data = await this.postInfo<{ withdrawable?: string }>({
        type: 'clearinghouseState',
        user: this.walletAddress,
      });
      const val = parseFloat(data?.withdrawable || '0');
      return isNaN(val) ? 0 : val;
    } catch (err: unknown) {
      logger.warn('[HyperliquidClient] withdrawable 取得失敗:', toError(err));
      return 0;
    }
  }

  /**
   * 取引所の実際のBTC保有ポジションを取得
   */
  async getUserPositionsState(): Promise<Record<string, LivePositionState>> {
    try {
      const data = await this.postInfo<{ assetPositions?: Array<{ position?: { coin: string; szi: string; entryPx: string } }> }>({
        type: 'clearinghouseState',
        user: this.walletAddress,
      });

      const positions: Record<string, LivePositionState> = {};
      const rawPositions = data?.assetPositions || [];
      for (const ap of rawPositions) {
        const p = ap?.position;
        if (!p || !p.coin) continue;
        const szi = parseFloat(p.szi || '0');
        if (szi === 0) continue;
        const side: 'LONG' | 'SHORT' = szi > 0 ? 'LONG' : 'SHORT';
        const key = `${p.coin}_${side}`.toUpperCase();
        positions[key] = {
          coin: p.coin,
          side,
          size: Math.abs(szi),
          entryPx: parseFloat(p.entryPx || '0'),
        };
      }
      return positions;
    } catch (err: unknown) {
      logger.warn('[HyperliquidClient] clearinghouseState 取得失敗:', toError(err));
      return {};
    }
  }

  /**
   * 取引所に現在出ている未約定の指値注文一覧を取得
   * 取得失敗を「注文なし」と取り違えて重複発注しないよう、失敗時は例外を送出する
   */
  async getUserOpenOrders(): Promise<ActiveGridOrder[]> {
    const data = await this.postInfo<Array<{ coin: string; limitPx: string; sz: string; oid: number; cloid?: string; side: string; timestamp: number }>>({
      type: 'openOrders',
      user: this.walletAddress,
    });

    if (!Array.isArray(data)) {
      throw new HyperliquidApiError(`openOrders の応答形式が不正です: ${JSON.stringify(data)}`);
    }
    return data
      .filter((o) => o.coin.toUpperCase() === this.coin && o.side === 'B') // Buy指値
      .map((o) => ({
        orderId: o.oid,
        cloid: o.cloid || '',
        limitPrice: parseFloat(o.limitPx),
        size: parseFloat(o.sz),
        side: 'LONG',
        timestamp: o.timestamp,
      }));
  }

  /**
   * 節目グリッドBuyLimit (Post-Only Alo) の発注仕様を組み立てる (発注はしない)
   * 発注は Redis トピック経由で coin-trade-bot が実行する。
   */
  async prepareGridBuyOrder(
    level: number,
    sizeUsd: number
  ): Promise<{ ok: true; spec: GridBuyOrderSpec } | { ok: false; errorMessage: string }> {
    const [{ szDecimals }, bbo] = await Promise.all([this.getAssetMeta(), this.getBbo()]);

    // 指値は必ず節目レベルに置く (価格をずらすと既存注文の重複判定が効かなくなるため)
    const limitPrice = roundPriceToTickSize(level, szDecimals);
    const { targetSize, notionalUsd } = computeOrderSize(sizeUsd, limitPrice, szDecimals);

    const validation = validateOrderPlacement({ price: limitPrice, size: targetSize });
    if (!validation.ok) {
      return { ok: false, errorMessage: validation.error.message };
    }

    // Post-Only (Alo) は最良売気配以上で板を跨ぐと拒否されるため、事前に依頼を見送る
    if (limitPrice >= bbo.bestAsk) {
      return {
        ok: false,
        errorMessage: `節目価格(${limitPrice})が最良売気配(${bbo.bestAsk})以上のため Post-Only 発注を見送りました`,
      };
    }

    return {
      ok: true,
      spec: { coin: this.coin, level, limitPrice, size: targetSize, notionalUsd, cloid: generateCloid('grid_') },
    };
  }
}
