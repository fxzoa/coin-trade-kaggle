import {
  AppError,
  classifyError,
  type ErrorService,
  httpStatusError,
} from "../../shared/errors.ts";
import type { FetchLike } from "./fetch_like.ts";

/** Cloudflare API の応答の共通部分 (必要な項目のみ) */
export interface CloudflareEnvelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

/** Retry-After ヘッダ (秒数または HTTP 日付) を ms に変換する。解釈できなければ undefined */
export function parseRetryAfterMs(
  value: string | null,
  now: () => number = Date.now,
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

/** 不正な応答 (非 JSON・success が true でない・結果欠落) を示す AppError */
export function badResponse(service: ErrorService, message: string, status?: number): AppError {
  return new AppError({ kind: "bad_response", service, message, status });
}

/**
 * fetch を実行する。通信失敗・タイムアウト (fetch が投げる例外) は AppError
 * (network / timeout) に分類して投げ直す
 */
export async function sendRequest(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  service: ErrorService,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (e) {
    throw classifyError(e, service);
  }
}

/** 失敗した HTTP 応答を AppError にする (429 の Retry-After は retryAfterMs に反映する) */
export function responseError(res: Response, service: ErrorService, detail?: string): AppError {
  return httpStatusError(
    service,
    res.status,
    detail,
    parseRetryAfterMs(res.headers.get("Retry-After")),
  );
}

/** Cloudflare のエラー本文 (errors[].message) を連結する。無ければ undefined */
export function cloudflareErrorDetail(body: CloudflareEnvelope | null): string | undefined {
  return body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || undefined;
}

/**
 * Cloudflare API の JSON 応答を読む。
 * HTTP エラーは状態コードで分類し、2xx でも JSON でない・success が true でない場合は bad_response にする
 */
export async function readCloudflareJson<T extends CloudflareEnvelope>(
  res: Response,
  service: ErrorService,
): Promise<T> {
  const body = await res.json().catch(() => null) as T | null;
  const detail = cloudflareErrorDetail(body);
  if (!res.ok) throw responseError(res, service, detail);
  if (body === null) throw badResponse(service, "応答が JSON ではありません", res.status);
  if (body.success !== true) {
    throw badResponse(
      service,
      `success が true ではありません${detail ? ` (${detail})` : ""}`,
      res.status,
    );
  }
  return body;
}

/**
 * Hyperliquid の Info API へ JSON を POST し、JSON 本文を返す (参照のみで冪等)。
 * @param detail 失敗時の原因に添える情報 (例: 銘柄・リクエスト種別)
 */
export async function postInfo(
  fetchFn: FetchLike,
  infoUrl: string,
  body: unknown,
  detail?: string,
): Promise<unknown> {
  const res = await sendRequest(fetchFn, infoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, "HyperliquidInfo");
  if (!res.ok) throw responseError(res, "HyperliquidInfo", detail);
  try {
    return await res.json();
  } catch (e) {
    // 本文の読み取り中のタイムアウト等は分類し、それ以外は不正な応答として扱う
    const error = classifyError(e, "HyperliquidInfo");
    throw error.kind === "unknown"
      ? badResponse("HyperliquidInfo", "応答が JSON ではありません", res.status)
      : error;
  }
}
