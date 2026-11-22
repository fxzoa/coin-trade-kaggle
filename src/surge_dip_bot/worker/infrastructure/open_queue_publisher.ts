import { classifyError, type ErrorKind, formatError } from "../../shared/errors.ts";
import type { OpenQueueMessage } from "../../shared/domain/open_queue_message.ts";
import { defaultFetch, type FetchLike } from "./fetch_like.ts";
import { readCloudflareJson, sendRequest } from "./rest_response.ts";
import { type ResilienceOptions, runWrite } from "./resilience.ts";

/** Cloudflare Queues への接続情報 */
export interface OpenQueueCredentials {
  accountId: string;
  queueId: string;
  apiToken: string;
}

/** 1 回のバッチ送信の上限件数 (Cloudflare Queues の sendBatch と同じ) */
export const MAX_BATCH_MESSAGES = 100;
/** 1 回のバッチ送信の上限サイズ (バイト)。256 KB に余裕を持たせる */
export const MAX_BATCH_BYTES = 250 * 1000;
/** 送信 1 回あたりのタイムアウト (ms) */
export const PUBLISH_TIMEOUT_MS = 10 * 1000;

/** 送信結果。publish は例外を投げず、この値で成否を返す */
export interface PublishResult {
  /** 送信に成功した件数 */
  sent: number;
  /** 送信に失敗した件数 */
  failed: number;
  /** 最初の失敗の理由 (formatError の 1 行。識別子・トークンは伏せてある) */
  error?: string;
  /** 最初の失敗の種別 (呼び出し側のログレベルの判断用) */
  errorKind?: ErrorKind;
}

/**
 * Cloudflare Queues の HTTP API (`/messages/batch`) で open-queue へメッセージを送る。
 * 100 件 / サイズ上限ごとに分割して送り、失敗しても例外は投げない
 * (失敗分は D1 の NEW 行として残り、open-worker の定期実行が拾う)。
 * 送信は書き込みなので再試行しない (応答が失われただけで成功していると二重発注になるため)。
 * 遮断器が開いている間は送信せず、失敗として数える
 */
export class OpenQueuePublisher {
  constructor(
    private readonly credentials: OpenQueueCredentials,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly timeoutMs: number = PUBLISH_TIMEOUT_MS,
    private readonly resilience: ResilienceOptions = {},
  ) {}

  /** メッセージを JSON 本文で送る。空配列なら何もしない */
  async publish(messages: readonly OpenQueueMessage[]): Promise<PublishResult> {
    const result: PublishResult = { sent: 0, failed: 0 };
    for (const chunk of chunkMessages(messages)) {
      try {
        await runWrite(this.resilience, () => this.#sendBatch(chunk));
        result.sent += chunk.length;
      } catch (e) {
        const error = classifyError(e, "Queues");
        result.failed += chunk.length;
        result.error ??= formatError(error);
        result.errorKind ??= error.kind;
      }
    }
    return result;
  }

  /** 1 バッチを送る。失敗 (HTTP エラー・success が true でない応答・通信エラー・タイムアウト) は AppError を投げる */
  async #sendBatch(chunk: readonly OpenQueueMessage[]): Promise<void> {
    const { accountId, queueId, apiToken } = this.credentials;
    const url = `https://api.cloudflare.com/client/v4/accounts/${
      encodeURIComponent(accountId)
    }/queues/${encodeURIComponent(queueId)}/messages/batch`;

    const res = await sendRequest(this.fetchFn, url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: chunk.map((body) => ({ body, content_type: "json" })),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }, "Queues");
    await readCloudflareJson(res, "Queues");
  }
}

/** 件数とサイズの上限を超えないようにメッセージを分割する */
export function chunkMessages(messages: readonly OpenQueueMessage[]): OpenQueueMessage[][] {
  const encoder = new TextEncoder();
  const chunks: OpenQueueMessage[][] = [];
  let current: OpenQueueMessage[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = encoder.encode(JSON.stringify(message)).length + 40; // content_type 等の枠の分
    if (
      current.length > 0 && (current.length >= MAX_BATCH_MESSAGES || bytes + size > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(message);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
