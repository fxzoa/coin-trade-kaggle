import type { OpenPosition } from "../../shared/domain/dca_rules.ts";
import { type D1Credentials, D1RestClient } from "./d1_rest_client.ts";
import type { FetchLike } from "./fetch_like.ts";
import type { ResilienceOptions } from "./resilience.ts";

/**
 * DCA 判定用に OPEN ポジションを取得する SQL。
 * buyer-worker (side='LONG') と seller-worker (side='SHORT') の POSITIONS_SELECT_ALL_OPEN_* を
 * 1 本にまとめたもの (側の分離は取得後に LONG / SHORT で行う)
 */
export const SELECT_OPEN_POSITIONS_SQL = `
SELECT coin, side, entry_px, size, position_value
FROM positions
WHERE status = 'OPEN'
`.trim();

/** 行を OpenPosition に変換する。LONG / SHORT 以外や銘柄が空の行は null */
function toOpenPosition(row: Record<string, unknown>): OpenPosition | null {
  const coin = typeof row.coin === "string" ? row.coin.trim() : "";
  const side = typeof row.side === "string" ? row.side.trim().toUpperCase() : "";
  if (!coin || (side !== "LONG" && side !== "SHORT")) return null;
  // position_value が NULL・非数のときは 0 (worker の `?? 0` と同じ)
  const positionValue = Number(row.position_value ?? 0);
  return {
    coin,
    side,
    entryPx: Number(row.entry_px),
    positionValue: Number.isFinite(positionValue) ? positionValue : 0,
  };
}

/**
 * D1 REST API で OPEN ポジションを読み取る (読み取り専用)。
 * 一時的な失敗は再試行する。失敗時は AppError を投げる (呼び出し側は前回の値を維持する)
 */
export class D1PositionRepository {
  readonly #client: D1RestClient;

  constructor(credentials: D1Credentials, fetchFn?: FetchLike, resilience?: ResilienceOptions) {
    this.#client = new D1RestClient(credentials, fetchFn, resilience);
  }

  /** status='OPEN' の LONG / SHORT ポジションを全件取得する */
  async fetchOpenPositions(): Promise<OpenPosition[]> {
    const rows = await this.#client.query(SELECT_OPEN_POSITIONS_SQL, []);
    return rows.map(toOpenPosition).filter((p): p is OpenPosition => p !== null);
  }
}
