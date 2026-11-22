import { floorToH4, H4_MS } from "../../shared/domain/h4_time.ts";
import {
  type PriceRange,
  RANGE_WINDOWS,
  type RangeLabel,
  type SymbolRanges,
} from "../../shared/domain/price_range.ts";

/** DB から読み出した集計元データ */
export interface RangeSnapshot {
  /** 銘柄別・期間別のレンジ */
  ranges: Map<string, Record<string, PriceRange | null>>;
  /** 銘柄別の最新足の open_time (ms) */
  latestOpenTimes: Map<string, number>;
  /** 銘柄別・期間別の始値 (open) */
  openPrices?: Map<string, Record<string, number | null>>;
}

/** 期間ラベル → 集計開始時刻 (ms) を受け取り、集計元データを読み出す関数 */
export type RangeLoader = (since: Record<string, number>) => RangeSnapshot;

/**
 * シグナル判定で最新足の遅れを許容する、H4 境界からの猶予 (ms)。
 * 境界の直後は cron による最新足の登録と、レンジの再集計 (境界 +5 分から最大 5 回・1 分間隔 = 約 10 分)
 * が終わるまで最新足が 1 本古いのが正常なため、集計の再試行が終わった後の 15 分までは古さとみなさない
 */
export const SIGNAL_STALE_GRACE_MS = 15 * 60 * 1000;

/** 現在価格で更新した最高値/最低値とその時刻 (DB の再集計後に引き継ぐ) */
interface LiveExtreme {
  price: number;
  time: number;
}

/** 現在価格で最高値/最低値を更新中の銘柄 */
export interface ActiveExtreme {
  symbol: string;
  direction: "high" | "low";
  /** 現在の最高値/最低値を決めている価格 */
  price: number;
  /** 現在価格が最高値/最低値になっている期間 (短い期間から) */
  labels: RangeLabel[];
}

interface LiveExtremes {
  high?: LiveExtreme;
  low?: LiveExtreme;
}

/** 期間ごとに価格を取り込み、最高値/最低値を更新した新しいレンジを返す */
function raiseRanges(
  ranges: SymbolRanges,
  extremes: { high?: LiveExtreme; low?: LiveExtreme },
  isValid: (e: LiveExtreme, windowMs: number) => boolean,
): SymbolRanges {
  const next = { ...ranges };
  for (const { label, ms } of RANGE_WINDOWS) {
    const range = ranges[label];
    if (!range) continue;
    const { high, low } = extremes;
    next[label] = {
      high: high && isValid(high, ms) ? Math.max(range.high, high.price) : range.high,
      low: low && isValid(low, ms) ? Math.min(range.low, low.price) : range.low,
    };
  }
  return next;
}

/**
 * 銘柄別・期間別の最高値/最低値をメモリに保持するキャッシュ。
 * DB には進行中の足が入らないため、現在価格が最高値/最低値を超えたら `applyPrice` で
 * キャッシュ自体を更新する。更新分は DB の再集計後も、期間の長さを過ぎるまで引き継ぐ
 */
export class PriceRangeCache {
  #ranges = new Map<string, SymbolRanges>();
  #live = new Map<string, LiveExtremes>();
  #latestOpenTimes = new Map<string, number>();
  #openPrices = new Map<string, Record<string, number | null>>();
  #latestPrices = new Map<string, number>();
  #updatedAt: number | null = null;

  constructor(private readonly load: RangeLoader) {}

  /** 集計し直してキャッシュを丸ごと差し替える。失敗時は例外を送出し、既存の内容は保持する */
  refresh(now: number): void {
    const since = Object.fromEntries(RANGE_WINDOWS.map((w) => [w.label, now - w.ms]));
    // 集計が成功してから差し替えるので、参照側が途中状態を見ることはない
    const snapshot = this.load(since);
    this.#ranges = this.#withLiveExtremes(snapshot.ranges as Map<string, SymbolRanges>, now);
    this.#latestOpenTimes = snapshot.latestOpenTimes;
    this.#openPrices = snapshot.openPrices ?? new Map();
    this.#updatedAt = now;
  }

  /** 外部から取得した Snapshot で直接キャッシュを更新する (Redis 非同期ロード用) */
  setSnapshot(snapshot: RangeSnapshot, now: number): void {
    this.#ranges = this.#withLiveExtremes(snapshot.ranges as Map<string, SymbolRanges>, now);
    this.#latestOpenTimes = snapshot.latestOpenTimes;
    this.#openPrices = snapshot.openPrices ?? new Map();
    this.#updatedAt = now;
  }

  /** 直近ティックの価格を記録する (全ティックで呼ぶ。レンジは更新しない) */
  recordPrice(symbol: string, price: number): void {
    this.#latestPrices.set(symbol, price);
  }

