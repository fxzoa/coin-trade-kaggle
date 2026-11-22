import { evaluateBuySignal, evaluateSellSignal } from "../../shared/domain/signal_rules.ts";
import type { RangeLabel } from "../../shared/domain/price_range.ts";
import type { SignalThresholds, TradeSignal } from "../../shared/domain/trade_signal.ts";
import type { PriceTick } from "../../shared/domain/types.ts";
import type { PriceRangeCache } from "./price_range_cache.ts";

/**
 * 最新価格と PriceRangeCache の期間別レンジから、BUY / SELL シグナルを判定する。
 * 24H の変動率 (change24h) が得られないため、24H の高値/安値からの下落率/上昇率で代用する。
 * 最新足が古い銘柄 (cron の登録遅れなど) はレンジが実態とずれるため判定せず、
 * 銘柄ごとに 1 回だけログを出す。最新足が揃えば (再集計後) 自動で判定を再開する
 */
export class SignalEvaluator {
  /** 見送りをログ済みの銘柄 (復旧時に取り除く) */
  readonly #skipLogged = new Set<string>();

  constructor(
    private readonly cache: Pick<PriceRangeCache, "getRange" | "isStaleForSignals">,
    private readonly thresholds: SignalThresholds,
    private readonly onLog: (msg: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** ティックを判定し、成立したシグナルを返す (BUY → SELL の順。レンジ未集計・レンジが古い銘柄は空) */
  evaluate(tick: PriceTick): TradeSignal[] {
    if (this.#isSkipped(tick.symbol)) return [];
    const ranges = (label: RangeLabel) => this.cache.getRange(tick.symbol, label);
    const signals = [
      evaluateBuySignal(tick, ranges, this.thresholds),
      evaluateSellSignal(tick, ranges, this.thresholds),
    ];
    return signals.filter((s): s is TradeSignal => s !== null);
  }

  /** レンジが古く判定を見送る銘柄か。見送りの開始と復旧を銘柄ごとに 1 回だけログに出す */
  #isSkipped(symbol: string): boolean {
    const stale = this.cache.isStaleForSignals(symbol, this.now());
    if (stale && !this.#skipLogged.has(symbol)) {
      this.#skipLogged.add(symbol);
      this.onLog(
        `${symbol}: 最新の確定足が古いためエントリーシグナルの判定を見送ります ` +
          `(再集計で最新足が揃うまで。DCA は影響を受けません)`,
      );
    } else if (!stale && this.#skipLogged.delete(symbol)) {
      this.onLog(`${symbol}: 最新の確定足が揃ったためエントリーシグナルの判定を再開します`);
    }
    return stale;
  }
}
