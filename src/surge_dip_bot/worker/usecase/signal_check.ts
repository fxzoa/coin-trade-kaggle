import {
  classifyError,
  type ErrorKind,
  type ErrorService,
  formatError,
} from "../../shared/errors.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";

/**
 * 登録前チェックの結果。
 * - ok: 通過
 * - skip: 条件によりスキップ (正常な見送り)
 * - unverified: 状態を取得できず検証できない (安全のため登録しない)
 */
export type CheckResult =
  | { ok: true }
  | { ok: false; kind: "skip"; reason: string }
  | { ok: false; kind: "unverified"; reason: string; errorKind?: ErrorKind };

/** 通過 */
export const PASS: CheckResult = { ok: true };

/** 条件によるスキップ */
export function skip(reason: string): CheckResult {
  return { ok: false, kind: "skip", reason };
}

/** 検証不能 (取得失敗)。登録は行わない。errorKind は失敗の種別 (ログの出し分けに使う) */
export function unverified(reason: string, errorKind?: ErrorKind): CheckResult {
  return { ok: false, kind: "unverified", reason, errorKind };
}

/**
 * 取得失敗を検証不能の結果にする。理由は `${subject}: ${formatError}` の日本語 1 行。
 * 遮断器が開いている (circuit_open) 場合は、障害の詳細を繰り返さない静かな理由にする
 * (遮断器が状態変化時に通知済みのため)
 * @param subject 何を取得できなかったか (例: "最小取引高を KV から読み取れません")
 */
export function unverifiedFromError(
  subject: string,
  e: unknown,
  service: ErrorService,
): CheckResult {
  const error = classifyError(e, service);
  const reason = error.kind === "circuit_open"
    ? `${error.service} への接続を一時停止中のため検証できません`
    : `${subject}: ${formatError(error)}`;
  return unverified(reason, error.kind);
}

/** シグナル登録前の 1 つのチェック。SignalRegistrar が順に実行する */
export interface SignalCheck {
  /** ログに出すチェック名 */
  readonly name: string;
  /** シグナルがこのチェックを通過するか判定する (例外は投げず unverified を返す) */
  check(signal: TradeSignal): Promise<CheckResult>;
}
