import { REENTRY_AFTER_CLOSE_WINDOW_MS } from "../constants/kv_keys.ts";
import type { SignalSide } from "./trade_signal.ts";
import { err, ok, type Result } from "../result.ts";
import { DomainError } from "../errors.ts";

/** 判定対象の時間軸 (長いものから順に一致を探す) */
const TIMEFRAMES = ["360D", "180D", "90D", "30D", "7D", "24H"] as const;

const HOUR_MS = 60 * 60 * 1000;

/** D1 から取得した保有中・決済済みポジションの行 */
export interface PositionRow {
  id?: number;
  opened_at?: string | number | null;
  updated_at?: string | number | null;
  closed_at?: string | number | null;
}

/** D1 から取得した OPEN 注文の行 */
export interface OpenOrderRow {
  id?: number;
  timestamp_jst?: string | number | null;
}

/** シグナル登録前に D1 から集める既存レコード */
export interface ExistingRecords {
  /** 同一 coin・side の NEW シグナル件数 (signal_type は問わない) */
  signalNewCount: number;
  /** 同一 coin・side の NEW 注文件数 */
  orderNewCount: number;
  /** 同一 coin・side の OPEN ポジション (無ければ null) */
  openPos: PositionRow | null;
  /** positions と positions_history を通した直近の決済済みポジション (無ければ null) */
  closedPos: PositionRow | null;
  /** 同一 coin・side の最新 OPEN 注文 (無ければ null) */
  openOrder: OpenOrderRow | null;
}

/** 適格性判定の結果分類 */
export type EligibilityCategory =
  | "ALLOW_NEW"
  | "ALLOW_CLOSED_EXPIRED"
  | "SKIP_SIGNAL_NEW"
  | "SKIP_ORDER_NEW"
  | "SKIP_OPEN_POSITION"
  | "SKIP_OPEN_ORDER_YOUNG"
  | "SKIP_CLOSED_UNEXPIRED";

/** 適格性判定の結果 */
export interface EligibilityDecision {
  allow: boolean;
  category: EligibilityCategory;
  reason: string;
}

/** signal_type 文字列から時間軸 (24H〜360D) を取り出す。無ければ空文字 */
export function extractTimeframe(signalType: string): string {
  const upper = (signalType || "").toUpperCase();
  return TIMEFRAMES.find((tf) => upper.includes(tf)) ?? "";
}

/** タイムゾーン表記のない 'YYYY-MM-DD HH:MM[:SS[.sss]]' (区切りは空白または T) */
const ZONELESS_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * DB の日時をエポックミリ秒にする (buyer/seller-worker の parseDbTimestampMs と同一の解釈)。
 * - 数値はそのまま返す
 * - タイムゾーン表記のない文字列は JST (+09:00) として解釈する (実行環境の TZ に依存しない)
 * - ' JST' 接尾辞付き、および ISO 8601 (Z / オフセット付き) はそのまま解釈する
 * 解釈できなければ null
 */
export function parseDbTimestampMs(ts: unknown): number | null {
  if (!ts) return null;
  if (typeof ts === "number") return ts;
  const str = String(ts).trim();
  const normalized = ZONELESS_TIMESTAMP_PATTERN.test(str)
    ? `${str.replace(" ", "T")}+09:00`
    : str.replace(" JST", "+09:00");
  const parsed = Date.parse(normalized);
  return isNaN(parsed) ? null : parsed;
}

/** ミリ秒を小数 1 桁の時間にする */
function toHours(ms: number): number {
  return Number((ms / HOUR_MS).toFixed(1));
}

/**
 * 決済済みポジションによる判定。決済から固定待機期間 (24h) を超えていれば許可、
 * 以内ならスキップ。決済時刻が解釈できなければ許可する (両 worker 共通)
 */
function decideByClosedPosition(
  closedPos: PositionRow,
  timeframe: string,
  nowMs: number,
): EligibilityDecision {
  const closeMs = parseDbTimestampMs(
    closedPos.closed_at || closedPos.updated_at || closedPos.opened_at,
  );
  if (!closeMs) {
    return {
      allow: true,
      category: "ALLOW_CLOSED_EXPIRED",
      reason: "決済時刻を解釈できないため許可",
    };
  }
  const elapsedMs = nowMs - closeMs;
  const required = toHours(REENTRY_AFTER_CLOSE_WINDOW_MS);
  if (elapsedMs > REENTRY_AFTER_CLOSE_WINDOW_MS) {
    return {
      allow: true,
      category: "ALLOW_CLOSED_EXPIRED",
      reason: `決済後の固定待機期間 (${required}h) を経過済み ` +
        `(種別: ${timeframe}, 経過: ${toHours(elapsedMs)}h)`,
    };
  }
  return {
    allow: false,
    category: "SKIP_CLOSED_UNEXPIRED",
    reason: `決済後の固定待機期間 (${required}h) が未経過 ` +
      `(種別: ${timeframe}, 経過: ${toHours(elapsedMs)}h, ` +
      `残り約${toHours(REENTRY_AFTER_CLOSE_WINDOW_MS - elapsedMs)}h)`,
  };
}

