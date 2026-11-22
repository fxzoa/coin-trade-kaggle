import {
  AppError,
  CircuitBreakerError,
  classifyError,
  ERROR_KIND_POLICY,
  type ErrorService,
} from "../../shared/errors.ts";

/** 遮断器の状態 */
export type CircuitState = "closed" | "open" | "half_open";

/** 既定の連続失敗の閾値 */
export const DEFAULT_FAILURE_THRESHOLD = 5;
/** 既定の遮断時間 (ms) */
export const DEFAULT_OPEN_MS = 30_000;

/** CircuitBreaker のオプション */
export interface CircuitBreakerOptions {
  /** 依存先の名前 (ログ・状態変化通知に使う。例: "D1") */
  name: string;
  /** 例外の分類に使う発生元サービス */
  service: ErrorService;
  /** 遮断に至る連続失敗の回数 (既定 5) */
  failureThreshold?: number;
  /** 遮断を続ける時間 (ms。既定 30_000)。経過後に 1 回だけ試行を通す */
  openMs?: number;
  /** 現在時刻 (ms)。テストで差し替える */
  now?: () => number;
  /**
   * 状態が変わるたびに 1 回だけ呼ばれる (遷移ごとに 1 回のアラートを出すために使う)。
   * lastError は直近に記録した失敗 (まだ失敗が無ければ undefined)
   */
  onStateChange?: (
    name: string,
    from: CircuitState,
    to: CircuitState,
    lastError: AppError | undefined,
  ) => void;
}

/**
 * 依存先ごとの遮断器。連続失敗で開き、一定時間は呼び出さずに即座に失敗させて、
 * 障害中の依存先への無駄な呼び出しとログの氾濫を防ぐ。
 *
 * - closed: 通常。連続失敗が閾値に達すると open へ
 * - open: openMs の間は fn を呼ばず circuit_open を投げる。経過後は half_open へ
 * - half_open: 試行 (probe) を 1 件だけ通す。成功なら closed、失敗なら open へ
 *
 * 失敗に数えるのは依存先の不調を示す種別 (network / timeout / server / auth / rate_limit /
 * bad_response) のみ。client・config・unknown と、例外を投げない業務上の見送り (skip) は
 * 失敗に数えず、依存先から応答があったものとして連続失敗を戻す
 */
export class CircuitBreaker {
  readonly name: string;
  readonly #service: ErrorService;
  readonly #failureThreshold: number;
  readonly #openMs: number;
  readonly #now: () => number;
  readonly #onStateChange?: CircuitBreakerOptions["onStateChange"];

  #state: CircuitState = "closed";
  #consecutiveFailures = 0;
  #openedAt = 0;
  #probing = false;
  #lastError: AppError | undefined;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.#service = options.service;
    this.#failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#openMs = options.openMs ?? DEFAULT_OPEN_MS;
    this.#now = options.now ?? Date.now;
    this.#onStateChange = options.onStateChange;
  }

  /** 現在の状態 (open の期限切れは次の execute で half_open へ移る) */
  get state(): CircuitState {
    return this.#state;
  }

  /** fn を実行する。open の間、または half_open で試行中の間は fn を呼ばず circuit_open を投げる */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.#admit();
    try {
      const result = await fn();
      this.#onResponded();
      return result;
    } catch (e) {
      const error = classifyError(e, this.#service);
      if (ERROR_KIND_POLICY[error.kind].infrastructureFailure) {
        this.#onFailure(error);
      } else {
        this.#onResponded();
      }
      throw error;
    }
  }

  /** 呼び出しを通してよいか判定する。通せない場合は circuit_open を投げる */
  #admit(): void {
    if (this.#state === "open") {
      const remainingMs = this.#openedAt + this.#openMs - this.#now();
      if (remainingMs > 0) throw this.#circuitOpenError(remainingMs);
      this.#transition("half_open");
    }
    if (this.#state === "half_open") {
      if (this.#probing) throw this.#circuitOpenError(0);
      this.#probing = true;
    }
  }

  /** 依存先から応答があった (成功、または数えない種別の失敗) */
  #onResponded(): void {
    this.#consecutiveFailures = 0;
    this.#probing = false;
    if (this.#state === "half_open") this.#transition("closed");
  }

  /** 依存先の不調を記録する */
  #onFailure(error: AppError): void {
    this.#lastError = error;
    this.#probing = false;
    // 開く前に開始した呼び出しが遅れて失敗しても、遷移 (と通知) は重複させない
    if (this.#state === "open") return;
    this.#consecutiveFailures++;
    if (this.#state === "half_open" || this.#consecutiveFailures >= this.#failureThreshold) {
      this.#openedAt = this.#now();
      this.#transition("open");
    }
  }

  #transition(to: CircuitState): void {
    const from = this.#state;
    this.#state = to;
    this.#onStateChange?.(this.name, from, to, this.#lastError);
  }

  #circuitOpenError(remainingMs: number): AppError {
    const wait = remainingMs > 0 ? `あと約 ${Math.ceil(remainingMs / 1000)} 秒` : "試行の完了待ち";
    return new CircuitBreakerError(`${this.name} は連続失敗のため遮断中です (${wait})`, {
      service: this.#service,
      cause: this.#lastError,
    });
  }
}