  /**
   * 現在価格を取り込み、期間ごとの最高値を上回る/最低値を下回る場合はその値で更新する。
   * 未集計の銘柄・期間は何もしない
   */
  applyPrice(symbol: string, price: number, now: number): void {
    this.recordPrice(symbol, price);
    const ranges = this.#ranges.get(symbol);
    if (!ranges) return;
    const live = this.#live.get(symbol) ?? {};
    const current = { high: { price, time: now }, low: { price, time: now } };
    const next = raiseRanges(ranges, current, () => true);

    // 更新があった側だけを、再集計後に引き継ぐ値として記録する
    const raised = RANGE_WINDOWS.some((w) =>
      ranges[w.label] && next[w.label]!.high > ranges[w.label]!.high
    );
    const lowered = RANGE_WINDOWS.some((w) =>
      ranges[w.label] && next[w.label]!.low < ranges[w.label]!.low
    );
    if (raised && (!live.high || price >= live.high.price)) live.high = current.high;
    if (lowered && (!live.low || price <= live.low.price)) live.low = current.low;
    if (raised || lowered) {
      this.#live.set(symbol, live);
      this.#ranges.set(symbol, next);
    }
  }

  /**
   * 現在価格による更新が、いまも最高値/最低値になっている銘柄の一覧を返す。
   * 再集計をまたいで引き継いだ分を含み、期間を過ぎた更新分は含まない
   */
  activeExtremes(now: number): ActiveExtreme[] {
    const result: ActiveExtreme[] = [];
    for (const [symbol, live] of this.#live) {
      const ranges = this.#ranges.get(symbol);
      if (!ranges) continue;
      for (const direction of ["high", "low"] as const) {
        const extreme = live[direction];
        if (!extreme) continue;
        // 更新した価格が、いまも期間内で実際に最高値/最低値になっている期間を集める
        const labels = RANGE_WINDOWS
          .filter(({ label, ms }) =>
            now - extreme.time < ms && ranges[label]?.[direction] === extreme.price
          )
          .map((w) => w.label);
        if (labels.length > 0) result.push({ symbol, direction, price: extreme.price, labels });
      }
    }
    return result;
  }

  /** 再集計した結果に、期間内の現在価格による更新分を重ねる。期限切れの更新分は破棄する */
  #withLiveExtremes(
    ranges: Map<string, SymbolRanges>,
    now: number,
  ): Map<string, SymbolRanges> {
    const maxMs = Math.max(...RANGE_WINDOWS.map((w) => w.ms));
    const isValid = (e: LiveExtreme, windowMs: number) => now - e.time < windowMs;
    for (const [symbol, live] of this.#live) {
      if (live.high && now - live.high.time >= maxMs) delete live.high;
      if (live.low && now - live.low.time >= maxMs) delete live.low;
      const base = ranges.get(symbol);
      if (base) ranges.set(symbol, raiseRanges(base, live, isValid));
      if (!live.high && !live.low) this.#live.delete(symbol);
    }
    return ranges;
  }

  /** 銘柄の期間別レンジを返す (未集計の銘柄は undefined) */
  get(symbol: string): SymbolRanges | undefined {
    return this.#ranges.get(symbol);
  }

  /** 全銘柄の期間別レンジ (読み取り専用 Map) を返す */
  getAll(): ReadonlyMap<string, SymbolRanges> {
    return this.#ranges;
  }

  /** 銘柄の特定期間のレンジを返す */
  getRange(symbol: string, label: RangeLabel): PriceRange | null {
    return this.#ranges.get(symbol)?.[label] ?? null;
  }

  /**
   * 直前に確定した H4 足がまだ DB に無い銘柄を返す。
   * cron による最新足の登録が間に合っていない (または失敗した) ことの検知に使う
   */
  staleSymbols(now: number): string[] {
    const expected = floorToH4(now) - H4_MS;
    return [...this.#latestOpenTimes].filter(([, t]) => t < expected).map(([s]) => s);
  }

  /**
   * 銘柄のレンジが古く、シグナル判定に使えないか。
   * 最新足の open_time が、猶予 (SIGNAL_STALE_GRACE_MS) を引いた時刻で期待される最新の確定足
   * (直前の H4 足) より前なら古いとする。最新足の情報が無い銘柄は判定できないため古いとしない
   */
  isStaleForSignals(symbol: string, now: number): boolean {
    const latest = this.#latestOpenTimes.get(symbol);
    if (latest === undefined) return false;
    return latest < floorToH4(now - SIGNAL_STALE_GRACE_MS) - H4_MS;
  }

  /** キャッシュしている銘柄数 */
  get size(): number {
    return this.#ranges.size;
  }

  /** 最後に集計した時刻 (ms)。未集計なら null */
  get updatedAt(): number | null {
    return this.#updatedAt;
  }

  /** 銘柄の期間別始値を取得する */
  getOpenPrices(symbol: string): Record<string, number | null> | undefined {
    return this.#openPrices.get(symbol);
  }

  /** 全銘柄の期間別始値マップを取得する */
  getAllOpenPrices(): ReadonlyMap<string, Record<string, number | null>> {
    return this.#openPrices;
  }

  /** 銘柄の直近ティック価格を取得する */
  getLatestPrice(symbol: string): number | undefined {
    return this.#latestPrices.get(symbol);
  }

  /** 全銘柄の直近ティック価格マップを取得する */
  getAllLatestPrices(): ReadonlyMap<string, number> {
    return this.#latestPrices;
  }
}
