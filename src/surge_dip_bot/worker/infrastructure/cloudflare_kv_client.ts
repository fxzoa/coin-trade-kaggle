import type { KvBulkEntry, KvReader, KvWriter } from "../../shared/domain/ports.ts";
import { defaultFetch, type FetchLike } from "./fetch_like.ts";
import {
  type CloudflareEnvelope,
  cloudflareErrorDetail,
  responseError,
  sendRequest,
} from "./rest_response.ts";
import { type ResilienceOptions, runRead, runWrite } from "./resilience.ts";

/**
 * @deprecated Cloudflare KV への接続情報 (Redis 移行に伴い非推奨)
 */
export interface KvCredentials {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

/** KV の「キーが存在しない」を表すエラーコード */
const KEY_NOT_FOUND_CODE = 10009;

/**
 * @deprecated Cloudflare KV の REST API で値を読み書きする。
 * Redis 移行に伴い非推奨 (PriceRangeRedisSyncer / Redis を直接使用してください)。
 */
export class CloudflareKvClient implements KvReader, KvWriter {
  constructor(
    private readonly credentials: KvCredentials,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly resilience: ResilienceOptions = {},
  ) {}

  /** キーの値を文字列で返す。存在しなければ null */
  get(key: string): Promise<string | null> {
    return runRead("KV", this.resilience, () => this.#getOnce(key));
  }

  /** GET を 1 回実行する (再試行・遮断は呼び出し側で決める) */
  async #getOnce(key: string): Promise<string | null> {
    const { accountId, namespaceId, apiToken } = this.credentials;
    const url = `https://api.cloudflare.com/client/v4/accounts/${
      encodeURIComponent(accountId)
    }/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`;
    const res = await sendRequest(this.fetchFn, url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiToken}` },
    }, "KV");
    if (res.ok) return await res.text();

    const body = await res.json().catch(() => null) as CloudflareEnvelope | null;
    if (res.status === 404 && body?.errors?.some((e) => e.code === KEY_NOT_FOUND_CODE)) {
      return null;
    }
    const detail = cloudflareErrorDetail(body);
    throw responseError(res, "KV", `key=${key}${detail ? `; ${detail}` : ""}`);
  }

  /** 単一キーに文字列を書き込む */
  put(key: string, value: string, expirationTtl?: number): Promise<void> {
    return runWrite(this.resilience, () => this.#putOnce(key, value, expirationTtl));
  }

  async #putOnce(key: string, value: string, expirationTtl?: number): Promise<void> {
    const { accountId, namespaceId, apiToken } = this.credentials;
    const query = expirationTtl ? `?expiration_ttl=${encodeURIComponent(expirationTtl)}` : "";
    const url = `https://api.cloudflare.com/client/v4/accounts/${
      encodeURIComponent(accountId)
    }/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${
      encodeURIComponent(key)
    }${query}`;
    const res = await sendRequest(this.fetchFn, url, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${apiToken}` },
      body: value,
    }, "KV");
    if (res.ok) return;

    const body = await res.json().catch(() => null) as CloudflareEnvelope | null;
    const detail = cloudflareErrorDetail(body);
    throw responseError(res, "KV", `put key=${key}${detail ? `; ${detail}` : ""}`);
  }

  /** 複数キーを一括で書き込む (Cloudflare KV bulk API) */
  putBulk(entries: KvBulkEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return runWrite(this.resilience, () => this.#putBulkOnce(entries));
  }

  async #putBulkOnce(entries: KvBulkEntry[]): Promise<void> {
    const { accountId, namespaceId, apiToken } = this.credentials;
    const url = `https://api.cloudflare.com/client/v4/accounts/${
      encodeURIComponent(accountId)
    }/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/bulk`;
    const payload = entries.map((e) => ({
      key: e.key,
      value: e.value,
      ...(e.expirationTtl ? { expiration_ttl: e.expirationTtl } : {}),
    }));
    const res = await sendRequest(this.fetchFn, url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, "KV");
    if (res.ok) {
      const body = await res.json().catch(() => null) as CloudflareEnvelope | null;
      if (body && body.success === false) {
        const detail = cloudflareErrorDetail(body);
        throw responseError(res, "KV", `putBulk failed${detail ? `; ${detail}` : ""}`);
      }
      return;
    }

    const body = await res.json().catch(() => null) as CloudflareEnvelope | null;
    const detail = cloudflareErrorDetail(body);
    throw responseError(res, "KV", `putBulk count=${entries.length}${detail ? `; ${detail}` : ""}`);
  }
}
