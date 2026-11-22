import {
  SYSTEM_MAINTENANCE_KEY,
  SYSTEM_MAINTENANCE_PRICE_CHANGE_KEY,
} from "../../shared/constants/kv_keys.ts";
import { parseBooleanFlag } from "../../shared/domain/kv_flags.ts";
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
 * メンテナンスフラグ (price_change / 全体のいずれか) が ON ならスキップする
 * (worker の runSignalCheck 2 段階目と同じ)。
 *
 * worker は取得失敗を「メンテナンス中ではない」と扱うが、本チェックは検証不能にする (fail-safe)
 */
export class MaintenanceCheck implements SignalCheck {
  readonly name = "メンテナンスモード";

  constructor(private readonly kv: KvReader) {}

  /** どちらのフラグも OFF なら通過、ON ならスキップ (ON のキーを理由に含む)、読めなければ検証不能 */
  async check(_signal: TradeSignal): Promise<CheckResult> {
    try {
      const [priceChange, system] = await Promise.all([
        this.kv.get(SYSTEM_MAINTENANCE_PRICE_CHANGE_KEY),
        this.kv.get(SYSTEM_MAINTENANCE_KEY),
      ]);
      const activeKeys = [
        parseBooleanFlag(priceChange) ? SYSTEM_MAINTENANCE_PRICE_CHANGE_KEY : null,
        parseBooleanFlag(system) ? SYSTEM_MAINTENANCE_KEY : null,
      ].filter((key) => key !== null);
      return activeKeys.length > 0
        ? skip(`メンテナンスモード中です (${activeKeys.join(", ")})`)
        : PASS;
    } catch (e) {
      return unverifiedFromError("メンテナンスフラグを KV から読み取れません", e, "KV");
    }
  }
}
