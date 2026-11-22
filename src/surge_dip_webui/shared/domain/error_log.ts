import {
  classifyError,
  type ErrorKind,
  type ErrorLogLevel,
  type ErrorService,
  formatError,
  logLevelOf,
} from "./app_error.ts";

/** ログの出力先。onLog は warn、onError は error、onInfo は info に対応する (省略時は onLog へ) */
export interface ErrorLogSinks {
  /** 警告ログ (一時的で自動回復し得るもの) */
  onLog: (msg: string) => void;
  /** エラーログ (人の対応が要るもの) */
  onError?: (msg: string) => void;
  /** 情報ログ (回復の通知など) */
  onInfo?: (msg: string) => void;
}

/** レベルに応じた出力先へメッセージを出す。出力先が未指定のレベルは onLog に寄せる */
export function logAtLevel(
  sinks: ErrorLogSinks,
  level: ErrorLogLevel | "info",
  message: string,
): void {
  const sink = level === "error" ? sinks.onError : level === "info" ? sinks.onInfo : undefined;
  (sink ?? sinks.onLog)(message);
}

/**
 * 失敗を 1 行で出す: `[サービス/種別] 要約 (原因: ..., 対処: ...) - 状況`。
 * レベルは種別の推奨 (logLevelOf) に従う。識別子・認証情報は formatError が伏せる
 */
export function logFailure(
  sinks: ErrorLogSinks,
  e: unknown,
  service: ErrorService,
  context: string,
): void {
  const error = classifyError(e, service);
  logAtLevel(sinks, logLevelOf(error), `${formatError(error)} - ${context}`);
}

/**
 * 定期処理の失敗ログを「状態が変わったときだけ」に絞る。
 * 同じ種別の失敗が続く間は 2 回目以降を出さず (種別が変わったときだけ再度出す)、
 * 失敗の後の最初の成功で回復を 1 回だけ出す。遮断器による circuit_open は遮断器側が通知済みのため無視する
 */
export class FailureTransitionLog {
  #lastKind: ErrorKind | undefined;

  /**
   * @param subject 回復ログの主語 (例: "OPEN ポジションの更新")
   */
  constructor(
    private readonly sinks: ErrorLogSinks,
    private readonly service: ErrorService,
    private readonly subject: string,
  ) {}

  /** 失敗を通知する。初回または種別が変わったときだけログを出す */
  failed(e: unknown, context: string): void {
    const error = classifyError(e, this.service);
    if (error.kind === "circuit_open" || error.kind === this.#lastKind) return;
    this.#lastKind = error.kind;
    logFailure(this.sinks, error, this.service, context);
  }

  /** 成功を通知する。直前まで失敗していた場合だけ回復ログを出す */
  succeeded(): void {
    if (this.#lastKind === undefined) return;
    this.#lastKind = undefined;
    logAtLevel(this.sinks, "info", `${this.subject}が回復しました`);
  }
}
