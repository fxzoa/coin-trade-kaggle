import {
  RANGE_WINDOWS,
  type RangeLabel,
  type SymbolRanges,
} from "../../shared/domain/price_range.ts";
import { PRICE_STATS_KEY_ALL, PRICE_STATS_KEY_PREFIX } from "../../shared/constants/kv_keys.ts";
import type { RangeBreakout } from "./range_breakout_detector.ts";

/** ブレイクアウトした期間・方向の要約型 */
export type BreakoutSummaryInput = Pick<RangeBreakout, "direction" | "label" | "alsoBroken">;

/** 各サービス (webui / buyer / seller / dca / dashboard 等) が参照する価格統計の共通形状 */
export interface PriceStatsKV {
  coin: string;
  maxPrice24h: number;
  minPrice24h: number;
  maxPrice7d: number;
  minPrice7d: number;
  maxPrice30d: number;
  minPrice30d: number;
  maxPrice90d: number;
  minPrice90d: number;
  maxPrice180d?: number;
  minPrice180d?: number;
  maxPrice360d?: number;
  minPrice360d?: number;
  updatedAt: number;
  /** 直近現在価格 (最新ティック価格) */
  currentPrice?: number;
  /** 最終終値 (直近現在価格と同値) */
  lastPrice?: number;
  /** 直近24時間の合計取引出来高 (USD) */
  volume24h?: number;
  /** 過去7日間の開始基準価格（始値） */
  openPrice7d?: number;
  /** 過去30日間の開始基準価格（始値） */
  openPrice30d?: number;
  /** 過去90日間の開始基準価格（始値） */
  openPrice90d?: number;
  /** 過去180日間の開始基準価格（始値） */
  openPrice180d?: number;
  /** 過去360日間の開始基準価格（始値） */
  openPrice360d?: number;
  /** 過去7日間の騰落率 (%) */
  change7d?: number;
  /** 過去30日間の騰落率 (%) */
  change30d?: number;
  /** 過去90日間の騰落率 (%) */
  change90d?: number;
  /** 過去180日間の騰落率 (%) */
  change180d?: number;
  /** 過去360日間の騰落率 (%) */
  change360d?: number;
  [key: string]: unknown;
}

/** toPriceStatsKV に渡す追加オプション */
export interface ExtraStats {
  currentPrice?: number;
  volume24h?: number;
  openPrices?: Record<string, number | null>;
}

/** 1銘柄の期間別レンジ (SymbolRanges) を PriceStatsKV に変換する (24H が無ければ null) */
export function toPriceStatsKV(
  coin: string,
  ranges: SymbolRanges,
  now: number,
  extra?: ExtraStats,
): PriceStatsKV | null {
  const r24 = ranges["24H"];
  if (!r24) return null;
  const r7 = ranges["7D"] ?? r24;
  const r30 = ranges["30D"] ?? r7;
  const r90 = ranges["90D"] ?? r30;
  const r180 = ranges["180D"];
  const r360 = ranges["360D"];

  const currentPrice = extra?.currentPrice;
  const volume24h = extra?.volume24h;
  const opens = extra?.openPrices;

  const open7 = opens?.["7D"] ?? opens?.["openPrice7d"];
  const open30 = opens?.["30D"] ?? opens?.["openPrice30d"];
  const open90 = opens?.["90D"] ?? opens?.["openPrice90d"];
  const open180 = opens?.["180D"] ?? opens?.["openPrice180d"];
  const open360 = opens?.["360D"] ?? opens?.["openPrice360d"];

  const calcChange = (
    cur: number | undefined,
    open: number | null | undefined,
  ): number | undefined => {
    if (cur === undefined || open === null || open === undefined || open <= 0) return undefined;
    return ((cur - open) / open) * 100;
  };

  return {
    coin,
    maxPrice24h: r24.high,
    minPrice24h: r24.low,
    maxPrice7d: r7.high,
    minPrice7d: r7.low,
    maxPrice30d: r30.high,
    minPrice30d: r30.low,
    maxPrice90d: r90.high,
    minPrice90d: r90.low,
    ...(r180 ? { maxPrice180d: r180.high, minPrice180d: r180.low } : {}),
    ...(r360 ? { maxPrice360d: r360.high, minPrice360d: r360.low } : {}),
    ...(currentPrice !== undefined ? { currentPrice, lastPrice: currentPrice } : {}),
    ...(volume24h !== undefined ? { volume24h } : {}),
    ...(open7 !== null && open7 !== undefined ? { openPrice7d: open7 } : {}),
    ...(open30 !== null && open30 !== undefined ? { openPrice30d: open30 } : {}),
    ...(open90 !== null && open90 !== undefined ? { openPrice90d: open90 } : {}),
    ...(open180 !== null && open180 !== undefined ? { openPrice180d: open180 } : {}),
    ...(open360 !== null && open360 !== undefined ? { openPrice360d: open360 } : {}),
    ...(calcChange(currentPrice, open7) !== undefined
      ? { change7d: calcChange(currentPrice, open7) }
      : {}),
    ...(calcChange(currentPrice, open30) !== undefined
      ? { change30d: calcChange(currentPrice, open30) }
      : {}),
    ...(calcChange(currentPrice, open90) !== undefined
      ? { change90d: calcChange(currentPrice, open90) }
      : {}),
    ...(calcChange(currentPrice, open180) !== undefined
      ? { change180d: calcChange(currentPrice, open180) }
      : {}),
    ...(calcChange(currentPrice, open360) !== undefined
      ? { change360d: calcChange(currentPrice, open360) }
      : {}),
    updatedAt: now,
  };
}

