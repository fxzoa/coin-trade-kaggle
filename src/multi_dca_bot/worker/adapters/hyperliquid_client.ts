/**
 * multi-dca-bot: Hyperliquid 取引所 REST クライアント
 * - マーケットデータ取得 (allMids, candleSnapshot)
 * - ユーザー口座情報取得 (clearinghouseState, openOrders, userFills)
 * ※ 発注は行わない (注文は Redis トピック経由で coin-trade-bot が実行)
 */

import { logger } from '../../shared/logger.ts';
import type { Kline4h } from '../../shared/types.ts';
import { HyperliquidApiError, toError } from '../../shared/errors.ts';

export class HyperliquidClient {
  private readonly apiUrl: string;
  private readonly walletAddress?: string;
  private assetMetaCache: Record<string, { assetIndex: number; szDecimals: number }> = {};

  constructor(apiUrl = 'https://api.hyperliquid.xyz', walletAddress?: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.walletAddress = walletAddress?.trim();
  }

  private async fetchWithRetry(body: unknown, maxRetries = 3): Promise<any> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}/info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          const waitMs = attempt * 1500;
          logger.warn(`[HyperliquidClient] レートリミット (429) 検知。${waitMs}ms 待機後リトライ (${attempt}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (!res.ok) {
          throw new HyperliquidApiError(`HTTP ${res.status}: ${await res.text()}`, { statusCode: res.status });
        }

        return await res.json();
      } catch (err: unknown) {
        lastError = toError(err);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
    throw new HyperliquidApiError('Hyperliquid API リクエスト失敗', { cause: lastError });
  }

  /**
   * 通貨のメタ情報 (assetIndex, szDecimals) を取得
   */
  async getAssetMeta(coin: string): Promise<{ assetIndex: number; szDecimals: number }> {
    const coinUpper = coin.toUpperCase();
    if (this.assetMetaCache[coinUpper]) {
      return this.assetMetaCache[coinUpper];
    }

    const data = await this.fetchWithRetry({ type: 'meta' });
    const universe = data?.universe || [];
    const index = universe.findIndex((u: any) => u.name.toUpperCase() === coinUpper);
    if (index === -1) {
      throw new HyperliquidApiError(`未対応の通貨です: ${coin}`, { statusCode: 400 });
    }

    const meta = { assetIndex: index, szDecimals: universe[index].szDecimals };
    this.assetMetaCache[coinUpper] = meta;
    return meta;
  }

  /**
   * 全通貨の現在中間価格 (allMids) を取得
   */
  async getAllMids(): Promise<Record<string, number>> {
    const raw = await this.fetchWithRetry({ type: 'allMids' });
    const result: Record<string, number> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        result[k.toUpperCase()] = parseFloat(v as string) || 0;
      }
    }
    return result;
  }

  /**
   * 過去の 4時間足ローソク足 (candleSnapshot) を取得
   * Hyperliquid は最大 5000 本まで返却可能
   */
  async getCandleSnapshot(
    coin: string,
    interval = '4h',
    startTimeMs?: number,
    endTimeMs?: number
  ): Promise<Kline4h[]> {
    const end = endTimeMs || Date.now();
    // 360日 = 360 * 24 * 3600 * 1000 ms
    const start = startTimeMs || end - (360 * 24 * 60 * 60 * 1000);

    const rawCandles = await this.fetchWithRetry({
      type: 'candleSnapshot',
      req: {
        coin,
        interval,
        startTime: start,
        endTime: end,
      },
    });

    if (!Array.isArray(rawCandles)) {
      return [];
    }

    const now = Date.now();
    return rawCandles.map((c: any) => {
      const t = Number(c.t);
      const T = Number(c.T);
      return {
        coin: coin.toUpperCase(),
        t,
        T,
        o: parseFloat(c.o || '0'),
        h: parseFloat(c.h || '0'),
        l: parseFloat(c.l || '0'),
        c: parseFloat(c.c || '0'),
        v: parseFloat(c.v || '0'),
        n: c.n ? Number(c.n) : undefined,
        isClosed: now >= T, // 現在時刻が終了時刻を過ぎていれば確定足
      };
    });
  }

  /**
   * ユーザーの出金可能残高（withdrawable）を取得
   */
  async getWithdrawable(walletAddress: string = this.walletAddress || ''): Promise<number> {
    if (!walletAddress) return 0;
    try {
      const res = await this.fetchWithRetry({
        type: 'clearinghouseState',
        user: walletAddress,
      });
      const val = parseFloat(res?.withdrawable || '0');
      return isNaN(val) ? 0 : val;
    } catch (err: unknown) {
      logger.warn('[HyperliquidClient] withdrawable 取得失敗:', toError(err));
      return 0;
    }
  }

  /**
   * ユーザーの保有ポジション一覧を取得
   */
  async getUserPositions(walletAddress: string = this.walletAddress || ''): Promise<any[]> {
    if (!walletAddress) return [];
    const res = await this.fetchWithRetry({
      type: 'clearinghouseState',
      user: walletAddress,
    });
    if (!res || !Array.isArray(res.assetPositions)) return [];
    return res.assetPositions.map((ap: any) => ap.position).filter(Boolean);
  }

  /**
   * ユーザーの未約定注文を取得
   */
  async getUserOpenOrders(walletAddress: string = this.walletAddress || ''): Promise<any[]> {
    if (!walletAddress) return [];
    const res = await this.fetchWithRetry({
      type: 'openOrders',
      user: walletAddress,
    });
    return Array.isArray(res) ? res : [];
  }

  /**
   * ユーザーの約定履歴を取得
   * @param walletAddress 取得対象ウォレットアドレス
   * @param options Redis キャッシュ参照オプション (store 指定時、キャッシュ優先確認またはAPIエラー時フォールバック)
   */
  async getUserFills(
    walletAddress: string = this.walletAddress || '',
    options?: {
      store?: { getSharedUserFills: (user: string, limit?: number) => Promise<any[]> };
      limit?: number;
      preferCache?: boolean;
    }
  ): Promise<any[]> {
    const user = walletAddress || this.walletAddress || '';
    if (!user) return [];

    // preferCache 指定時は Redis 共有キャッシュ (hl:fills:{user}) を優先確認
    if (options?.preferCache && options?.store) {
      try {
        const cached = await options.store.getSharedUserFills(user, options.limit || 50);
        if (cached && cached.length > 0) {
          logger.info(`[HyperliquidClient] 📦 Redis 共有キャッシュから約定履歴を取得しました (件数: ${cached.length})`);
          return cached;
        }
      } catch (err: unknown) {
        logger.warn('[HyperliquidClient] Redis キャッシュ確認エラー、Hyperliquid API へフォールバック:', toError(err));
      }
    }

    try {
      const res = await this.fetchWithRetry({
        type: 'userFills',
        user,
      });
      return Array.isArray(res) ? res : [];
    } catch (err: unknown) {
      if (options?.store) {
        try {
          const cached = await options.store.getSharedUserFills(user, options.limit || 50);
          if (cached && cached.length > 0) {
            logger.warn(`[HyperliquidClient] ⚠️ API 約定履歴取得失敗。Redis 共有キャッシュ (${cached.length}件) をフォールバック使用します:`, toError(err));
            return cached;
          }
        } catch {
          // キャッシュ取得失敗時は元の API エラーを送出
        }
      }
      throw err;
    }
  }
}

/**
 * Redis キャッシュ対応でユーザー約定を取得するヘルパー関数
 */
export async function fetchUserFillsWithRedisCache(
  client: HyperliquidClient,
  store: { getSharedUserFills: (user: string, limit?: number) => Promise<any[]> },
  user: string,
  limit = 50,
  preferCache = false
): Promise<any[]> {
  return await client.getUserFills(user, { store, limit, preferCache });
}