/**
 * OPEN 注文による判定。注文時刻から固定待機期間 (24h) が未経過ならスキップ (null なら判定なし)。
 * 経過の境界は worker により異なる: BUY は 24h 未満、SELL は 24h 以下をスキップとする
 */
function decideByOpenOrder(
  openOrder: OpenOrderRow,
  timeframe: string,
  nowMs: number,
  inclusiveBoundary: boolean,
): EligibilityDecision | null {
  const orderMs = parseDbTimestampMs(openOrder.timestamp_jst);
  if (!orderMs) return null;
  const elapsedMs = nowMs - orderMs;
  const young = inclusiveBoundary
    ? elapsedMs <= REENTRY_AFTER_CLOSE_WINDOW_MS
    : elapsedMs < REENTRY_AFTER_CLOSE_WINDOW_MS;
  if (!young) return null;
  return {
    allow: false,
    category: "SKIP_OPEN_ORDER_YOUNG",
    reason: `OPEN 注文があり固定待機期間 (${toHours(REENTRY_AFTER_CLOSE_WINDOW_MS)}h) が未経過 ` +
      `(種別: ${timeframe}, 経過: ${toHours(elapsedMs)}h, ` +
      `残り約${toHours(REENTRY_AFTER_CLOSE_WINDOW_MS - elapsedMs)}h)`,
  };
}

/**
 * 既存レコードからシグナル登録の可否を判定する純粋関数。
 * buyer-worker (LONG) と seller-worker (SHORT) の判定を、それぞれの順序のまま移植している。
 *
 * 共通: NEW シグナル → NEW 注文 → OPEN ポジション (無条件スキップ) の順に判定する。
 * 以降の順序と境界が異なる:
 * - LONG (buyer):  OPEN 注文 (24h 未満でスキップ) → 決済済みポジション (24h 以内でスキップ)
 * - SHORT (seller): 決済済みポジション (24h 以内でスキップ) → OPEN 注文 (24h 以下でスキップ)。
 *   決済済みポジションがあれば、その判定結果が OPEN 注文より優先される
 */
export function evaluateSignalEligibility(
  side: SignalSide,
  signalType: string,
  records: ExistingRecords,
  nowMs: number,
): EligibilityDecision {
  const { signalNewCount, orderNewCount, openPos, closedPos, openOrder } = records;
  const timeframe = extractTimeframe(signalType);

  if (signalNewCount > 0) {
    return {
      allow: false,
      category: "SKIP_SIGNAL_NEW",
      reason: "同一銘柄・方向の未処理シグナル (status=NEW) が既に存在します (種別は問わない)",
    };
  }
  if (orderNewCount > 0) {
    return {
      allow: false,
      category: "SKIP_ORDER_NEW",
      reason: "同一銘柄・方向の未約定注文 (status=NEW) が存在します",
    };
  }
  if (openPos) {
    return {
      allow: false,
      category: "SKIP_OPEN_POSITION",
      reason: `未決済ポジション保有中のため通常エントリーはスキップ (種別: ${timeframe})`,
    };
  }

  if (side === "LONG") {
    const byOrder = openOrder ? decideByOpenOrder(openOrder, timeframe, nowMs, false) : null;
    if (byOrder) return byOrder;
    if (closedPos) return decideByClosedPosition(closedPos, timeframe, nowMs);
  } else {
    if (closedPos) return decideByClosedPosition(closedPos, timeframe, nowMs);
    const byOrder = openOrder ? decideByOpenOrder(openOrder, timeframe, nowMs, true) : null;
    if (byOrder) return byOrder;
  }

  return {
    allow: true,
    category: "ALLOW_NEW",
    reason: "既存ポジション・未約定注文なし (完全新規)",
  };
}

/**
 * Result-based signal eligibility evaluation.
 */
export function checkSignalEligibilityResult(
  side: SignalSide,
  signalType: string,
  records: ExistingRecords,
  nowMs: number = Date.now(),
): Result<EligibilityDecision, DomainError> {
  if (side !== "LONG" && side !== "SHORT") {
    return err(new DomainError(`Invalid side: ${side}`));
  }
  return ok(evaluateSignalEligibility(side, signalType, records, nowMs));
}

