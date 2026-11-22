import { TRADE_ENABLED_KEYS } from "../../shared/constants/kv_keys.ts";
import { resolveTradeFlag } from "../../shared/domain/kv_flags.ts";
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
 * 売買方向別のトレード有効化フラグを確認する (worker の runSignalCheck 1 段階目と同じ)。
 * 主キーが未設定のときだけ旧キーを見て、ON のときだけ通過する (未設定は OFF)。
 *
 * KV を読めなければ検証不能として登録しない (fail-safe)
 */
export class TradeEnabledCheck implements SignalCheck {
  readonly name = "トレード有効化フラグ";

  constructor(private readonly kv: KvReader) {}

  /** フラグが ON なら通過、OFF または未設定ならスキップ、読めなければ検証不能 */
  async check(signal: TradeSignal): Promise<CheckResult> {
    const trade = TRADE_ENABLED_KEYS[signal.side];
    try {
      const [rawKey, rawFallback] = await Promise.all([
        this.kv.get(trade.key),
        this.kv.get(trade.fallbackKey),
      ]);
      return resolveTradeFlag(rawKey, rawFallback)
        ? PASS
        : skip(`${trade.label} のトレード有効化フラグ (${trade.key}) が OFF または未設定です`);
    } catch (e) {
      return unverifiedFromError("トレード有効化フラグを KV から読み取れません", e, "KV");
    }
  }
}
