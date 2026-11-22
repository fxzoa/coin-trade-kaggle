import type { DcaExistingCounts } from "../../shared/domain/dca_rules.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import {
  type CheckResult,
  PASS,
  type SignalCheck,
  skip,
  unverifiedFromError,
} from "./signal_check.ts";

/** DCA 用の既存件数の取得元 (実装は D1EligibilityRepository) */
export interface DcaCountsSource {
  /** 同一 coin・side・signal_type の NEW シグナル件数と、同一 coin・side の NEW 注文件数を取得する。失敗時は reject */
  fetchDcaCounts(signal: TradeSignal): Promise<DcaExistingCounts>;
}

/**
 * DCA の重複防止。worker の filterEligibleDcaSignals と同じく次の 2 条件だけでスキップする
 * (通常エントリーの保有中・決済後待機・OPEN 注文の判定は適用しない):
 * 1. 同一 coin・side・signal_type の NEW シグナルがある (キュー積み済み)
 * 2. 同一 coin・side の NEW 注文がある (未約定)
 * D1 への問い合わせに失敗した場合は検証不能として登録しない
 */
export class DcaEligibilityCheck implements SignalCheck {
  readonly name = "D1 適格性 (DCA: NEWシグナル/NEW注文の重複)";

  constructor(private readonly source: DcaCountsSource) {}

  /** 重複が無ければ通過 */
  async check(signal: TradeSignal): Promise<CheckResult> {
    let counts: DcaExistingCounts;
    try {
      counts = await this.source.fetchDcaCounts(signal);
    } catch (e) {
      return unverifiedFromError("D1 の既存レコードを取得できません", e, "D1");
    }
    if (counts.signalNewCount > 0) {
      return skip("同一銘柄・方向・種別の未処理シグナル (status=NEW) が既に存在します");
    }
    if (counts.orderNewCount > 0) {
      return skip("同一銘柄・方向の未約定注文 (status=NEW) が存在します");
    }
    return PASS;
  }
}
