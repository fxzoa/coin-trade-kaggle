/**
 * hl-price-listener: WebUI HTTP Server & REST API
 * Provides Redis-backed multi-period price ranges and serves the crypto terminal dashboard.
 */

import { Redis } from "ioredis";
import { DEFAULT_SIGNAL_THRESHOLDS } from "../../shared/domain/trade_signal.ts";
import type { PeriodThresholds } from "../../shared/domain/trade_signal.ts";
import {
  REDIS_KEY_SIGNALS_LIST,
  REDIS_KEY_TRADE_MODE,
  type TradeMode,
} from "../../shared/domain/trade_mode.ts";
import { AppError, toError } from "../../shared/errors.ts";

/**
 * Hono / REST API compatible onError handler for AppError and unexpected errors.
 */
export function handleHonoError(
  err: unknown,
  c?: { json: (data: unknown, status: number) => Response },
): Response {
  const error = err instanceof AppError ? err : toError(err);
  const statusCode = err instanceof AppError ? (err.statusCode ?? 500) : 500;
  const errorCode = err instanceof AppError ? err.code : "INTERNAL_SERVER_ERROR";
  console.error(`[WebUI] Error caught: [${errorCode}]`, error.message);
  const body = {
    success: false,
    error: error.message,
    code: errorCode,
    timestamp: Date.now(),
  };
  if (c && typeof c.json === "function") {
    return c.json(body, statusCode);
  }
  return new Response(JSON.stringify(body, null, 2), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** MIME type mapping for static file serving */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/** WebUI (/api/ranges) が返す期間別しきい値。期間キーは小文字 ("24h" 形式) */
export type WebuiPeriodThresholds = Record<string, number>;

/** WebUI (/api/ranges) 応答の thresholds 構造 */
export interface WebuiThresholds {
  dip: WebuiPeriodThresholds;
  surge: WebuiPeriodThresholds;
  additionalDip24h: number;
  additionalSurge24h: number;
}

/** 期間ラベル ("24H" 等) のキーを小文字 ("24h") に変換する */
function lowerCasePeriodKeys(thresholds: Readonly<PeriodThresholds>): WebuiPeriodThresholds {
  return Object.fromEntries(
    Object.entries(thresholds).map(([label, value]) => [label.toLowerCase(), value]),
  );
}

/** シグナル判定の既定しきい値を WebUI 応答用 (期間キー小文字) に変換する。SSoT は trade_signal.ts */
export function buildWebuiThresholds(): WebuiThresholds {
  return {
    dip: lowerCasePeriodKeys(DEFAULT_SIGNAL_THRESHOLDS.dip),
    surge: lowerCasePeriodKeys(DEFAULT_SIGNAL_THRESHOLDS.surge),
    additionalDip24h: DEFAULT_SIGNAL_THRESHOLDS.additionalDip24h,
    additionalSurge24h: DEFAULT_SIGNAL_THRESHOLDS.additionalSurge24h,
  };
}

/** Default port for hl-price-listener WebUI */
export const DEFAULT_WEBUI_PORT = 8004;

/** Formats unix millisecond timestamp to JST (UTC+9) string */
export function formatJst(ms: number): string {
  if (!ms || isNaN(ms)) return "--";
  const date = new Date(ms + 9 * 3600 * 1000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s} JST`;
}

export interface RangePeriod {
  high: number | null;
  low: number | null;
}

export interface SymbolRangeItem {
  symbol: string;
  updatedAt: number;
  updatedAtJst: string;
  latestClose: number | null;
  ranges: {
    "24h": RangePeriod;
    "7d": RangePeriod;
    "30d": RangePeriod;
    "90d": RangePeriod;
    "180d": RangePeriod;
    "360d": RangePeriod;
  };
}

export interface CachedRanges {
  items: SymbolRangeItem[];
  timestamp: number;
  refTime: number;
  totalSymbols: number;
}

export class HlPriceWebuiServer {
  private port: number;
  private publicDir: string;
  private server: Deno.HttpServer | null = null;
  private rangeCache: CachedRanges | null = null;
  private pendingRangePromise: Promise<CachedRanges> | null = null;
  private rangeCacheVersion = 0;
  private cacheTtlMs = 60_000; // 60 seconds cache TTL for instant API response
  private redisClient: InstanceType<typeof Redis>;
  private prefix = "hl:evaluator:";

  constructor(
    port: number = DEFAULT_WEBUI_PORT,
    publicDir: string = "./src/webui/public",
  ) {
    this.port = port;
    this.publicDir = publicDir;

    const redisUrl = Deno.env.get("REDIS_URL") || "redis://localhost:6379";
    this.redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
  }

  /** Standard JSON Response helper with CORS */
  private jsonResponse(data: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  /** CORS preflight OPTIONS response */
  private handleOptions(): Response {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  /** Serves static files safely from publicDir */
  private async serveStatic(pathname: string): Promise<Response> {
    const sanitizedPath = pathname === "/" ? "/index.html" : pathname;
    if (sanitizedPath.includes("..")) {
      return this.jsonResponse({ error: "Forbidden" }, 403);
    }

    const localPath = `${this.publicDir}${sanitizedPath}`;
    try {
      const stat = await Deno.stat(localPath);
      if (stat.isDirectory) {
        return await this.serveStatic(`${pathname}/index.html`);
      }
      const data = await Deno.readFile(localPath);
      const extIndex = sanitizedPath.lastIndexOf(".");
      const ext = extIndex !== -1 ? sanitizedPath.slice(extIndex).toLowerCase() : "";
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
        },
      });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return new Response("404 Not Found", { status: 404 });
      }
      console.error(`Static file error: ${localPath}`, toError(err).message);
      return new Response("500 Internal Server Error", { status: 500 });
    }
  }

  /** Gathers status from the Redis MIN/MAX cache */
  private async getDbStatus(): Promise<Record<string, unknown>> {
    try {
      const stats = await this.getPriceStats();
      const updatedTimes = Object.values(stats)
        .map((item) => this.numberValue(item.updatedAt))
        .filter((time): time is number => time !== null);
      const latestTime = updatedTimes.length > 0 ? Math.max(...updatedTimes) : null;
      const periods = ["24h", "7d", "30d", "90d", "180d", "360d"];
      const rangeCount = Object.values(stats).reduce(
        (count, item) =>
          count + periods.filter((period) =>
            this.numberValue(item[`maxPrice${period}`]) !== null &&
            this.numberValue(item[`minPrice${period}`]) !== null
          ).length,
        0,
      );

      return {
        success: true,
        service: "hl-price-listener-webui",
        port: this.port,
        insufficientCooldown: await this.getInsufficientCooldown(),
        db: {
          path: `Redis (${this.prefix}price_stats:all)`,
          exists: true,
          rangeCount,
          uniqueSymbols: Object.keys(stats).length,
          fileSizeBytes: 0,
          fileSizeFormatted: "MIN/MAX cache",
          latestUpdateMs: latestTime,
          latestUpdateJst: latestTime ? formatJst(latestTime) : "--",
          latestUpdateIso: latestTime ? new Date(latestTime).toISOString() : null,
        },
        network: {
          network: "Mainnet",
          exchange: "Hyperliquid DEX",
          ws: "Active",
          circuitBreakers: "Normal",
          interval: "4H",
        },
        timestamp: Date.now(),
        serverTimeJst: formatJst(Date.now()),
      };
    } catch (err) {
      return {
        success: false,
        service: "hl-price-listener-webui",
        port: this.port,
        error: toError(err).message,
        timestamp: Date.now(),
      };
    }
  }

  /** Redis から証拠金不足クールダウンフラグの状態を取得する */
  private async getInsufficientCooldown(): Promise<
    { active: boolean; reason?: string; expiresAt?: string; remainingSec?: number }
  > {
    try {
      const key = "hl:system:insufficient_cooldown";
      const val = await this.redisClient.get(key);
      const ttl = await this.redisClient.ttl(key);
      if (!val) return { active: false };
      const parsed = JSON.parse(val);
      return {
        active: Boolean(parsed.active),
        reason: parsed.reason,
        expiresAt: parsed.expiresAt,
        remainingSec: ttl > 0 ? ttl : undefined,
      };
    } catch {
      return { active: false };
    }
  }

  private numberValue(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /** Reads the aggregate MIN/MAX payload written by the Trader */
  private async getPriceStats(): Promise<Record<string, Record<string, unknown>>> {
    const keys = [`${this.prefix}price_stats:all`, "price_stats:all", "hl:price_stats:all"];
    let emptyStats: Record<string, Record<string, unknown>> | null = null;

    for (const key of new Set(keys)) {
      const raw = await this.redisClient.get(key);
      if (raw === null) continue;

      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Redis ${key} must contain a symbol-to-stats object`);
      }
      const stats = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, Record<string, unknown>] =>
            typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]),
        ),
      );
      if (Object.keys(stats).length > 0) return stats;
      emptyStats ??= stats;
    }

    return emptyStats ?? {};
  }

  /** Gets symbols from the aggregate MIN/MAX cache */
  private async getSymbols(): Promise<string[]> {
    return Object.keys(await this.getPriceStats()).sort();
  }

  /** Reads multi-period ranges from Redis with caching and in-flight deduplication */
  private async getAggregatedRanges(): Promise<CachedRanges> {
    const now = Date.now();
    if (this.rangeCache && (now - this.rangeCache.timestamp) < this.cacheTtlMs) {
      return this.rangeCache;
    }
    if (this.pendingRangePromise) return this.pendingRangePromise;

    const version = this.rangeCacheVersion;
    const pending = (async () => {
      const stats = await this.getPriceStats();
      const items = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)).map(
        ([symbol, item]): SymbolRangeItem => {
          const updatedAt = this.numberValue(item.updatedAt) ?? 0;
          const range = (period: string): RangePeriod => ({
            high: this.numberValue(item[`maxPrice${period}`]),
            low: this.numberValue(item[`minPrice${period}`]),
          });
          const currentPrice = this.numberValue(item.currentPrice) ??
            this.numberValue(item.lastPrice);
          return {
            symbol,
            updatedAt,
            updatedAtJst: formatJst(updatedAt),
            latestClose: currentPrice,
            ranges: {
              "24h": range("24h"),
              "7d": range("7d"),
              "30d": range("30d"),
              "90d": range("90d"),
              "180d": range("180d"),
              "360d": range("360d"),
            },
          };
        },
      );
      const refreshedAt = Date.now();
      const result = {
        items,
        timestamp: refreshedAt,
        refTime: refreshedAt,
        totalSymbols: items.length,
      };
      if (version === this.rangeCacheVersion && items.length > 0) this.rangeCache = result;
      return result;
    })();
    this.pendingRangePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.pendingRangePromise === pending) this.pendingRangePromise = null;
    }
  }

  private invalidateRangeCache(): void {
    this.rangeCacheVersion++;
    this.rangeCache = null;
    this.pendingRangePromise = null;
  }

  /**
   * Redis から price_stats:all および meta_and_asset_ctxs を取得・パースする。
   * meta_and_asset_ctxs が Redis に存在しない場合は Hyperliquid Info API (POST /info) から直接取得し、
   * TTL 60秒で Redis にキャッシュする。
   */
  private async loadPriceStatsAndPerpMap(): Promise<{
    statsJson: Record<string, any> | null;
    perpMap: Map<string, { markPx: number; change24h: number; dayNtlVlm: number }>;
  }> {
    const perpMap = new Map<string, { markPx: number; change24h: number; dayNtlVlm: number }>();
    let statsJson: Record<string, any> | null = null;

    try {
      // 1. Trader が保持する集約 MIN/MAX のみを読み取る
      statsJson = await this.getPriceStats();

      // 2. meta_and_asset_ctxs の取得 (Redis -> Hyperliquid Info API フォールバック)
      let rawMeta: string | null = null;
      if (this.redisClient) {
        try {
          rawMeta = await this.redisClient.get(`${this.prefix}meta_and_asset_ctxs`);
          if (!rawMeta) {
            rawMeta = await this.redisClient.get("meta_and_asset_ctxs");
          }
          if (!rawMeta) {
            rawMeta = await this.redisClient.get("hl:meta_and_asset_ctxs");
          }
        } catch (e) {
          console.warn("[WebUI] Redis get meta_and_asset_ctxs failed:", (e as Error).message);
        }
      }

      let metaData: any = null;
      if (rawMeta) {
        try {
          metaData = JSON.parse(rawMeta);
        } catch {
          metaData = null;
        }
      }

      if (!metaData) {
        // REDIS に assetCtxs が存在しない場合は、外部APIを勝手に叩かずに処理を安全にSKIP
        console.warn(
          "[WebUI] meta_and_asset_ctxs not found in Redis. Skipping perpMap context processing.",
        );
      }

      // 3. perpMap の構築 (多様なスキーマに対応)
      if (metaData) {
        if (
          Array.isArray(metaData) && metaData.length >= 2 && Array.isArray(metaData[0]?.universe) &&
          Array.isArray(metaData[1])
        ) {
          const universe = metaData[0].universe;
          const ctxs = metaData[1];
          for (let i = 0; i < universe.length; i++) {
            const coin = universe[i]?.name;
            const ctx = ctxs[i];
            if (coin && ctx) {
              const markPx = Number(ctx.markPx || 0);
              const prevDayPx = Number(ctx.prevDayPx || 0);
              const change24h = (markPx && prevDayPx)
                ? ((markPx - prevDayPx) / prevDayPx) * 100
                : 0;
              const dayNtlVlm = Number(ctx.dayNtlVlm || 0);
              perpMap.set(coin, { markPx, change24h, dayNtlVlm });
            }
          }
        } else if (Array.isArray(metaData?.data)) {
          for (const p of metaData.data) {
            if (p?.coin) {
              perpMap.set(p.coin, {
                markPx: Number(p.markPx || 0),
                change24h: Number(p.change24h || 0),
                dayNtlVlm: Number(p.dayNtlVlm || 0),
              });
            }
          }
        } else if (Array.isArray(metaData?.universe) && Array.isArray(metaData?.contexts)) {
          const u = metaData.universe;
          const c = metaData.contexts;
          for (let i = 0; i < u.length; i++) {
            const coin = u[i]?.name;
            const ctx = c[i];
            if (coin && ctx) {
              const markPx = Number(ctx.markPx || 0);
              const prevDayPx = Number(ctx.prevDayPx || 0);
              const change24h = (markPx && prevDayPx)
                ? ((markPx - prevDayPx) / prevDayPx) * 100
                : 0;
              const dayNtlVlm = Number(ctx.dayNtlVlm || 0);
              perpMap.set(coin, { markPx, change24h, dayNtlVlm });
            }
          }
        }
      }
    } catch (err) {
      console.warn("[WebUI] loadPriceStatsAndPerpMap error:", (err as Error).message);
    }

    return { statsJson, perpMap };
  }

  /** Global error handler for WebUI HTTP server handling AppError and unexpected errors */
  public onError(err: unknown): Response {
    return handleHonoError(err);
  }

  /** Main request routing handler */
  public handleRequest = async (req: Request): Promise<Response> => {
    try {
      return await this.dispatchRequest(req);
    } catch (err) {
      return this.onError(err);
    }
  };

  /** Internal request dispatcher */
  private async dispatchRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    if (req.method === "OPTIONS") {
      return this.handleOptions();
    }

    // API: /api/errors (GET / DELETE)
    if (pathname === "/api/errors") {
      const KEY_ERRORS = `${this.prefix}errors`;
      if (req.method === "GET") {
        try {
          const limitStr = searchParams.get("limit") || "100";
          const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200);
          const rawList = await this.redisClient.lrange(KEY_ERRORS, 0, limit - 1);
          const errors = rawList.map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return {
                timestamp: new Date().toISOString(),
                service: "surge-dip-trade-bot",
                level: "ERROR",
                context: "Unknown",
                message: s,
              };
            }
          });
          return this.jsonResponse({ success: true, count: errors.length, errors });
        } catch (err) {
          return this.onError(err);
        }
      }
      if (req.method === "DELETE") {
        try {
          await this.redisClient.del(KEY_ERRORS);
          return this.jsonResponse({ success: true, message: "Errors cleared" });
        } catch (err) {
          return this.onError(err);
        }
      }
    }

    // API: /api/flags/enabled (GET / POST)
    if (pathname === "/api/flags/enabled") {
      const KEY_ENABLED = "hl:flags:surge_dip:enabled";
      if (req.method === "GET") {
        try {
          const val = await this.redisClient.get(KEY_ENABLED);
          const enabled = val === null ? true : val === "true" || val === "1";
          return this.jsonResponse({ success: true, enabled });
        } catch (err) {
          return this.onError(err);
        }
      }
      if (req.method === "POST") {
        try {
          const body = await req.json();
          const enabled = Boolean(body.enabled);
          await this.redisClient.set(KEY_ENABLED, enabled ? "true" : "false");
          return this.jsonResponse({ success: true, enabled });
        } catch (err) {
          return this.onError(err);
        }
      }
    }

    // API: /api/flags/mode (GET / POST)
    if (pathname === "/api/flags/mode") {
      if (req.method === "GET") {
        try {
          const mode = (await this.redisClient.get(REDIS_KEY_TRADE_MODE)) || "BOTH";
          return this.jsonResponse({ success: true, mode });
        } catch (err) {
          return this.onError(err);
        }
      }
      if (req.method === "POST") {
        try {
          const body = await req.json();
          const mode: TradeMode = body.mode;
          if (
            mode !== "BOTH" && mode !== "BUY_ONLY" && mode !== "SELL_ONLY" && mode !== "DISABLED"
          ) {
            return this.jsonResponse({ success: false, error: "Invalid mode" }, 400);
          }
          await this.redisClient.set(REDIS_KEY_TRADE_MODE, mode);
          return this.jsonResponse({ success: true, mode });
        } catch (err) {
          return this.onError(err);
        }
      }
    }

    // API: /api/signals (GET) - Redis 上のシグナル一覧
    if (pathname === "/api/signals" && req.method === "GET") {
      try {
        const rawLimit = Number(searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
        const items = await this.redisClient.lrange(REDIS_KEY_SIGNALS_LIST, 0, limit - 1);
        const signals = items.map((raw) => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }).filter(Boolean);
        return this.jsonResponse({ success: true, count: signals.length, data: signals });
      } catch (err) {
        return this.onError(err);
      }
    }

    // API: /api/orders (GET) - Redis 注文一覧
    if (pathname === "/api/orders" && req.method === "GET") {
      try {
        const rawLimit = Number(searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
        const ids = await this.redisClient.zrevrange("hl:evaluator:orders:timeline", 0, limit - 1);
        if (ids.length === 0) {
          return this.jsonResponse({ success: true, count: 0, data: [] });
        }
        const raws = await this.redisClient.hmget("hl:evaluator:orders", ...ids);
        const orders = raws.filter((r): r is string => Boolean(r)).map((s) => JSON.parse(s));
        return this.jsonResponse({ success: true, count: orders.length, data: orders });
      } catch (err) {
        return this.onError(err);
      }
    }

    // API: /api/tp_orders (GET) - Redis TP決済一覧
    if (pathname === "/api/tp_orders" && req.method === "GET") {
      try {
        const raws = await this.redisClient.hvals("hl:evaluator:tp_orders");
        const list = raws.map((s) => JSON.parse(s));
        list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return this.jsonResponse({ success: true, count: list.length, data: list.slice(0, 50) });
      } catch (err) {
        return this.onError(err);
      }
    }

    // Health check
    if (pathname === "/health") {
      return this.jsonResponse({
        status: "ok",
        service: "hl-price-listener-webui",
        port: this.port,
      });
    }

    // API: /api/status
    if (pathname === "/api/status" && req.method === "GET") {
      try {
        const status = await this.getDbStatus();
        return this.jsonResponse(status);
      } catch (err) {
        console.error("Status error:", err);
        return this.jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // API: /api/symbols
    if (pathname === "/api/symbols" && req.method === "GET") {
      try {
        const symbols = await this.getSymbols();
        return this.jsonResponse({
          success: true,
          count: symbols.length,
          symbols,
        });
      } catch (err) {
        return this.onError(err);
      }
    }

    // API: /api/price-change (Redis / dashboard-worker 互換の騰落率一覧 API)
    if (pathname === "/api/price-change" && req.method === "GET") {
      try {
        const { statsJson, perpMap } = await this.loadPriceStatsAndPerpMap();

        if (statsJson && Object.keys(statsJson).length > 0) {
          const items: any[] = [];
          const allCoins = Object.keys(statsJson);
          for (const coin of allCoins) {
            const stats = statsJson[coin];
            const perp = perpMap.get(coin);

            let markPrice = 0;
            if (typeof stats?.currentPrice === "number" && stats.currentPrice > 0) {
              markPrice = stats.currentPrice;
            } else if (typeof stats?.lastPrice === "number" && stats.lastPrice > 0) {
              markPrice = stats.lastPrice;
            } else if (perp && perp.markPx > 0) {
              markPrice = perp.markPx;
            }

            let volume24h = 0;
            if (perp && perp.dayNtlVlm > 0) {
              volume24h = perp.dayNtlVlm;
            } else if (typeof stats?.volume24h === "number" && stats.volume24h > 0) {
              volume24h = stats.volume24h;
            }

            const resolveChange = (
              direct?: number,
              open?: number,
              mark?: number,
              fallback?: number,
            ) => {
              if (typeof direct === "number" && !isNaN(direct)) return direct;
              if (typeof open === "number" && open > 0 && typeof mark === "number" && mark > 0) {
                return ((mark - open) / open) * 100;
              }
              if (typeof fallback === "number" && !isNaN(fallback)) return fallback;
              return null;
            };

            const change24h = perp?.change24h ?? 0;
            const change7d = resolveChange(
              stats?.change7d,
              stats?.openPrice7d ?? stats?.baseStats?.openPrice7d,
              markPrice,
              stats?.baseStats?.change7d,
            );
            const change30d = resolveChange(
              stats?.change30d,
              stats?.openPrice30d ?? stats?.baseStats?.openPrice30d,
              markPrice,
              stats?.baseStats?.change30d,
            );
            const change90d = resolveChange(
              stats?.change90d,
              stats?.openPrice90d ?? stats?.baseStats?.openPrice90d,
              markPrice,
              stats?.baseStats?.change90d,
            );
            const change180d = resolveChange(
              stats?.change180d,
              stats?.openPrice180d ?? stats?.baseStats?.openPrice180d,
              markPrice,
              stats?.baseStats?.change180d,
            );
            const change360d = resolveChange(
              stats?.change360d,
              stats?.openPrice360d ?? stats?.baseStats?.openPrice360d,
              markPrice,
              stats?.baseStats?.change360d,
            );

            if (markPrice > 0 || volume24h > 0 || stats) {
              items.push({
                coin,
                markPrice,
                change24h,
                change7d,
                change30d,
                change90d,
                change180d,
                change360d,
                volume24h,
                updatedAt: stats?.updatedAt ?? Date.now(),
              });
            }
          }

          items.sort((a, b) => {
            const valA = a.change180d;
            const valB = b.change180d;
            if (valA === null && valB === null) return 0;
            if (valA === null) return 1;
            if (valB === null) return -1;
            return valB - valA;
          });

          return this.jsonResponse({
            success: true,
            totalCount: items.length,
            items,
            timestamp: new Date().toISOString(),
          });
        }

        // フォールバック: ローカルの確定足レンジ集計 (getAggregatedRanges) から算出
        const cached = await this.getAggregatedRanges();
        const items = cached.items.map((item) => {
          const markPrice = item.latestClose || 0;
          const calcChange = (high: number | null, low: number | null) => {
            if (!high || !low || !markPrice) return null;
            const mid = (high + low) / 2;
            return ((markPrice - mid) / mid) * 100;
          };

          return {
            coin: item.symbol,
            markPrice,
            change24h: perpMap.get(item.symbol)?.change24h ?? 0,
            change7d: calcChange(item.ranges["7d"]?.high, item.ranges["7d"]?.low),
            change30d: calcChange(item.ranges["30d"]?.high, item.ranges["30d"]?.low),
            change90d: calcChange(item.ranges["90d"]?.high, item.ranges["90d"]?.low),
            change180d: calcChange(item.ranges["180d"]?.high, item.ranges["180d"]?.low),
            change360d: calcChange(item.ranges["360d"]?.high, item.ranges["360d"]?.low),
            volume24h: perpMap.get(item.symbol)?.dayNtlVlm ?? 0,
            updatedAt: item.updatedAt,
          };
        });

        items.sort((a, b) => {
          const valA = a.change180d;
          const valB = b.change180d;
          if (valA === null && valB === null) return 0;
          if (valA === null) return 1;
          if (valB === null) return -1;
          return valB - valA;
        });

        return this.jsonResponse({
          success: true,
          totalCount: items.length,
          items,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return this.onError(err);
      }
    }

    // API: /api/volume-ranking (Redis / dashboard-worker 互換の取引高倍率ランキング API)
    if (pathname === "/api/volume-ranking" && req.method === "GET") {
      try {
        const { statsJson, perpMap } = await this.loadPriceStatsAndPerpMap();

        if (statsJson && Object.keys(statsJson).length > 0) {
          const rankingItems: any[] = [];
          const allCoins = Object.keys(statsJson);

          for (const coin of allCoins) {
            const stats = statsJson[coin];
            const perp = perpMap.get(coin);

            let markPrice = 0;
            if (typeof stats?.currentPrice === "number" && stats.currentPrice > 0) {
              markPrice = stats.currentPrice;
            } else if (typeof stats?.lastPrice === "number" && stats.lastPrice > 0) {
              markPrice = stats.lastPrice;
            } else if (perp && perp.markPx > 0) {
              markPrice = perp.markPx;
            }

            const change24h = perp?.change24h ?? 0;
            const avgDailyVolume30d = stats?.avgDailyVolume30d ??
              stats?.baseStats?.avgDailyVolume30d ?? 0;

            let volume24h = 0;
            if (perp && perp.dayNtlVlm > 0) {
              volume24h = perp.dayNtlVlm;
            } else if (typeof stats?.volume24h === "number" && stats.volume24h > 0) {
              volume24h = stats.volume24h;
            }

            let volumeRatio = 0;
            if (avgDailyVolume30d > 0 && volume24h > 0) {
              volumeRatio = volume24h / avgDailyVolume30d;
            } else if (typeof stats?.volumeRatio === "number" && stats.volumeRatio > 0) {
              volumeRatio = stats.volumeRatio;
            }

            if (markPrice > 0 || avgDailyVolume30d > 0 || volume24h > 0) {
              rankingItems.push({
                rank: 0,
                coin,
                markPrice,
                change24h,
                volume24h,
                avgDailyVolume30d,
                volumeRatio,
                updatedAt: stats?.updatedAt ?? Date.now(),
              });
            }
          }

          rankingItems.sort((a, b) => b.volumeRatio - a.volumeRatio);
          rankingItems.forEach((item, idx) => {
            item.rank = idx + 1;
          });

          const rawLimit = searchParams.get("limit");
          const limit = rawLimit
            ? Math.max(1, Math.min(500, parseInt(rawLimit, 10) || 50))
            : rankingItems.length;
          const topItems = rankingItems.slice(0, limit);

          return this.jsonResponse({
            success: true,
            totalCount: rankingItems.length,
            returnedCount: topItems.length,
            limit,
            items: topItems,
            timestamp: new Date().toISOString(),
          });
        }

        // フォールバック: ローカルレンジ集計から生成
        const cached = await this.getAggregatedRanges();
        const rankingItems = cached.items.map((item, idx) => ({
          rank: idx + 1,
          coin: item.symbol,
          markPrice: item.latestClose || 0,
          change24h: perpMap.get(item.symbol)?.change24h ?? 0,
          volume24h: perpMap.get(item.symbol)?.dayNtlVlm ?? 0,
          avgDailyVolume30d: 0,
          volumeRatio: 0,
          updatedAt: item.updatedAt,
        }));

        const rawLimit = searchParams.get("limit");
        const limit = rawLimit
          ? Math.max(1, Math.min(500, parseInt(rawLimit, 10) || 50))
          : rankingItems.length;
        const topItems = rankingItems.slice(0, limit);

        return this.jsonResponse({
          success: true,
          totalCount: rankingItems.length,
          returnedCount: topItems.length,
          limit,
          items: topItems,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return this.onError(err);
      }
    }

    // API: /api/ranges
    if (pathname === "/api/ranges" && req.method === "GET") {
      try {
        const cached = await this.getAggregatedRanges();
        let items = cached.items;

        const search = searchParams.get("search")?.trim().toUpperCase();
        if (search) {
          items = items.filter((item) => item.symbol.toUpperCase().includes(search));
        }

        const rawLimit = searchParams.get("limit");
        const limit = rawLimit !== null ? Number(rawLimit) : 50;
        if (Number.isFinite(limit) && limit > 0) {
          items = items.slice(0, limit);
        }

        return this.jsonResponse({
          success: true,
          total: cached.totalSymbols,
          count: items.length,
          refTime: cached.refTime,
          refTimeJst: formatJst(cached.refTime),
          data: items,
          thresholds: buildWebuiThresholds(),
          timestamp: cached.timestamp,
        });
      } catch (err) {
        return this.onError(err);
      }
    }

    // API: /api/events (SSE endpoint)
    if (pathname === "/api/events" && req.method === "GET") {
      return this.handleSSE(req);
    }

    // Serve static files
    return await this.serveStatic(pathname);
  }

  /**
   * SSE (/api/events) ハンドラ
   * Redis Pub/Sub (hl:events:prices) を購読し、リアルタイム価格・シグナル更新を配信する
   */
  private handleSSE(req: Request): Response {
    const redisUrl = Deno.env.get("REDIS_URL") || "redis://localhost:6379";
    const prefix = Deno.env.get("REDIS_KEY_PREFIX") || "hl:";

    const subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 3000),
    });

    const channels = [...new Set([`${prefix}events:prices`, "hl:events:price_stats"])];
    const invalidateRangeCache = () => this.invalidateRangeCache();
    let isClosed = false;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const sendEvent = (event: string, data: unknown) => {
          if (isClosed) return;
          try {
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            // 切断時
          }
        };

        // 初期接続イベント
        sendEvent("connected", {
          time: Date.now(),
          channels,
        });

        subscriber.subscribe(...channels).catch((err) => {
          console.error("[WebUI/SSE] Subscribe error:", err);
        });

        subscriber.on("message", (channel, message) => {
          try {
            const parsed = JSON.parse(message);
            if (channel === `${prefix}events:prices`) {
              sendEvent("prices", parsed);
            } else if (channel === "hl:events:price_stats") {
              invalidateRangeCache();
              sendEvent("ranges", parsed);
            }
          } catch (err) {
            console.error(`[WebUI/SSE] Invalid message on ${channel}:`, toError(err).message);
          }
        });

        // 20秒ごとの keepalive
        const keepAliveTimer = setInterval(() => {
          if (isClosed) {
            clearInterval(keepAliveTimer);
            return;
          }
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepAliveTimer);
          }
        }, 20000);

        req.signal.addEventListener("abort", () => {
          isClosed = true;
          clearInterval(keepAliveTimer);
          subscriber.quit().catch(() => {});
          try {
            controller.close();
          } catch {
            // ignore
          }
        });
      },
      cancel() {
        isClosed = true;
        subscriber.quit().catch(() => {});
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  /** Starts HTTP server */
  public start(): void {
    this.server = Deno.serve(
      {
        port: this.port,
        onListen: ({ port, hostname }) => {
          console.info(`✓ [WebUI] Server running at: http://${hostname || "localhost"}:${port}/`);
          console.info(`✓ [WebUI] Data source: Redis (${this.prefix}*)`);
        },
      },
      this.handleRequest,
    );
  }

  /** Gracefully stops HTTP server */
  public async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
      this.server = null;
    }
    if (this.redisClient) {
      await this.redisClient.quit();
    }
  }
}
