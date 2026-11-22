import { floorToH4, nextH4Boundary } from "../../shared/domain/h4_time.ts";

/** タイマーの識別子 */
type TimerId = ReturnType<typeof setTimeout>;

/** H4 スケジューラの依存 (テストで差し替える) */
export interface H4SchedulerOptions {
  /** 実行する処理 */
  task: (now: number) => void | Promise<void>;
  /** H4 境界から実行までの遅延 (ms)。足の登録が終わるのを待つ */
  delayMs: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerId;
  clearTimeoutFn?: (id: TimerId) => void;
  /**
   * task が失敗したときに呼ばれる。失敗が続く間は最初の 1 回だけ (状態が変わったときだけ) 通知し、
   * ログの繰り返しを防ぐ。引数の例外は classifyError / formatError で分類・整形すること
   */
  onError: (e: unknown) => void;
  /** 失敗が続いた後に task が成功したときに 1 回だけ呼ばれる */
  onRecover?: () => void;
}

/**
 * H4 の切り替わり (UTC 0/4/8/12/16/20時) + delayMs ごとに task を実行し続ける。
 * 戻り値の関数で停止する。task の失敗は onError に通知して次回に進み、
 * 失敗が続いた後の成功は onRecover に通知する (どちらも状態が変わったときだけ)
 */
export function scheduleAtH4Boundaries(opts: H4SchedulerOptions): () => void {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((id) => clearTimeout(id));
  let timer: TimerId | undefined;
  let stopped = false;
  let failing = false;

  const scheduleNext = () => {
    if (stopped) return;
    const current = now();
    // 今の H4 区間の「境界 + 遅延」がまだ先ならそれ、過ぎていれば次の区間のもの
    const thisRunAt = floorToH4(current) + opts.delayMs;
    const runAt = thisRunAt > current ? thisRunAt : nextH4Boundary(current) + opts.delayMs;
    timer = setTimer(async () => {
      try {
        await opts.task(now());
        if (failing) opts.onRecover?.();
        failing = false;
      } catch (e) {
        if (!failing) opts.onError(e);
        failing = true;
      }
      scheduleNext();
    }, runAt - current);
  };

  scheduleNext();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
}
