/**
 * dca-deno: 4時間足ローソク足キャッシュ & 期間別MIN/MAX計算サービス
 * - 4H KLINE をローカル Deno KV (SQLite) にキャッシュ
 * - 新しい 4H 足が確定するたびにキャッシュを更新し、各期間の MIN/MAX を自動再計算
 * - リアルタイム価格が確定足の MIN/MAX を超えた場合、次の 4H 足確定までメモリ内 MIN/MAX を動的に更新
 */

import { logger } from '../../shared/logger.ts';
import type { DcaKvStore } from '../../shared/helpers/kv_store.ts';
import type { HyperliquidClient } from '../adapters/hyperliquid_client.ts';
import type { Kline4h, PriceStatsRecord } from '../../shared/types.ts';
import { TIMEFRAME_CANDLES_4H_COUNT } from '../../shared/constants.ts';
import { getJstIsoString } from '../../shared/helpers/time_helper.ts';
import { toError } from '../../shared/errors.ts';

export class KlineService {
  private readonly store: DcaKvStore;
  private readonly client: HyperliquidClient;
  // 各通貨の直近処理済み 4H 足の開始タイムスタンプ
  private lastCandleOpenTimes = new Map<string, number>();
  // メモリ内の最新 MIN/MAX 統計 (リアルタイム価格ブレイクアウト追従用)
  private memoryStats = new Map<string, PriceStatsRecord>();

  constructor(store: DcaKvStore, client: HyperliquidClient) {
    this.store = store;
    this.client = client;
  }

  /**
   * メモリに保持された最新の統計情報を取得
   */
  getLatestStats(coin: string): PriceStatsRecord | undefined {
    return this.memoryStats.get(coin.toUpperCase());
  }

  /**
   * 通貨の 4H KLINE キャッシュ初期化
   * 初回起動時に過去360日分を取得・保存し、初期 MIN/MAX 統計を計算
   */
  async initCurrencyCache(coin: string): Promise<PriceStatsRecord> {
    const upper = coin.toUpperCase();
    const existing = await this.store.getRecentKlines(upper, 2160);

    if (existing.length < 500) {
      logger.info(`[KlineService] ${upper}: ローカル 4H KLINE キャッシュ不足 (${existing.length}本)。REST API から過去360日分を取得中...`);
      try {
        const fetched = await this.client.getCandleSnapshot(upper, '4h');
        if (fetched.length > 0) {
          await this.store.saveKlinesBatch(fetched);
          logger.info(`[KlineService] ${upper}: 4H KLINE ${fetched.length}本をキャッシュに保存完了`);
        }
      } catch (err: unknown) {
        logger.error(`[KlineService] ${upper}: 4H KLINE 取得エラー:`, toError(err));
      }
    } else {
      logger.info(`[KlineService] ${upper}: キャッシュ済み 4H KLINE ${existing.length}本を利用`);
    }

    // 期間別 MIN/MAX 統計を計算してメモリ & KV に保存
    return await this.recalculateMinMax(upper);
  }

  /**
   * WebSocket 経由で受信した 4H candle の処理
   * 新しい 4H 足が確定したタイミングでキャッシュ更新 & MIN/MAX 再計算を実行
   */
  async handleWsCandle(rawCandle: any): Promise<{ isNewClosed: boolean; stats?: PriceStatsRecord }> {
    const coin = (rawCandle.s || rawCandle.coin || '').toUpperCase();
    if (!coin) return { isNewClosed: false };

    const t = Number(rawCandle.t);
    const T = Number(rawCandle.T);
    const now = Date.now();
    const isClosed = now >= T;

    const kline: Kline4h = {
      coin,
      t,
      T,
      o: parseFloat(rawCandle.o || '0'),
      h: parseFloat(rawCandle.h || '0'),
      l: parseFloat(rawCandle.l || '0'),
      c: parseFloat(rawCandle.c || '0'),
      v: parseFloat(rawCandle.v || '0'),
      n: rawCandle.n ? Number(rawCandle.n) : undefined,
      isClosed,
    };

    // キャッシュへ最新 KLINE を保存
    await this.store.saveKline(kline);

    // 新しい 4H 足の開始を検知（直前の 4H 足が確定）
    const lastOpenTime = this.lastCandleOpenTimes.get(coin);
    let isNewClosed = false;

    if (lastOpenTime !== undefined && t > lastOpenTime) {
      // タイムスタンプが新足に進んだ = 直前足が確定！
      isNewClosed = true;
      const prevCandles = await this.store.getRecentKlines(coin, 2);
      const closedCandle = prevCandles.length >= 2 ? prevCandles[prevCandles.length - 2] : null;
      const candleInfo = closedCandle
        ? `[終=$${closedCandle.c}, 高=$${closedCandle.h}, 安=$${closedCandle.l}]`
        : '';
      logger.info(`[KlineService] 🎯 4H確定: ${coin} ${candleInfo} -> 統計再計算`);
    }

    this.lastCandleOpenTimes.set(coin, t);

    if (isNewClosed) {
      const stats = await this.recalculateMinMax(coin);
      return { isNewClosed: true, stats };
    }

    return { isNewClosed: false };
  }

