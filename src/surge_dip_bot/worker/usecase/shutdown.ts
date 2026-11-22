import { formatError } from "../../shared/errors.ts";

/** 既定の実行中タスクの完了待ち時間 (ms) */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/** 既定の終了フック 1 件あたりの制限時間 (ms) */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** 終了時に実行する後始末 */
export type ShutdownHook = () => void | Promise<void>;

/** ShutdownCoordinator のオプション */
export interface ShutdownCoordinatorOptions {
  /** 実行中タスクの完了を待つ上限 (ms。既定 10_000) */
  drainTimeoutMs?: number;
  /** 終了フック 1 件あたりの上限 (ms。既定 5_000) */
  hookTimeoutMs?: number;
  /** 待機する関数 (テストで差し替える) */
  sleep?: (ms: number) => Promise<void>;
  /** 現在時刻 (ms)。所要時間の計測に使う */
  now?: () => number;
  /** 進捗ログの出力先 (日本語メッセージ) */
  onLog?: (message: string) => void;
}

/** 失敗した後始末 1 件 */
export interface ShutdownFailure {
  /** フック名 */
  name: string;
  /** ログ用に整形したエラー (識別子・認証情報は伏せ済み) */
  message: string;
}

/** 終了処理の結果 */
export interface ShutdownSummary {
  /** 終了の理由 (例: "SIGINT") */
  reason: string;
  /** プロセスの終了コード (0: 正常、1: フックの失敗・タイムアウトまたは完了待ちの打ち切り) */
  exitCode: 0 | 1;
  /** 実行中タスクが制限時間内にすべて完了したか */
  drained: boolean;
  /** 打ち切った (完了を待てなかった) タスクの数 */
  abandonedTasks: number;
  /** 失敗した終了フック */
  failures: ShutdownFailure[];
  /** 所要時間 (ms) */
  durationMs: number;
}

/** 終了処理の結果を 1 行の日本語ログにする (完了待ちの結果・打ち切り数・失敗したフック・所要時間) */
export function formatShutdownSummary(summary: ShutdownSummary): string {
  const failures = summary.failures.length > 0
    ? ` 失敗したフック: ${summary.failures.map((f) => f.name).join(", ")}`
    : "";
  return `終了サマリー: 理由=${summary.reason} ` +
    `完了待ち=${summary.drained ? "完了" : "時間切れ"} 打ち切り=${summary.abandonedTasks}件 ` +
    `フック失敗=${summary.failures.length}件 所要時間=${summary.durationMs}ms ` +
    `終了コード=${summary.exitCode}${failures}`;
}

/** 制限時間の超過を示す印 */
const TIMED_OUT: unique symbol = Symbol("timed_out");

/** 既定の待機 (setTimeout) */
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 終了処理の調整役。純粋なロジックのみを持ち、シグナルの受信はしない
 * (受信は infrastructure/signal_handlers.ts)。
 *
 * 手順: 新規受付の停止 → 実行中タスクの完了待ち (drainTimeoutMs まで) →
 * 登録の逆順 (LIFO) で終了フックを実行 (各フックは例外・時間超過を隔離)。
 * shutdown は冪等で、2 回目以降は同じ結果を返す
 */
export class ShutdownCoordinator {
  readonly #drainTimeoutMs: number;
  readonly #hookTimeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #hooks: { name: string; hook: ShutdownHook }[] = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  #result: Promise<ShutdownSummary> | undefined;

  constructor(options: ShutdownCoordinatorOptions = {}) {
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.#hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
    this.#log = options.onLog ?? (() => {});
  }

  /** 終了処理が始まっており、新しい処理を受け付けてはならないか */
  get shuttingDown(): boolean {
    return this.#result !== undefined;
  }

  /** 実行中の追跡対象タスクの数 */
  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  /** 終了フックを登録する。実行は登録の逆順 (後に登録したものが先) */
  register(name: string, hook: ShutdownHook): void {
    this.#hooks.push({ name, hook });
  }

  /**
   * 実行中として追跡する。渡した Promise をそのまま返す (呼び出し側は従来どおり await / catch できる)。
   * 追跡側では失敗を握りつぶし、完了待ちの対象としてのみ扱う
   */
  track<T>(task: Promise<T>): Promise<T> {
    const settled = task.then(() => {}, () => {}).finally(() => this.#inFlight.delete(settled));
    this.#inFlight.add(settled);
    return task;
  }

  /** 終了処理を行い、結果 (終了コードを含む) を返す。冪等 */
  shutdown(reason: string): Promise<ShutdownSummary> {
    this.#result ??= this.#run(reason);
    return this.#result;
  }

  async #run(reason: string): Promise<ShutdownSummary> {
    const startedAt = this.#now();
    this.#log(`終了処理を開始します (理由: ${reason})`);

    const pending = this.#inFlight.size;
    const drained = await this.#drain();
    const abandonedTasks = drained ? 0 : this.#inFlight.size;
    if (pending > 0) {
      this.#log(
        drained
          ? `実行中の処理 ${pending} 件が完了しました`
          : `実行中の処理 ${abandonedTasks} 件が ${this.#drainTimeoutMs}ms 以内に完了しませんでした。打ち切ります`,
      );
    }

    const failures = await this.#runHooks();
    const exitCode = failures.length > 0 || !drained ? 1 : 0;
    const durationMs = this.#now() - startedAt;
    this.#log(
      `終了処理を完了しました (${durationMs}ms、失敗 ${failures.length} 件、終了コード ${exitCode})`,
    );
    return { reason, exitCode, drained, abandonedTasks, failures, durationMs };
  }

  /** 実行中タスクの完了を drainTimeoutMs まで待つ。時間内に終われば true */
  async #drain(): Promise<boolean> {
    if (this.#inFlight.size === 0) return true;
    const all = Promise.all([...this.#inFlight]).then(() => true);
    return (await this.#withTimeout(all, this.#drainTimeoutMs)) === true;
  }

  /** 終了フックを LIFO で順に実行し、失敗を集める */
  async #runHooks(): Promise<ShutdownFailure[]> {
    const failures: ShutdownFailure[] = [];
    for (const { name, hook } of [...this.#hooks].reverse()) {
      try {
        const outcome = await this.#withTimeout(Promise.resolve().then(hook), this.#hookTimeoutMs);
        if (outcome === TIMED_OUT) {
          failures.push({ name, message: `${this.#hookTimeoutMs}ms 以内に完了しませんでした` });
          this.#log(`終了フック ${name} がタイムアウトしました`);
        }
      } catch (e) {
        const message = formatError(e);
        failures.push({ name, message });
        this.#log(`終了フック ${name} が失敗しました: ${message}`);
      }
    }
    return failures;
  }

  /** task を ms まで待つ。超過したら TIMED_OUT を返す (task の例外はそのまま伝える) */
  async #withTimeout<T>(task: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    return await Promise.race([task, this.#sleep(ms).then((): typeof TIMED_OUT => TIMED_OUT)]);
  }
}
