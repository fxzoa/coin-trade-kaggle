import { DatabaseSync } from "node:sqlite";
import { AppError, classifyError, RepositoryError } from "../errors.ts";
import type { Candle } from "../domain/candle.ts";
import type { PriceRange } from "../domain/price_range.ts";
import { RedisCandleRepository } from "./redis_candle_repository.ts";

/** ローソク足の保存先 */
export interface CandleRepository {
  /** 複数本をまとめて保存する (同一 symbol + openTime は上書き) */
  upsertMany(candles: Candle[]): void;
  /** 銘柄ごとの保存本数 */
  count(symbol: string): number;
  /**
   * 銘柄ごと・期間ごとの最高値/最低値を集計する。
   * `since` は期間ラベル → 集計開始時刻 (ms, open_time の下限)。足が無い期間は null
   */
  aggregateRanges(since: Record<string, number>): Map<string, Record<string, PriceRange | null>>;
  /**
   * 銘柄ごと・期間ごとの最古足の始値 (open) を集計する。足が無い期間は null
   */
  aggregateOpenPrices(since: Record<string, number>): Map<string, Record<string, number | null>>;
  /** 銘柄ごとの最新足の open_time (ms) */
  latestOpenTimes(): Map<string, number>;
  close(): void;
}

/** 一時的な競合 (他プロセスの書き込み中など) を示す SQLite のメッセージ */
const SQLITE_BUSY_MESSAGE = /database (?:table )?is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i;

/** ファイルの欠落・破損・権限など、設定側の対処が要る SQLite のメッセージ */
const SQLITE_FILE_MESSAGE =
  /unable to open|not a database|malformed|corrupt|no such table|readonly database|SQLITE_CANTOPEN|SQLITE_NOTADB|SQLITE_CORRUPT/i;

/**
 * SQLite の例外を AppError (service: SQLite) へ分類する。
 */
export function classifySqliteError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const base = classifyError(e, "SQLite");
  if (SQLITE_BUSY_MESSAGE.test(base.message)) {
    return new RepositoryError(base.message, {
      kind: "server",
      service: "SQLite",
      hint: "他のプロセスが DB を使用中です。時間をおいて自動で再試行します",
      cause: e,
      code: "SQLITE_BUSY",
    });
  }
  if (SQLITE_FILE_MESSAGE.test(base.message)) {
    return new RepositoryError(base.message, {
      kind: "config",
      service: "SQLite",
      hint: "HL_DB_PATH のファイルの存在・権限・破損を確認し、backfill で再作成してください",
      cause: e,
      code: "SQLITE_FILE_ERROR",
    });
  }
  return base;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS candles_h4 (
  symbol TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  close_time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  trades INTEGER NOT NULL,
  PRIMARY KEY (symbol, open_time)
);
CREATE INDEX IF NOT EXISTS idx_candles_h4_symbol_open_time ON candles_h4 (symbol, open_time);
`;

const UPSERT = `
INSERT INTO candles_h4 (symbol, open_time, close_time, open, high, low, close, volume, trades)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (symbol, open_time) DO UPDATE SET
  close_time = excluded.close_time,
  open = excluded.open,
  high = excluded.high,
  low = excluded.low,
  close = excluded.close,
  volume = excluded.volume,
  trades = excluded.trades;
