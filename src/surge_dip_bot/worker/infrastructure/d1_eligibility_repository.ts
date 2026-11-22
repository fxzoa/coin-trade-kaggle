import type { DcaExistingCounts } from "../../shared/domain/dca_rules.ts";
import type {
  ExistingRecords,
  OpenOrderRow,
  PositionRow,
} from "../../shared/domain/signal_eligibility.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import { type D1Credentials, D1RestClient } from "./d1_rest_client.ts";
import type { FetchLike } from "./fetch_like.ts";
import type { ResilienceOptions } from "./resilience.ts";

/**
 * 登録前の重複・再エントリー判定に使う SQL (DCA 用の signalsCountNewByType を含む)。
 * buyer-worker / seller-worker の src/sql.ts と同じ文面 (両 worker で同一)
 */
export const ELIGIBILITY_SQL = {
  /**
   * 同一 coin・side の NEW シグナル件数 (signal_type は問わない)。
   * worker は signal_type も条件にするが、本アプリは二重発注防止のため意図して外している
   */
  signalsCountNew: `
SELECT COUNT(*) as count
FROM signals
WHERE coin = ?
  AND side = ?
  AND status = 'NEW'`.trim(),
  /**
   * 同一 coin・side・signal_type の NEW シグナル件数 (DCA 用)。
   * DCA_40 / DCA_80 は同時に発火し得るため、worker の SIGNALS_COUNT_NEW_BY_TYPE と同じく signal_type 単位で数える
   */
  signalsCountNewByType: `
SELECT COUNT(*) as count
FROM signals
WHERE coin = ?
  AND side = ?
  AND signal_type = ?
  AND status = 'NEW'`.trim(),
  /** 同一 coin・side の NEW 注文件数 */
  ordersCountNew: `
SELECT COUNT(*) as count
FROM orders
WHERE coin = ?
  AND side = ?
  AND status = 'NEW'`.trim(),
  /** 同一 coin・side の OPEN ポジション */
  positionsSelectOpen: `
SELECT id, opened_at, updated_at
FROM positions
WHERE coin = ?
  AND side = ?
  AND status = 'OPEN'
LIMIT 1`.trim(),
  /** positions と positions_history を通した直近の決済済みポジション */
  positionsSelectLatestClosed: `
SELECT id, opened_at, updated_at, closed_at FROM (
  SELECT id, opened_at, updated_at, closed_at
  FROM positions
  WHERE coin = ?
    AND side = ?
    AND status IN ('CLOSE', 'CLOSED')
  UNION ALL
  SELECT id, opened_at, updated_at, closed_at
  FROM positions_history
  WHERE coin = ?
    AND side = ?
    AND status IN ('CLOSE', 'CLOSED')
)
ORDER BY COALESCE(closed_at, updated_at) DESC
LIMIT 1`.trim(),
  /** 同一 coin・side の最新 OPEN 注文 */
  ordersSelectOpen: `
SELECT id, timestamp_jst
FROM orders
WHERE coin = ?
  AND side = ?
  AND status = 'OPEN'
ORDER BY id DESC
LIMIT 1`.trim(),
} as const;

/** COUNT(*) の行から件数を取り出す (行が無ければ 0) */
function countOf(rows: Record<string, unknown>[]): number {
  return Number(rows[0]?.count ?? 0) || 0;
}

/**
 * D1 REST API で、シグナル登録前の既存レコード (NEW シグナル・注文・ポジション) を調べる。
 * 読み取り専用 (一時的な失敗は再試行する)。いずれかの問い合わせが失敗したら AppError を投げる (呼び出し側は登録しない)
 */
export class D1EligibilityRepository {
  readonly #client: D1RestClient;

  constructor(credentials: D1Credentials, fetchFn?: FetchLike, resilience?: ResilienceOptions) {
    this.#client = new D1RestClient(credentials, fetchFn, resilience);
  }

  /** シグナルに対応する既存レコードを 5 つの問い合わせで取得する (まとめて 1 操作として再試行・遮断する) */
  async fetchRecords(signal: TradeSignal): Promise<ExistingRecords> {
    const { symbol: coin, side } = signal;
    const [signalNew, orderNew, openPos, closedPos, openOrder] = await this.#client.queryAll([
      { sql: ELIGIBILITY_SQL.signalsCountNew, params: [coin, side] },
      { sql: ELIGIBILITY_SQL.ordersCountNew, params: [coin, side] },
      { sql: ELIGIBILITY_SQL.positionsSelectOpen, params: [coin, side] },
      { sql: ELIGIBILITY_SQL.positionsSelectLatestClosed, params: [coin, side, coin, side] },
      { sql: ELIGIBILITY_SQL.ordersSelectOpen, params: [coin, side] },
    ]);
    return {
      signalNewCount: countOf(signalNew),
      orderNewCount: countOf(orderNew),
      openPos: (openPos[0] as PositionRow | undefined) ?? null,
      closedPos: (closedPos[0] as PositionRow | undefined) ?? null,
      openOrder: (openOrder[0] as OpenOrderRow | undefined) ?? null,
    };
  }

  /** DCA シグナルに対応する NEW シグナル (signal_type 単位) と NEW 注文の件数を 2 つの問い合わせで取得する (まとめて 1 操作として再試行・遮断する) */
  async fetchDcaCounts(signal: TradeSignal): Promise<DcaExistingCounts> {
    const { symbol: coin, side, signalType } = signal;
    const [signalNew, orderNew] = await this.#client.queryAll([
      { sql: ELIGIBILITY_SQL.signalsCountNewByType, params: [coin, side, signalType] },
      { sql: ELIGIBILITY_SQL.ordersCountNew, params: [coin, side] },
    ]);
    return { signalNewCount: countOf(signalNew), orderNewCount: countOf(orderNew) };
  }
}
