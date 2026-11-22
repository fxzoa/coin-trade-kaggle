import {
  BTC_GRID_COINS,
  DCA_TARGET_COINS_KEY,
  DEFAULT_DCA_TARGET_COINS,
} from "../../shared/constants/kv_keys.ts";
import { parseExcludedCoins } from "../../shared/domain/kv_flags.ts";
import type { KvReader } from "../../shared/domain/ports.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import {
  type CheckResult,
  PASS,
  type SignalCheck,
  skip,
  unverifiedFromError,
} from "./signal_check.ts";

/** 大文字化した銘柄の Set を作る */
function toUpperSet(coins: readonly string[]): Set<string> {
  return new Set(coins.map((c) => c.trim().toUpperCase()));
}

/**
 * 他ワーカーが専任で扱う銘柄をスキップする (通常エントリー・DCA の両方で適用)。
 * - btc-grid-worker: BTC (固定)
 * - dca-worker: KV (trade:dca_target_coins) の対象銘柄。未設定・空・解釈不能なら既定リスト
 *   (dca-worker が未設定時に使う既定値と同じ)。比較は大文字で行う。
 * kv が null の場合は既定リストのみで判定する (KV の上書きは確認できない)。
 *
 * dca-worker と違い KV への書き込み (既定値の初期化) は行わない。
 * KV の取得に失敗した場合は、取りこぼしを避けるため検証不能にする
 */
export class OtherWorkerCoinCheck implements SignalCheck {
  readonly name = "他ワーカー担当銘柄";

  private readonly btcGridCoins = toUpperSet(BTC_GRID_COINS);

  constructor(private readonly kv: KvReader | null) {}

  /** 他ワーカー担当の銘柄ならスキップ、DCA 対象リストを読めなければ検証不能 */
  async check(signal: TradeSignal): Promise<CheckResult> {
    const symbol = signal.symbol.toUpperCase();
    if (this.btcGridCoins.has(symbol)) {
      return skip(`btc-grid-worker の担当銘柄です (${signal.symbol})`);
    }

    let dcaCoins: Set<string>;
    try {
      const raw = this.kv ? await this.kv.get(DCA_TARGET_COINS_KEY) : null;
      const parsed = raw === null ? new Set<string>() : parseExcludedCoins(raw);
      dcaCoins = parsed.size > 0 ? parsed : toUpperSet(DEFAULT_DCA_TARGET_COINS);
    } catch (e) {
      return unverifiedFromError("DCA 対象銘柄リストを KV から読み取れません", e, "KV");
    }
    return dcaCoins.has(symbol) ? skip(`dca-worker の担当銘柄です (${signal.symbol})`) : PASS;
  }
}
