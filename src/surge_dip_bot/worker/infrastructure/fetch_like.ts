/** fetch 互換の関数 (テストで差し替える) */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 既定の fetch のタイムアウト (ms)。応答が返らない API でティックや後続処理を塞がないため */
export const DEFAULT_FETCH_TIMEOUT_MS = 30 * 1000;

/**
 * 既定の fetch (グローバル fetch へ委譲)。
 * 呼び出し側が signal を指定しない場合は DEFAULT_FETCH_TIMEOUT_MS で打ち切る
 */
export const defaultFetch: FetchLike = (input, init) =>
  fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS) });