  /**
   * リアルタイム価格が直近確定足の MIN/MAX を超過した場合にメモリ情報を動的更新
   */
  updateWithRealtimePrice(coin: string, realtimePrice: number): { updated: boolean; stats?: PriceStatsRecord } {
    if (realtimePrice <= 0) return { updated: false };

    const upper = coin.toUpperCase();
    const stats = this.memoryStats.get(upper);
    if (!stats) return { updated: false };

    let updated = false;
    const breakouts: string[] = [];

    // MAX値超過チェック
    if (realtimePrice > stats.maxPrice24h) { breakouts.push(`24H高値(${stats.maxPrice24h}->$${realtimePrice})`); stats.maxPrice24h = realtimePrice; updated = true; }
    if (realtimePrice > stats.maxPrice7d) { breakouts.push(`7D高値(${stats.maxPrice7d}->$${realtimePrice})`); stats.maxPrice7d = realtimePrice; updated = true; }
    if (realtimePrice > stats.maxPrice30d) { breakouts.push(`30D高値(${stats.maxPrice30d}->$${realtimePrice})`); stats.maxPrice30d = realtimePrice; updated = true; }
    if (realtimePrice > stats.maxPrice90d) { breakouts.push(`90D高値(${stats.maxPrice90d}->$${realtimePrice})`); stats.maxPrice90d = realtimePrice; updated = true; }
    if (realtimePrice > stats.maxPrice180d) { breakouts.push(`180D高値(${stats.maxPrice180d}->$${realtimePrice})`); stats.maxPrice180d = realtimePrice; updated = true; }
    if (realtimePrice > stats.maxPrice360d) { breakouts.push(`360D高値(${stats.maxPrice360d}->$${realtimePrice})`); stats.maxPrice360d = realtimePrice; updated = true; }

    // MIN値更新チェック
    if (stats.minPrice24h <= 0 || realtimePrice < stats.minPrice24h) { breakouts.push(`24H安値(${stats.minPrice24h}->$${realtimePrice})`); stats.minPrice24h = realtimePrice; updated = true; }
    if (stats.minPrice7d <= 0 || realtimePrice < stats.minPrice7d) { breakouts.push(`7D安値(${stats.minPrice7d}->$${realtimePrice})`); stats.minPrice7d = realtimePrice; updated = true; }
    if (stats.minPrice30d <= 0 || realtimePrice < stats.minPrice30d) { breakouts.push(`30D安値(${stats.minPrice30d}->$${realtimePrice})`); stats.minPrice30d = realtimePrice; updated = true; }
    if (stats.minPrice90d <= 0 || realtimePrice < stats.minPrice90d) { breakouts.push(`90D安値(${stats.minPrice90d}->$${realtimePrice})`); stats.minPrice90d = realtimePrice; updated = true; }
    if (stats.minPrice180d <= 0 || realtimePrice < stats.minPrice180d) { breakouts.push(`180D安値(${stats.minPrice180d}->$${realtimePrice})`); stats.minPrice180d = realtimePrice; updated = true; }
    if (stats.minPrice360d <= 0 || realtimePrice < stats.minPrice360d) { breakouts.push(`360D安値(${stats.minPrice360d}->$${realtimePrice})`); stats.minPrice360d = realtimePrice; updated = true; }

    stats.currentPrice = realtimePrice;
    stats.updatedAt = getJstIsoString();
    stats.change24hPct = stats.maxPrice24h > 0
      ? Math.round(((realtimePrice - stats.maxPrice24h) / stats.maxPrice24h) * 10000) / 100
      : 0;

    if (updated) {
      logger.info(`[KlineService] ⚡ ブレイク: ${upper} $${realtimePrice} [${breakouts.join(', ')}]`);
      this.store.savePriceStats(stats).catch((e: unknown) => logger.error('[KlineService] ❌ 統計保存エラー:', toError(e)));
    }

    return { updated, stats };
  }

