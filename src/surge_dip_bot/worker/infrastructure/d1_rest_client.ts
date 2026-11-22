import { defaultFetch, type FetchLike } from "./fetch_like.ts";
import {
  badResponse,
  type CloudflareEnvelope,
  readCloudflareJson,
  sendRequest,
} from "./rest_response.ts";
import { type ResilienceOptions, runRead, runWrite } from "./resilience.ts";

/** Cloudflare D1 への接続情報 */
export interface D1Credentials {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

/** D1 REST API の応答 (必要な項目のみ) */
interface D1QueryResponse extends CloudflareEnvelope {
  result?: { results?: Record<string, unknown>[]; meta?: { changes?: number } }[];
}

/** 実行する SQL 1 文とバインド値 */
export interface D1Statement {
  sql: string;
  params: unknown[];
}

/** SQL 1 文の実行結果 */
export interface D1ExecuteResult {
  /** 結果の行 (行を返さない文は空配列) */
  rows: Record<string, unknown>[];
  /** 変更された行数 (meta.changes。応答に無ければ 0) */
  changes: number;
}

/**
 * Cloudflare D1 の REST API (`/query`) で SQL を 1 文実行する薄いクライアント。
 * 失敗は AppError (service="D1") を投げる。トークンはメッセージに含めない。
 *
 * 読み取り (read / query) と書き込み (write) を明示的に分ける:
 * - 読み取りは冪等なので、一時的な失敗を再試行する (遮断器(再試行(呼び出し)))
 * - 書き込みは再試行しない (応答が失われただけで成功している場合に二重登録になるため)。遮断器だけを通す
 */
export class D1RestClient {
  constructor(
    private readonly credentials: D1Credentials,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly resilience: ResilienceOptions = {},
  ) {}

  /** SELECT を実行し、結果の行を返す (読み取り。再試行あり) */
  async query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.read(sql, params)).rows;
  }

  /** SELECT を実行し、結果の行と変更行数を返す (読み取り。再試行あり) */
  read(sql: string, params: unknown[]): Promise<D1ExecuteResult> {
    return runRead("D1", this.resilience, () => this.#send(sql, params));
  }

  /**
   * 複数の SELECT を並行して実行し、結果の行を順に返す (読み取り)。
   * 全体を 1 つの操作として再試行・遮断の対象にする (1 回の取得で遮断器の失敗が複数件に数えられないようにする)
   */
  queryAll(statements: readonly D1Statement[]): Promise<Record<string, unknown>[][]> {
    return runRead("D1", this.resilience, async () => {
      const results = await Promise.all(statements.map((s) => this.#send(s.sql, s.params)));
      return results.map((r) => r.rows);
    });
  }

  /** INSERT などの書き込みを 1 回だけ実行する (再試行しない) */
  write(sql: string, params: unknown[]): Promise<D1ExecuteResult> {
    return runWrite(this.resilience, () => this.#send(sql, params));
  }

  /** SQL を 1 回送って結果を読む (再試行・遮断は呼び出し側で決める) */
  async #send(sql: string, params: unknown[]): Promise<D1ExecuteResult> {
    const { accountId, databaseId, apiToken } = this.credentials;
    const url = `https://api.cloudflare.com/client/v4/accounts/${
      encodeURIComponent(accountId)
    }/d1/database/${encodeURIComponent(databaseId)}/query`;

    const res = await sendRequest(this.fetchFn, url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    }, "D1");
    const body = await readCloudflareJson<D1QueryResponse>(res, "D1");
    // 成功の応答でも結果が無ければ、空の成功 (行なし・変更なし) とは扱わず失敗にする
    const first = Array.isArray(body.result) ? body.result[0] : undefined;
    if (!first || !Array.isArray(first.results)) {
      throw badResponse("D1", "応答に結果 (result) がありません", res.status);
    }
    return { rows: first.results, changes: first.meta?.changes ?? 0 };
  }
}
