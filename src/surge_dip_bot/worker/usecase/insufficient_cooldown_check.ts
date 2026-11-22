import { INSUFFICIENT_COOLDOWN_KEY } from "../../shared/constants/kv_keys.ts";
import { parseInsufficientCooldown } from "../../shared/domain/kv_flags.ts";
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
 * Insufficient 停止 (有効かつ期限内) ならスキップする
 * (worker の runSignalCheck 3 段階目と同じ)。
 *
 * worker は取得失敗を「停止していない」と扱うが、本チェックは検証不能にする (fail-safe)
 */
export class InsufficientCooldownCheck implements SignalCheck {
  readonly name = "Insufficient 停止";

  constructor(
    private readonly kv: KvReader,
    private readonly now: () => number = Date.now,
  ) {}

  /** 停止中でなければ通過、停止中ならスキップ、読めなければ検証不能 */
  async check(_signal: TradeSignal): Promise<CheckResult> {
    try {
      const insufficient = parseInsufficientCooldown(
        await this.kv.get(INSUFFICIENT_COOLDOWN_KEY),
        this.now(),
      );
      return insufficient.active
        ? skip(
          `Insufficient 停止中です (再開予定: ${insufficient.untilIso ?? "不明"}, ` +
            `理由: ${insufficient.reason ?? "不明"})`,
        )
        : PASS;
    } catch (e) {
      return unverifiedFromError("Insufficient 停止を KV から読み取れません", e, "KV");
    }
  }
}