  /**
   * キャッシュされた 4H KLINE から過去 6 期間の MIN/MAX を計算
   */
  async recalculateMinMax(coin: string): Promise<PriceStatsRecord> {
    const upper = coin.toUpperCase();
    const klines = await this.store.getRecentKlines(upper, 2160);

    if (klines.length === 0) {
      const emptyStats: PriceStatsRecord = {
        coin: upper,
        updatedAt: getJstIsoString(),
        currentPrice: 0,
        maxPrice24h: 0, maxPrice7d: 0, maxPrice30d: 0, maxPrice90d: 0, maxPrice180d: 0, maxPrice360d: 0,
        minPrice24h: 0, minPrice7d: 0, minPrice30d: 0, minPrice90d: 0, minPrice180d: 0, minPrice360d: 0,
      };
      await this.store.savePriceStats(emptyStats);
      this.memoryStats.set(upper, emptyStats);
      return emptyStats;
    }

    const latest = klines[klines.length - 1];
    const currentPrice = latest.c;

    const calcMinMaxForCount = (count: number) => {
      const slice = klines.slice(-Math.min(count, klines.length));
      let max = -Infinity;
      let min = Infinity;
      for (const k of slice) {
        if (k.h > max) max = k.h;
        if (k.l < min) min = k.l;
      }
      return {
        max: max === -Infinity ? currentPrice : max,
        min: min === Infinity ? currentPrice : min,
      };
    };

    const p24h = calcMinMaxForCount(TIMEFRAME_CANDLES_4H_COUNT['24H']);
    const p7d = calcMinMaxForCount(TIMEFRAME_CANDLES_4H_COUNT['7D']);
    const p30d = calcMinMaxForCount(TIMEFRAME_CANDLES_4H_COUNT['30D']);
    const p90d = calcMinMaxForCount(TIMEFRAME_CANDLES_4H_COUNT['90D']);
    const p180d = calcMinMaxForCount(TIMEFRAME_CANDLES_4H_COUNT['180D']);
    const p360d = calcMinMaxForCount(TIMEFRAME_CANDLES_4H_COUNT['360D']);

    const stats: PriceStatsRecord = {
      coin: upper,
      updatedAt: getJstIsoString(),
      currentPrice,
      maxPrice24h: p24h.max,
      maxPrice7d: p7d.max,
      maxPrice30d: p30d.max,
      maxPrice90d: p90d.max,
      maxPrice180d: p180d.max,
      maxPrice360d: p360d.max,

      minPrice24h: p24h.min,
      minPrice7d: p7d.min,
      minPrice30d: p30d.min,
      minPrice90d: p90d.min,
      minPrice180d: p180d.min,
      minPrice360d: p360d.min,
      change24hPct: p24h.max > 0 ? Math.round(((currentPrice - p24h.max) / p24h.max) * 10000) / 100 : 0,
    };

    await this.store.savePriceStats(stats);
    this.memoryStats.set(upper, stats);

    logger.info(
      `[KlineService] 📊 統計更新: ${upper} [現在=$${currentPrice}, 24H: $${stats.minPrice24h}~$${stats.maxPrice24h}, 360D: $${stats.minPrice360d}~$${stats.maxPrice360d}]`
    );

    return stats;
  }
}
