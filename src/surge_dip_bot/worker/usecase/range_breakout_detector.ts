import { RANGE_WINDOWS, type RangeLabel } from "../../shared/domain/price_range.ts";
import type { PriceTick } from "../../shared/domain/types.ts";
import type { PriceRangeCache } from "./price_range_cache.ts";

/** 期間内の最高値/最低値の更新 */
export interface RangeBreakout {
  symbol: string;
  /** high = 最高値の更新、low = 最低値の更新 */
  direction: "high" | "low";
  /** 更新した価格 */
  price: number;
  /** 更新された期間のうち最長のもの */
  label: RangeLabel;
  /** その期間の更新前の最高値/最低値 */
  previousLevel: number;
  /** 同時に更新された、より短い期間 (長い順) */
  alsoBroken: RangeLabel[];
  /** 検出時刻 (エポックミリ秒) */
  timestamp: number;
}

/**
 * 最新価格が、キャッシュ上の期間別の最高値/最低値を更新したかを判定する。
 * 更新を検出したら、その価格でキャッシュの最高値/最低値自体を更新する。
 * これにより、同じ水準での連続通知や、再集計後の重複通知を防ぐ
 */
export class RangeBreakoutDetector {
  constructor(private readonly cache: Pick<PriceRangeCache, "getRange" | "applyPrice">) {}

  /** ティックを判定し、更新があれば返す (キャッシュ未集計の銘柄・期間は判定しない) */
  detect(tick: PriceTick): RangeBreakout[] {
    const breakouts: RangeBreakout[] = [];

    for (const direction of ["high", "low"] as const) {
      const broken = this.#brokenWindows(tick, direction);
      if (broken.length === 0) continue;

      // 長い期間を更新していれば短い期間も必ず更新されるため、最長を代表にする
      const [longest, ...rest] = broken.reverse();
      breakouts.push({
        symbol: tick.symbol,
        direction,
        price: tick.price,
        label: longest.label,
        previousLevel: longest.level,
        alsoBroken: rest.map((b) => b.label),
        timestamp: tick.timestamp,
      });
    }

    if (breakouts.length > 0) this.cache.applyPrice(tick.symbol, tick.price, tick.timestamp);
    return breakouts;
  }

  /** 更新された期間 (短い順) と、その更新前の最高値/最低値を返す */
  #brokenWindows(
    tick: PriceTick,
    direction: "high" | "low",
  ): { label: RangeLabel; level: number }[] {
    const broken: { label: RangeLabel; level: number }[] = [];
    for (const { label } of RANGE_WINDOWS) {
      const range = this.cache.getRange(tick.symbol, label);
      if (!range) continue;
      const level = direction === "high" ? range.high : range.low;
      if (direction === "high" ? tick.price > level : tick.price < level) {
        broken.push({ label, level });
      }
    }
    return broken;
  }
}