/** 既存の統計データ (出来高や始値等の補助フィールド) を維持しつつ、最新の高値・安値・更新時刻をマージする */
export function mergePriceStats(
  existing: Record<string, unknown> | null | undefined,
  stats: PriceStatsKV,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(existing ?? {}),
    ...stats,
  };

  const cur = typeof merged.currentPrice === "number" ? (merged.currentPrice as number) : undefined;
  if (cur !== undefined && cur > 0) {
    const recalc = (openKey: string, changeKey: string) => {
      const open = typeof merged[openKey] === "number" ? (merged[openKey] as number) : undefined;
      if (open !== undefined && open > 0 && stats[changeKey] === undefined) {
        merged[changeKey] = ((cur - open) / open) * 100;
      }
    };
    recalc("openPrice7d", "change7d");
    recalc("openPrice30d", "change30d");
    recalc("openPrice90d", "change90d");
    recalc("openPrice180d", "change180d");
    recalc("openPrice360d", "change360d");
  }

  return merged;
}

/** 価格レンジキャッシュの読み出しインターフェース */
export interface PriceRangeSource {
  getAll(): ReadonlyMap<string, SymbolRanges>;
  get(symbol: string): SymbolRanges | undefined;
  getOpenPrices?(symbol: string): Record<string, number | null> | undefined;
  getAllOpenPrices?(): ReadonlyMap<string, Record<string, number | null>>;
  getLatestPrice?(symbol: string): number | undefined;
  getAllLatestPrices?(): ReadonlyMap<string, number>;
}

/** Redis クライアントの必要最小限のインターフェース */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
  pipeline(): {
    set(key: string, value: string): unknown;
    exec(): Promise<unknown>;
  };
}

/** Redis 同期の設定オプション */
export interface PriceRangeRedisSyncerOptions {
  /** 同期を有効にするか (false の場合はドライランとなり書き込みをスキップ) */
  enabled: boolean;
  /** Redis キーの接頭辞 (既定: "hl:evaluator:") */
  prefix?: string;
  /** 期間別レンジ更新を通知する Pub/Sub チャンネル */
  updatedChannel?: string;
  /** 個別キー (price_stats:<coin>) も同時に書き込むか (既定: true) */
  writeIndividualKeys?: boolean;
  /** ブレイクアウト時のデバウンス待機時間 (ms, 既定: 2000) */
  debounceMs?: number;
  /** 現在時刻を返す関数 */
  now?: () => number;
  /** 銘柄ごとの 24H 取引高 (USD) を取得する関数 */
  getVolume?: (symbol: string) => number | undefined;
  /** ログ出力コールバック */
  onLog?: (msg: string) => void;
  /** エラー出力コールバック */
  onError?: (msg: string) => void;
}

/**
 * メモリキャッシュ (PriceRangeCache) の期間別最高値・最低値を Redis へ直接同期する Use Case。
 * 1. H4 定期集計完了時および起動時の一括同期 (syncAll)
 * 2. ティックによるブレイクアウト発生時のスロットル同期 (queueBreakout / flushBreakouts)
 */
export class PriceRangeRedisSyncer {
  readonly #redis: RedisClientLike;
  readonly #cache: PriceRangeSource;
  readonly #enabled: boolean;
  readonly #prefix: string;
  readonly #updatedChannel: string;
  readonly #writeIndividualKeys: boolean;
  readonly #debounceMs: number;
  readonly #now: () => number;
  readonly #getVolume?: (symbol: string) => number | undefined;
  readonly #onLog: (msg: string) => void;
  readonly #onError: (msg: string) => void;

