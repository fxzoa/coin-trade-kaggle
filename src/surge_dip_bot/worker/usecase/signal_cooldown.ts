import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import { type CheckResult, PASS, type SignalCheck, skip } from "./signal_check.ts";

/** 銘柄ごとのクールダウンの既定値 (秒)。worker の DEFAULT_COOLDOWN_SECONDS と同じ */
export const DEFAULT_COOLDOWN_SECONDS = 60;

/** SignalCooldown の差し替え可能な設定 */
export interface SignalCooldownOptions {
  /** クールダウンの単位を決めるキー。既定は (銘柄・方向) */
  keyOf?: (signal: TradeSignal) => string;
  /** ログに出すチェック名。既定は「銘柄クールダウン」 */
  name?: string;
}

/**
 * 銘柄 × 売買方向ごとのクールダウン (メモリ上)。keyOf を渡すと単位を変えられる (DCA は種別単位)。
 * worker は銘柄ごとに KV へ期限を記録し、適格と判定されたシグナルの後で更新する。
 * 同様に、全チェックを通過したシグナルについて mark() を呼ぶことで期限を記録する
 * (buyer と seller は別々に管理されるため、売買方向もキーに含める)
 */
export class SignalCooldown implements SignalCheck {
  readonly name: string;
  readonly #until = new Map<string, number>();
  readonly #keyOf: (signal: TradeSignal) => string;

  constructor(
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
    options: SignalCooldownOptions = {},
  ) {
    this.name = options.name ?? "銘柄クールダウン";
    this.#keyOf = options.keyOf ?? symbolSideKey;
  }

  /** クールダウン中ならスキップ */
  check(signal: TradeSignal): Promise<CheckResult> {
    const until = this.#until.get(this.#keyOf(signal));
    return Promise.resolve(
      until !== undefined && until > this.now()
        ? skip(`クールダウン中です (残り約${Math.ceil((until - this.now()) / 1000)}秒)`)
        : PASS,
    );
  }

  /** シグナルを処理した時点からクールダウンを開始する (期限切れの記録は掃除する) */
  mark(signal: TradeSignal): void {
    const now = this.now();
    for (const [key, until] of this.#until) {
      if (until <= now) this.#until.delete(key);
    }
    this.#until.set(this.#keyOf(signal), now + this.cooldownMs);
  }
}

/** 既定のクールダウンのキー (銘柄・方向) */
function symbolSideKey(signal: TradeSignal): string {
  return `${signal.symbol}|${signal.side}`;
}
