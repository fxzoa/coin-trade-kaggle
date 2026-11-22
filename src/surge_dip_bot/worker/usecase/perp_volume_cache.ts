import { type ErrorLogSinks, FailureTransitionLog } from "../../shared/domain/error_log.ts";
import type { VolumeLookup } from "../../shared/domain/ports.ts";

/** 取引高の更新間隔の既定値 (ms) */
export const DEFAULT_VOLUME_REFRESH_MS = 60 * 1000;

/** 取引高の取得元 (実装は PerpVolumeClient) */
export interface VolumeSource {
  /** 銘柄名 → 24H 取引高 (USD) を取得する。失敗時は reject */
  fetchVolumes(): Promise<Map<string, number>>;
}

/** PerpVolumeCache の依存 */
export interface PerpVolumeCacheOptions extends ErrorLogSinks {
  source: VolumeSource;
}

/**
 * 銘柄別の 24H 取引高のメモリキャッシュ。
 * refresh() を定期的に呼んで入れ替える。取得に失敗しても例外は投げず、
 * 直前の値を保持する (一度も取得できていなければ全銘柄が未取得 = 登録しない)。
 * 失敗のログは状態が変わったときだけ (初回の失敗・種別の変化・回復) 出し、毎回の更新では出さない
 */
export class PerpVolumeCache implements VolumeLookup {
  #volumes = new Map<string, number>();
  readonly #source: VolumeSource;
  readonly #failureLog: FailureTransitionLog;

  constructor(options: PerpVolumeCacheOptions) {
    this.#source = options.source;
    this.#failureLog = new FailureTransitionLog(options, "HyperliquidInfo", "24H 取引高の更新");
  }

  /** 取得済みの銘柄数 */
  get size(): number {
    return this.#volumes.size;
  }

  /** 銘柄の 24H 取引高 (USD)。未取得なら undefined */
  get(symbol: string): number | undefined {
    return this.#volumes.get(symbol);
  }

  /** 取引高を取得し直す。失敗時はログ (状態変化時のみ) だけで、前回の値を維持する */
  async refresh(): Promise<void> {
    try {
      this.#volumes = await this.#source.fetchVolumes();
      this.#failureLog.succeeded();
    } catch (e) {
      this.#failureLog.failed(e, "24H 取引高の更新に失敗しました (前回の値を維持します)");
    }
  }
}
