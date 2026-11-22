import { DEFAULT_EXCLUDED_COINS, EXCLUDED_COINS_KEY } from "../../shared/constants/kv_keys.ts";
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

/**
 * 除外銘柄をスキップする。除外リストは KV (signal:excluded_coins) を優先し、
 * 未設定なら既定リストを使う。比較は大文字で行う。
 * kv が null の場合は既定リストのみで判定する (KV の上書きは確認できない)。
 *
 * worker は未設定時に既定リストを KV へ書き込むが、本チェックは読み取り専用で書き込まない。
 * また KV の取得に失敗した場合、worker は空リストで続行するが、本チェックは検証不能にする
 */
export class ExcludedCoinCheck implements SignalCheck {
  readonly name = "除外銘柄";

  constructor(private readonly kv: KvReader | null) {}

  /** 除外銘柄ならスキップ、リストを読めなければ検証不能 */
  async check(signal: TradeSignal): Promise<CheckResult> {
    let excluded: Set<string>;
    try {
      const raw = this.kv ? await this.kv.get(EXCLUDED_COINS_KEY) : null;
      excluded = raw === null
        ? new Set(DEFAULT_EXCLUDED_COINS.map((c) => c.trim().toUpperCase()))
        : parseExcludedCoins(raw);
    } catch (e) {
      return unverifiedFromError("除外銘柄リストを KV から読み取れません", e, "KV");
    }
    return excluded.has(signal.symbol.toUpperCase())
      ? skip(`除外銘柄です (${signal.symbol})`)
      : PASS;
  }
}
