/**
 * Slack 送信履歴ストア (SQLite)
 *
 * Worker (書き込み) と WebUI (読み取り) の双方から利用される共有モジュール。
 * 両サービスは同一 DB ファイルをボリューム共有する。
 */

import { Database } from "@db/sqlite";

export interface SlackMessageRecord {
  id?: number;
  /** 受信・処理時刻 (epoch ms) */
  createdAt: number;
  /** 通知タイプ (TEXT / ERROR / INFO / ORDER_OPEN ...) */
  type: string;
  /** 送信元 worker 名 */
  worker: string;
  channel: string;
  text: string;
  ok: boolean;
  error?: string;
  traceId?: string;
  slackTs?: string;
}

export interface HistoryQuery {
  hours?: number;
  type?: string;
  ok?: boolean;
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryStats {
  total: number;
  okCount: number;
  failedCount: number;
  last24h: number;
  lastMessageAt: number | null;
  byType: Record<string, number>;
}

interface Row {
  id: number | bigint;
  created_at: number | bigint;
  type: string;
  worker: string;
  channel: string;
  text: string;
  ok: number | bigint;
  error: string | null;
  trace_id: string | null;
  slack_ts: string | null;
}

export class MessageHistoryStore {
  private db: Database;

  constructor(dbPath = "./data/slack_history.db") {
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) Deno.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath, { int64: true });
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slack_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        worker TEXT NOT NULL,
        channel TEXT NOT NULL,
        text TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT,
        trace_id TEXT,
        slack_ts TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_slack_messages_created ON slack_messages(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_slack_messages_type ON slack_messages(type);
    `);
  }

  public insert(rec: SlackMessageRecord): void {
    this.db.prepare(
      `INSERT INTO slack_messages (created_at, type, worker, channel, text, ok, error, trace_id, slack_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      BigInt(Math.floor(rec.createdAt)),
      rec.type,
      rec.worker,
      rec.channel,
      rec.text,
      rec.ok ? 1 : 0,
      rec.error ?? null,
      rec.traceId ?? null,
      rec.slackTs ?? null,
    );
  }

  public query(q: HistoryQuery = {}): { messages: SlackMessageRecord[]; total: number } {
    const where: string[] = [];
    const params: (string | number | bigint)[] = [];
    if (q.hours && q.hours > 0) {
      where.push("created_at >= ?");
      params.push(BigInt(Date.now() - Math.floor(q.hours * 3600_000)));
    }
    if (q.type) {
      where.push("type = ?");
      params.push(q.type);
    }
    if (q.ok !== undefined) {
      where.push("ok = ?");
      params.push(q.ok ? 1 : 0);
    }
    if (q.keyword) {
      where.push("(text LIKE ? OR worker LIKE ? OR channel LIKE ? OR error LIKE ?)");
      const kw = `%${q.keyword}%`;
      params.push(kw, kw, kw, kw);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);

    const rows = this.db.prepare(
      `SELECT * FROM slack_messages ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all<Row>(...params, limit, offset);
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS c FROM slack_messages ${clause}`,
    ).get<{ c: number | bigint }>(...params);

    return {
      messages: rows.map((r) => this.toRecord(r)),
      total: Number(totalRow?.c ?? 0),
    };
  }

  public deleteById(id: number): boolean {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new RangeError("Message ID must be a positive safe integer");
    }
    return this.db.exec("DELETE FROM slack_messages WHERE id = ?", BigInt(id)) > 0;
  }

  public getStats(): HistoryStats {
    const agg = this.db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS ok_count,
              MAX(created_at) AS last_at
       FROM slack_messages`,
    ).get<{ total: number | bigint; ok_count: number | bigint; last_at: number | bigint | null }>();
    const day = this.db.prepare(
      "SELECT COUNT(*) AS c FROM slack_messages WHERE created_at >= ?",
    ).get<{ c: number | bigint }>(BigInt(Date.now() - 24 * 3600_000));
    const types = this.db.prepare(
      "SELECT type, COUNT(*) AS c FROM slack_messages GROUP BY type",
    ).all<{ type: string; c: number | bigint }>();

    const total = Number(agg?.total ?? 0);
    const okCount = Number(agg?.ok_count ?? 0);
    return {
      total,
      okCount,
      failedCount: total - okCount,
      last24h: Number(day?.c ?? 0),
      lastMessageAt: agg?.last_at != null ? Number(agg.last_at) : null,
      byType: Object.fromEntries(types.map((t) => [t.type, Number(t.c)])),
    };
  }

  /** 保持期間を超えた履歴を削除し、削除件数を返す */
  public purgeOlderThan(days: number): number {
    if (days <= 0) return 0;
    return this.db.exec(
      "DELETE FROM slack_messages WHERE created_at < ?",
      BigInt(Date.now() - days * 86400_000),
    );
  }

  public close(): void {
    this.db.close();
  }

  private toRecord(r: Row): SlackMessageRecord {
    return {
      id: Number(r.id),
      createdAt: Number(r.created_at),
      type: r.type,
      worker: r.worker,
      channel: r.channel,
      text: r.text,
      ok: Number(r.ok) === 1,
      error: r.error ?? undefined,
      traceId: r.trace_id ?? undefined,
      slackTs: r.slack_ts ?? undefined,
    };
  }
}
