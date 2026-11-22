import {
  evaluateSignalEligibility,
  type ExistingRecords,
} from "../../shared/domain/signal_eligibility.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import {
  type CheckResult,
  PASS,
  type SignalCheck,
  skip,
  unverifiedFromError,
} from "./signal_check.ts";

/** 既存レコードの取得元 (実装は D1EligibilityRepository) */
export interface ExistingRecordsSource {
  /** シグナルに対応する NEW シグナル・注文・ポジションを取得する。失敗時は reject */
  fetchRecords(signal: TradeSignal): Promise<ExistingRecords>;
}

/**
 * D1 の既存レコードから、重複・保有中・再エントリー待機中のシグナルをスキップする。
 * 判定本体は domain の evaluateSignalEligibility (buyer / seller の順序のまま)。
 * D1 への問い合わせに失敗した場合は検証不能として登録しない
 */
export class SignalEligibilityCheck implements SignalCheck {
  readonly name = "D1 適格性 (重複/保有中/再エントリー待機)";

  constructor(
    private readonly source: ExistingRecordsSource,
    private readonly now: () => number = Date.now,
  ) {}

  /** 適格なら通過 */
  async check(signal: TradeSignal): Promise<CheckResult> {
    let records: ExistingRecords;
    try {
      records = await this.source.fetchRecords(signal);
    } catch (e) {
      return unverifiedFromError("D1 の既存レコードを取得できません", e, "D1");
    }
    const decision = evaluateSignalEligibility(
      signal.side,
      signal.signalType,
      records,
      this.now(),
    );
    return decision.allow ? PASS : skip(decision.reason);
  }
}
