import type { TradeSignal } from "../../shared/domain/trade_signal.ts";

import { type D1Credentials, D1RestClient } from "./d1_rest_client.ts";
import type { FetchLike } from "./fetch_like.ts";
import type { ResilienceOptions } from "./resilience.ts";

export type { D1Credentials, FetchLike };

/**
 * signals テーブルへ NEW シグナルを 1 行挿入する SQL。
 * (coin, side, signal_type) WHERE status='NEW' の部分一意インデックスに加え、
 * NOT EXISTS で同一 coin・side の NEW 行があれば signal_type に関わらず挿入しない。
 * 列と INSERT OR IGNORE の意味は buyer-worker / seller-worker の SIGNALS_INSERT_NEW と同じだが、
 * 重複判定は signal_type を含めない (意図した差異: signal_type 違いの NEW が並び二重発注になるのを防ぐ)
 */
export const INSERT_SIGNAL_SQL = `
INSERT OR IGNORE INTO signals (
  coin, side, price, signal_type, source, status, target_size, change_pct
)
SELECT ?, ?, ?, ?, ?, 'NEW', ?, ?
WHERE NOT EXISTS (
  SELECT 1 FROM signals WHERE coin = ? AND side = ? AND status = 'NEW'
)
`.trim();

/**
 * DCA (ナンピン) シグナル用の INSERT 文。
 * buyer-worker / seller-worker の SIGNALS_INSERT_NEW_DCA と同じ文面で、重複は
 * (coin, side, signal_type) WHERE status='NEW' の部分一意インデックスのみで無視する
 * (DCA_40 / DCA_80 の同時登録を許容する。通常エントリーの coin・side 単位の NOT EXISTS は使わない)
 */
export const INSERT_DCA_SIGNAL_SQL = `
INSERT OR IGNORE INTO signals (
  coin, side, price, signal_type, source, status, target_size, change_pct
) VALUES (?, ?, ?, ?, ?, 'NEW', ?, ?)
`.trim();

/** 登録するシグナルの種類 (重複判定の粒度が異なる) */
export type SignalInsertKind = "ENTRY" | "DCA";

/**
 * Cloudflare D1 の REST API 経由で signals テーブルへシグナルを登録する。
 * open-queue には触れない (通知は OpenQueuePublisher の責務)。
 * INSERT は再試行しない (二重登録を避ける)。失敗時は AppError を投げる (呼び出し側で握りつぶす)
 */
export class D1SignalRepository {
  readonly #client: D1RestClient;
  readonly #kind: SignalInsertKind;

  /**
   * @param kind ENTRY (既定): 同一 coin・side の NEW 行があれば挿入しない。
   *             DCA: 同一 (coin, side, signal_type) の NEW 行があるときだけ挿入しない
   */
  constructor(
    credentials: D1Credentials,
    fetchFn?: FetchLike,
    kind: SignalInsertKind = "ENTRY",
    resilience?: ResilienceOptions,
  ) {
    this.#client = new D1RestClient(credentials, fetchFn, resilience);
    this.#kind = kind;
  }

  /**
   * シグナルを NEW として登録する (重複の粒度は kind による)。
   * @returns 実際に行が挿入されたら true、IGNORE された (既存の NEW 行があった) なら false
   */
  async insert(signal: TradeSignal): Promise<boolean> {
    const columns = [
      signal.symbol,
      signal.side,
      signal.price,
      signal.signalType,
      signal.source,
      signal.targetSize,
      signal.changePct ?? null,
    ];
    const { changes } = this.#kind === "DCA"
      ? await this.#client.write(INSERT_DCA_SIGNAL_SQL, columns)
      : await this.#client.write(INSERT_SIGNAL_SQL, [...columns, signal.symbol, signal.side]);
    return changes > 0;
  }
}
