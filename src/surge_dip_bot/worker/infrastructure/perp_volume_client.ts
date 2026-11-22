import { badResponse, postInfo } from "./rest_response.ts";
import { defaultFetch, type FetchLike } from "./fetch_like.ts";
import { type ResilienceOptions, runRead } from "./resilience.ts";
import type { Redis } from "ioredis";

/** metaAndAssetCtxs の銘柄メタ (必要な項目のみ) */
interface AssetMeta {
  name?: string;
  isDelisted?: boolean;
}

/** metaAndAssetCtxs の資産コンテキスト (必要な項目のみ) */
interface AssetContext {
  markPx?: string;
  midPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
}

/**
 * metaAndAssetCtxs の応答から、銘柄ごとの 24H 取引高 (USD, dayNtlVlm) を取り出す。
 * common-hyperliquid-client の parsePerpContexts と同じく、上場廃止銘柄と、
 * markPx / prevDayPx が 0 以下または数値でない銘柄は除外する (worker が評価対象にしない銘柄)
 *
 * @throws 応答の形式が想定と異なる場合 (AppError: kind="bad_response")
 */
export function parsePerpVolumes(data: unknown): Map<string, number> {
  if (!Array.isArray(data) || data.length < 2) {
    throw badResponse("HyperliquidInfo", "metaAndAssetCtxs の応答形式が不正です");
  }
  const universe = (data[0] as { universe?: AssetMeta[] } | null)?.universe;
  const contexts = data[1] as AssetContext[];
  if (!Array.isArray(universe) || !Array.isArray(contexts)) {
    throw badResponse(
      "HyperliquidInfo",
      "metaAndAssetCtxs の応答形式が不正です (universe / assetCtxs)",
    );
  }

  const volumes = new Map<string, number>();
  for (let i = 0; i < universe.length; i++) {
    const meta = universe[i];
    const ctx = contexts[i];
    if (!meta?.name || !ctx || meta.isDelisted) continue;
    const markPx = parseFloat(ctx.markPx ?? ctx.midPx ?? "0");
    const prevDayPx = parseFloat(ctx.prevDayPx ?? "0");
    if (isNaN(markPx) || markPx <= 0 || isNaN(prevDayPx) || prevDayPx <= 0) continue;
    volumes.set(meta.name, parseFloat(ctx.dayNtlVlm ?? "") || 0);
  }
  return volumes;
}

/**
 * Hyperliquid の Info API から銘柄別の 24H 取引高を取得するクライアント。
 * 参照のみで冪等なため、一時的な失敗は再試行する (遮断器(再試行(POST)))。失敗は AppError を投げる
 */
export class PerpVolumeClient {
  constructor(
    private readonly infoUrl: string,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly resilience: ResilienceOptions = {},
    private readonly redisClient?: Redis | null,
  ) {}

  /**
   * 銘柄名 → 24H 取引高 (USD) を返す。
   * REDIS 内に meta_and_asset_ctxs があればそれを最優先で使用。
   * なければ Hyperliquid Info API から再取得し、REDIS にキャッシュ保存する。
   */
  async fetchVolumes(): Promise<Map<string, number>> {
    // 1. REDIS からの取得確認
    if (this.redisClient) {
      try {
        const raw = await this.redisClient.get("hl:meta_and_asset_ctxs") ??
                    await this.redisClient.get("meta_and_asset_ctxs");
        if (raw) {
          const parsed = JSON.parse(raw);
          const volumes = parsePerpVolumes(parsed);
          if (volumes.size > 0) {
            return volumes;
          }
        }
      } catch (err) {
        console.warn("[PerpVolumeClient] REDIS からの meta_and_asset_ctxs 読み取り失敗:", err);
      }
    }

    // 2. REDIS に無ければ Hyperliquid Info API から再取得
    console.info("[PerpVolumeClient] REDISに assetCtxs がないため、Hyperliquid Info API から再取得します...");
    return runRead("HyperliquidInfo", this.resilience, async () => {
      const data = await postInfo(
        this.fetchFn,
        this.infoUrl,
        { type: "metaAndAssetCtxs" },
        "metaAndAssetCtxs",
      );

      // 取得したデータを REDIS に保存 (TTL: 300秒)
      if (this.redisClient && data) {
        try {
          await this.redisClient.set(
            "hl:meta_and_asset_ctxs",
            JSON.stringify(data),
            "EX",
            300,
          );
          console.info("[PerpVolumeClient] 再取得した meta_and_asset_ctxs を REDIS に保存しました (TTL: 300s)");
        } catch (setErr) {
          console.warn("[PerpVolumeClient] REDIS へのキャッシュ保存失敗:", setErr);
        }
      }

      return parsePerpVolumes(data);
    });
  }
}
