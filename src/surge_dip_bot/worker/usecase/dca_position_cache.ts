import { type ErrorLogSinks, FailureTransitionLog } from "../../shared/domain/error_log.ts";
import type { OpenPosition } from "../../shared/domain/dca_rules.ts";

/** OPEN ポジションの更新間隔の既定値 (秒) */
export const DEFAULT_DCA_POSITIONS_REFRESH_SECONDS = 60;

/** OPEN ポジションの取得元 (実装は D1PositionRepository) */
export interface PositionSource {
  /** OPEN ポジションを取得する。失敗時は reject */
  fetchOpenPositions(): Promise<OpenPosition[]>;
}

/** DcaPositionCache の依存 */
export interface DcaPositionCacheOptions extends ErrorLogSinks {
  source: PositionSource;
}

/**
 * DCA 判定用の OPEN ポジションのメモリキャッシュ (銘柄 → ポジション一覧)。
 * refresh() を定期的に呼んで入れ替える。取得に失敗しても例外は投げず、
 * 直前の値を保持する (一度も取得できていなければポジション無し = DCA は発火しない)。
 * 失敗のログは状態が変わったときだけ (初回の失敗・種別の変化・回復) 出し、毎回の更新では出さない
 */
export class DcaPositionCache {
  #byCoin = new Map<string, OpenPosition[]>();
  #count = 0;
  readonly #source: PositionSource;
  readonly #failureLog: FailureTransitionLog;

  constructor(options: DcaPositionCacheOptions) {
    this.#source = options.source;
    this.#failureLog = new FailureTransitionLog(options, "D1", "OPEN ポジションの更新");
  }

  /** 保持している OPEN ポジション数 */
  get size(): number {
    return this.#count;
  }

  /** 銘柄の OPEN ポジション (大文字小文字は区別しない)。無ければ空配列 */
  positionsOf(symbol: string): readonly OpenPosition[] {
    return this.#byCoin.get(symbol.toUpperCase()) ?? [];
  }

  /** ポジションを取得し直す。失敗時はログ (状態変化時のみ) だけで、前回の値を維持する */
  async refresh(): Promise<void> {
    try {
      const positions = await this.#source.fetchOpenPositions();
      const byCoin = new Map<string, OpenPosition[]>();
      for (const position of positions) {
        const key = position.coin.toUpperCase();
        byCoin.set(key, [...(byCoin.get(key) ?? []), position]);
      }
      this.#byCoin = byCoin;
      this.#count = positions.length;
      this.#failureLog.succeeded();
    } catch (e) {
      this.#failureLog.failed(e, "OPEN ポジションの更新に失敗しました (前回の値を維持します)");
    }
  }
}