  /** メモリ上に保持する全銘柄一括統計マップ (既存 Redis から読み込み・随時マージ) */
  #allStats: Record<string, Record<string, unknown>> | null = null;
  /** ブレイクアウトで更新待ちの銘柄一覧 */
  #dirtySymbols = new Set<string>();
  /** ブレイクアウト発生時の最新価格 */
  #pendingPrices = new Map<string, number>();
  /** ブレイクアウト発生時の期間ラベルと方向 (ログ表示用) */
  #pendingBreakouts = new Map<string, { high: Set<RangeLabel>; low: Set<RangeLabel> }>();
  /** デバウンス用タイマー ID */
  #timerId: ReturnType<typeof setTimeout> | null = null;
  /** 破棄済みフラグ */
  #disposed = false;

  constructor(
    deps: {
      redisClient: RedisClientLike;
      cache: PriceRangeSource;
    },
    options: PriceRangeRedisSyncerOptions,
  ) {
    this.#redis = deps.redisClient;
    this.#cache = deps.cache;
    this.#enabled = options.enabled;
    this.#prefix = options.prefix ?? "hl:evaluator:";
    this.#updatedChannel = options.updatedChannel ?? "hl:events:price_stats";
    this.#writeIndividualKeys = options.writeIndividualKeys ?? true;
    this.#debounceMs = options.debounceMs ?? 2000;
    this.#now = options.now ?? Date.now;
    this.#getVolume = options.getVolume;
    this.#onLog = options.onLog ?? (() => {});
    this.#onError = options.onError ?? (() => {});
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** 全銘柄の期間別レンジを Redis へ一括同期する (H4 集計完了時や起動時に呼び出す) */
  async syncAll(): Promise<number> {
    if (!this.#enabled) {
      this.#onLog("期間別レンジの Redis 同期: 無効 (ドライランのためスキップ)");
      return 0;
    }

    try {
      // 既存の price_stats:all を読み取り、マージ元にする
      await this.#ensureAllStatsLoaded();

      const allRanges = this.#cache.getAll();
      const now = this.#now();
      const pipeline = this.#redis.pipeline();
      let count = 0;
      const updatedSymbols: string[] = [];

      for (const [symbol, ranges] of allRanges) {
        const currentPrice = this.#pendingPrices.get(symbol) ??
          this.#cache.getLatestPrice?.(symbol);
        const openPrices = this.#cache.getOpenPrices?.(symbol);
        const volume24h = this.#getVolume?.(symbol);
        const stats = toPriceStatsKV(symbol, ranges, now, {
          currentPrice,
          volume24h,
          openPrices,
        });
        if (!stats) continue;

        const merged = mergePriceStats(this.#allStats![symbol], stats);
        this.#allStats![symbol] = merged;
        count++;
        updatedSymbols.push(symbol);

        if (this.#writeIndividualKeys) {
          const valStr = JSON.stringify(merged);
          pipeline.set(`${this.#prefix}${PRICE_STATS_KEY_PREFIX}${symbol}`, valStr);
          if (this.#prefix !== "") {
            pipeline.set(`${PRICE_STATS_KEY_PREFIX}${symbol}`, valStr);
          }
        }
      }

      // price_stats:all 一括キャッシュを書き込み
      const allStr = JSON.stringify(this.#allStats);
      pipeline.set(`${this.#prefix}${PRICE_STATS_KEY_ALL}`, allStr);
      if (this.#prefix !== "") {
        pipeline.set(PRICE_STATS_KEY_ALL, allStr);
      }

      await pipeline.exec();
      if (updatedSymbols.length > 0) {
        await this.#publishUpdated(updatedSymbols, now);
      }
      this.#onLog(
        `期間別レンジを Redis (${this.#prefix}price_stats:*) へ一括同期しました: ${count} 銘柄`,
      );
      return count;
    } catch (err) {
      const msg = `期間別レンジの Redis 一括同期に失敗しました: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this.#onError(msg);
      return 0;
    }
  }

  /** ブレイクアウトを検出した銘柄を更新待ちキューへ追加し、デバウンスで非同期送信をスケジュールする */
  queueBreakout(
    symbol: string,
    price?: number,
    breakouts?: readonly BreakoutSummaryInput[],
  ): void {
    if (!this.#enabled || this.#disposed) return;
    this.#dirtySymbols.add(symbol);
    if (price !== undefined) {
      this.#pendingPrices.set(symbol, price);
    }
    if (breakouts && breakouts.length > 0) {
      let entry = this.#pendingBreakouts.get(symbol);
      if (!entry) {
        entry = { high: new Set<RangeLabel>(), low: new Set<RangeLabel>() };
        this.#pendingBreakouts.set(symbol, entry);
      }
      for (const b of breakouts) {
        const targetSet = entry[b.direction];
        targetSet.add(b.label);
        for (const also of b.alsoBroken) {
          targetSet.add(also);
        }
      }
    }

    if (this.#timerId === null) {
      this.#timerId = setTimeout(() => {
        this.#timerId = null;
        this.flushBreakouts().catch((err) => {
          this.#onError(
            `ブレイクアウト Redis 同期中にエラーが発生しました: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, this.#debounceMs);
    }
  }

  /** キューに入っているブレイクアウト銘柄を Redis へフラッシュする */
  async flushBreakouts(): Promise<number> {
    if (!this.#enabled || this.#dirtySymbols.size === 0) return 0;

    const symbolsToFlush = Array.from(this.#dirtySymbols);
    this.#dirtySymbols.clear();

    try {
      await this.#ensureAllStatsLoaded();
      const now = this.#now();
      const pipeline = this.#redis.pipeline();
      const updatedSymbols: string[] = [];

      for (const symbol of symbolsToFlush) {
        const ranges = this.#cache.get(symbol);
        if (!ranges) continue;

        const currentPrice = this.#pendingPrices.get(symbol) ??
          this.#cache.getLatestPrice?.(symbol);
        const openPrices = this.#cache.getOpenPrices?.(symbol);
        const volume24h = this.#getVolume?.(symbol);
        const stats = toPriceStatsKV(symbol, ranges, now, {
          currentPrice,
          volume24h,
          openPrices,
        });
        if (!stats) continue;

        const merged = mergePriceStats(this.#allStats![symbol], stats);
        this.#allStats![symbol] = merged;
        updatedSymbols.push(symbol);

        if (this.#writeIndividualKeys) {
          const valStr = JSON.stringify(merged);
          pipeline.set(`${this.#prefix}${PRICE_STATS_KEY_PREFIX}${symbol}`, valStr);
          if (this.#prefix !== "") {
            pipeline.set(`${PRICE_STATS_KEY_PREFIX}${symbol}`, valStr);
          }
        }
      }

      if (updatedSymbols.length === 0) return 0;

      // price_stats:all を更新
      const allStr = JSON.stringify(this.#allStats);
      pipeline.set(`${this.#prefix}${PRICE_STATS_KEY_ALL}`, allStr);
      if (this.#prefix !== "") {
        pipeline.set(PRICE_STATS_KEY_ALL, allStr);
      }

      await pipeline.exec();
      await this.#publishUpdated(updatedSymbols, now);

      const formattedSymbols = updatedSymbols.map((symbol) => {
        const summary = this.#formatBreakoutSummary(symbol);
        this.#pendingPrices.delete(symbol);
        this.#pendingBreakouts.delete(symbol);
        return summary;
      });
      this.#onLog(`ブレイクアウト価格を Redis へ更新しました: ${formattedSymbols.join(", ")}`);
      return updatedSymbols.length;
    } catch (err) {
      for (const s of symbolsToFlush) {
        this.#dirtySymbols.add(s);
      }
      throw err;
    }
  }

  async #publishUpdated(symbols: string[], updatedAt: number): Promise<void> {
    try {
      await this.#redis.publish(
        this.#updatedChannel,
        JSON.stringify({ symbols, updatedAt }),
      );
    } catch (err) {
      this.#onError(
        `期間別レンジ更新の Pub/Sub 通知に失敗しました: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  #formatBreakoutSummary(symbol: string): string {
    const entry = this.#pendingBreakouts.get(symbol);
    if (!entry) return symbol;

    const parts: string[] = [];
    if (entry.high.size > 0) {
      const labels = RANGE_WINDOWS.map((w) => w.label).filter((l) => entry.high.has(l));
      if (labels.length > 0) parts.push(`${labels.join("/")} 高値`);
    }
    if (entry.low.size > 0) {
      const labels = RANGE_WINDOWS.map((w) => w.label).filter((l) => entry.low.has(l));
      if (labels.length > 0) parts.push(`${labels.join("/")} 安値`);
    }
    return parts.length > 0 ? `${symbol} (${parts.join(", ")})` : symbol;
  }

  /** 既存の price_stats:all がロードされていなければ Redis から取得して初期化する */
  async #ensureAllStatsLoaded(): Promise<void> {
    if (this.#allStats !== null) return;

    try {
      const raw = (await this.#redis.get(`${this.#prefix}${PRICE_STATS_KEY_ALL}`)) ??
        (await this.#redis.get(PRICE_STATS_KEY_ALL));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          this.#allStats = parsed as Record<string, Record<string, unknown>>;
          return;
        }
      }
    } catch {
      // 読み取り失敗やパースエラー時は新規作成として扱う
    }
    this.#allStats = {};
  }

  /** 終了時の後始末 (タイマー解除と未送信分のフラッシュ) */
  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timerId !== null) {
      clearTimeout(this.#timerId);
      this.#timerId = null;
    }
    if (this.#dirtySymbols.size > 0) {
      await this.flushBreakouts().catch((err) => {
        this.#onError(
          `終了時 Redis フラッシュでエラー: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
}