`;

function buildRangeSql(labels: string[]): string {
  const parts = labels.map(
    (_, i) =>
      `MAX(CASE WHEN open_time >= ? THEN high END) AS h${i}, ` +
      `MIN(CASE WHEN open_time >= ? THEN low END) AS l${i}`,
  );
  return `SELECT symbol, ${parts.join(", ")} FROM candles_h4 WHERE open_time >= ? GROUP BY symbol`;
}

function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw classifySqliteError(e);
  }
}

import { KvCandleRepository } from "./kv_candle_repository.ts";

/**
 * リポジトリを開く。
 * CANDLE_STORE=kv または KV_PATH 指定時は KvCandleRepository を返す。
 * path が "redis" または REDIS_ENABLED の場合、RedisCandleRepository を返す。
 */
export function openCandleRepository(
  path: string = "redis",
  options: { readOnly?: boolean } = {},
): CandleRepository {
  const storeType = Deno.env.get("CANDLE_STORE");
  if (storeType === "kv" || path === "kv" || Deno.env.get("KV_PATH") !== undefined) {
    const kvPath = Deno.env.get("KV_PATH") || "./data/kv.sqlite";
    return new KvCandleRepository(kvPath);
  }

  // "redis" または SQLite ファイルが存在しない/Redis 指定の場合は Redis 実装を使用
  if (path === "redis" || path.startsWith("redis://") || Deno.env.get("CANDLE_STORE") === "redis" || !path.endsWith(".sqlite")) {
    return new RedisCandleRepository();
  }

  const { db, upsert, countStmt } = guarded(() => {
    const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    try {
      if (!options.readOnly) db.exec(CREATE_TABLE);
      return {
        db,
        upsert: db.prepare(UPSERT),
        countStmt: db.prepare("SELECT COUNT(*) AS n FROM candles_h4 WHERE symbol = ?"),
      };
    } catch (e) {
      db.close();
      throw e;
    }
  });

  const upsertMany = (candles: Candle[]): void => {
    db.exec("BEGIN");
    try {
      for (const c of candles) {
        upsert.run(
          c.symbol,
          c.openTime,
          c.closeTime,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          c.trades,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  const latestOpenTimes = (): Map<string, number> => {
    const rows = db.prepare(
      "SELECT symbol, MAX(open_time) AS t FROM candles_h4 GROUP BY symbol",
    ).all() as { symbol: string; t: number | bigint }[];
    return new Map(rows.map((r) => [r.symbol, Number(r.t)]));
  };

  const aggregateRanges = (
    since: Record<string, number>,
  ): Map<string, Record<string, PriceRange | null>> => {
    const labels = Object.keys(since);
    const result = new Map<string, Record<string, PriceRange | null>>();
    if (labels.length === 0) return result;
    const params = labels.flatMap((l) => [since[l], since[l]]);
    const earliest = Math.min(...Object.values(since));
    const rows = db.prepare(buildRangeSql(labels)).all(...params, earliest) as Record<
      string,
      string | number | null
    >[];
    for (const row of rows) {
      const ranges: Record<string, PriceRange | null> = {};
      labels.forEach((label, i) => {
        const high = row[`h${i}`];
        const low = row[`l${i}`];
        ranges[label] = high === null || low === null
          ? null
          : { high: Number(high), low: Number(low) };
      });
      result.set(String(row.symbol), ranges);
    }
    return result;
  };

  const aggregateOpenPrices = (
    since: Record<string, number>,
  ): Map<string, Record<string, number | null>> => {
    const labels = Object.keys(since);
    const result = new Map<string, Record<string, number | null>>();
    if (labels.length === 0) return result;
    const subqueries = labels.map((_, i) =>
      `(SELECT open FROM candles_h4 sub WHERE sub.symbol = c.symbol AND sub.open_time >= ? ORDER BY sub.open_time ASC LIMIT 1) AS o${i}`
    );
    const params = labels.map((l) => since[l]);
    const rows = db.prepare(
      `SELECT symbol, ${subqueries.join(", ")} FROM (SELECT DISTINCT symbol FROM candles_h4) c`,
    ).all(...params) as Record<string, string | number | null>[];
    for (const row of rows) {
      const opens: Record<string, number | null> = {};
      labels.forEach((label, i) => {
        const val = row[`o${i}`];
        opens[label] = val === null || val === undefined ? null : Number(val);
      });
      result.set(String(row.symbol), opens);
    }
    return result;
  };

  return {
    upsertMany: (candles) => guarded(() => upsertMany(candles)),
    count: (symbol) => guarded(() => Number((countStmt.get(symbol) as { n: number | bigint }).n)),
    latestOpenTimes: () => guarded(latestOpenTimes),
    aggregateRanges: (since) => guarded(() => aggregateRanges(since)),
    aggregateOpenPrices: (since) => guarded(() => aggregateOpenPrices(since)),
    close: () => guarded(() => db.close()),
  };
}
