import { type ErrorLogSinks, FailureTransitionLog } from "../../shared/domain/error_log.ts";
import type { KvReader } from "../../shared/domain/ports.ts";

/** キャッシュ 1 件 (値または失敗の Promise と期限) */
interface CacheEntry {
  expiresAt: number;
  promise: Promise<string | null>;
}

/**
 * KvReader に短い TTL のキャッシュを被せる。
 * ティックごとに API を叩かないための仕組みで、同時に来た同一キーの取得は 1 回にまとめる。
 * 失敗も TTL の間は保持する (API が不調のときに再試行を連打しないため)。
 * sinks を渡すと、取得の失敗を「状態が変わったときだけ」(初回・種別の変化・回復) ログに出す
 */
export class CachedKvReader implements KvReader {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #failureLog: FailureTransitionLog | null;

  constructor(
    private readonly inner: KvReader,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    sinks?: ErrorLogSinks,
  ) {
    this.#failureLog = sinks ? new FailureTransitionLog(sinks, "KV", "KV の取得") : null;
  }

  /** TTL 内ならキャッシュから、そうでなければ元の KvReader から値を返す */
  get(key: string): Promise<string | null> {
    const now = this.now();
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = this.inner.get(key).then(
      (value) => {
        this.#failureLog?.succeeded();
        return value;
      },
      (e: unknown) => {
        this.#failureLog?.failed(
          e,
          "KV の値を取得できません (チェックは検証不能として登録を見送ります)",
        );
        throw e;
      },
    );
    this.#cache.set(key, { expiresAt: now + this.ttlMs, promise });
    // 未処理の reject 警告を避ける (呼び出し側が await して受け取る)
    promise.catch(() => {});
    return promise;
  }
}
