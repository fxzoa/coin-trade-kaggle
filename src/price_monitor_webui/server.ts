import { Redis } from "ioredis";
import { loadConfig } from "./config.ts";
import { FillsStore } from "../shared/price_monitor/kv_store.ts";
import { AppError, NotFoundError, RedisError, toError, ValidationError } from "../shared/price_monitor/errors.ts";
import { installSlackErrorReporter, reportSlackError } from "../shared/price_monitor/slack_error_reporter.ts";

export interface WebServerOptions {
  port?: number;
  redisUrl?: string;
  redisKeyPrefix?: string;
  defaultUser?: string;
  kvPath?: string;
  redisClient?: InstanceType<typeof Redis>;
}

export function createWebServer(options?: WebServerOptions) {
  const config = loadConfig();
  const port = options?.port ?? config.port;
  const redisUrl = options?.redisUrl ?? config.redisUrl;
  const prefix = options?.redisKeyPrefix ?? config.redisKeyPrefix;
  const defaultUser = options?.defaultUser ?? config.userAddress;

  // 通常クエリ用 Redis クライアント
  const redis = options?.redisClient ?? new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 500, 3000),
  });

  redis.on("error", (err: unknown) => {
    const error = toError(err);
    console.error("[Web Redis] Error:", error.message);
  });

  const fillsStore = new FillsStore({
    redisClient: redis,
    prefix,
    kvPath: options?.kvPath ?? config.kvPath,
  });

  const headersJson = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };

  /**
   * 中央エラーレスポンス生成
   */
  function formatErrorResponse(err: unknown): Response {
    const error = toError(err);
    if (error instanceof AppError) {
      return new Response(
        JSON.stringify({
          error: error.message,
          code: error.code,
          ...(error.context ? { context: error.context } : {}),
        }),
        {
          status: error.statusCode,
          headers: headersJson,
        },
      );
    }

    return new Response(
      JSON.stringify({
        error: error.message || "Internal Server Error",
        code: "INTERNAL_ERROR",
      }),
      {
        status: 500,
        headers: headersJson,
      },
    );
  }

  /**
   * 静的ファイルの読み込み
   */
  async function serveStaticFile(path: string, contentType: string): Promise<Response> {
    const fileUrl = new URL(`./public/${path}`, import.meta.url);
    try {
      const data = await Deno.readFile(fileUrl);
      return new Response(data, {
        status: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "no-cache",
        },
      });
    } catch (e: unknown) {
      throw new NotFoundError(`Static file '${path}' not found`, {
        cause: toError(e),
        context: { path },
      });
    }
  }

  /**
   * SSE ストリームハンドラ
   */
  function handleSSE(req: Request, user: string): Response {
    const subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 3000),
    });

    const channels = [
      `${prefix}events:prices`,
      `${prefix}events:orders`,
      `${prefix}events:positions`,
      `${prefix}events:fills`,
      `${prefix}events:errors`,
    ];

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
            // クライアント切断などの例外
          }
        };

        // 初期接続イベント
        sendEvent("connected", {
          time: Date.now(),
          user: user || null,
          channels,
        });

        subscriber.subscribe(...channels).catch((err: unknown) => {
          const error = toError(err);
          console.error("[SSE Subscriber] Subscribe error:", error.message);
        });

        subscriber.on("message", (channel, message) => {
          try {
            const parsed = JSON.parse(message);
            // ユーザー指定がある場合、他のユーザーのイベントはフィルタリング（価格以外）
            if (
              user &&
              parsed.user &&
              parsed.user.toLowerCase() !== user.toLowerCase()
            ) {
              return;
            }

            if (channel === `${prefix}events:prices`) {
              sendEvent("prices", parsed);
            } else if (channel === `${prefix}events:orders`) {
              sendEvent("orders", parsed);
            } else if (channel === `${prefix}events:positions`) {
              sendEvent("positions", parsed);
            } else if (channel === `${prefix}events:fills`) {
              sendEvent("fills", parsed);
            }
          } catch {
            // パースエラー時
          }
        });

        // キープアライブ (20秒ごと)
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
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }

  /**
   * HTTP ルーティング・ディスパッチャ
   */
  async function dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // 静的ファイルルーティング
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return await serveStaticFile("index.html", "text/html; charset=utf-8");
    }

    // API ルーティング
    if (url.pathname.startsWith("/api/")) {
      const user = (url.searchParams.get("user") || defaultUser || "").trim().toLowerCase();

      // 1. GET /api/status
      if (url.pathname === "/api/status") {
        let redisConnected = false;
        try {
          const pong = await redis.ping();
          redisConnected = pong === "PONG";
        } catch {
          redisConnected = false;
        }

        // 証拠金不足クールダウン状態の取得
        let insufficientCooldown: {
          active: boolean;
          reason?: string;
          expiresAt?: string;
          remainingSec?: number;
        } = { active: false };
        try {
          const cdKey = `${prefix}system:insufficient_cooldown`;
          const cdVal = await redis.get(cdKey);
          const cdTtl = await redis.ttl(cdKey);
          if (cdVal) {
            const parsed = JSON.parse(cdVal);
            insufficientCooldown = {
              active: Boolean(parsed.active),
              reason: parsed.reason,
              expiresAt: parsed.expiresAt,
              remainingSec: cdTtl > 0 ? cdTtl : undefined,
            };
          }
        } catch {
          // ignore error reading cooldown
        }

        return new Response(
          JSON.stringify({
            status: "ok",
            timestamp: Date.now(),
            defaultUser: defaultUser || null,
            redisPrefix: prefix,
            redisConnected,
            insufficientCooldown,
          }),
          { headers: headersJson },
        );
      }

      // 2. GET /api/prices
      if (url.pathname === "/api/prices") {
        try {
          const [pricesHash, updatedAt] = await Promise.all([
            redis.hgetall(`${prefix}prices`),
            redis.get(`${prefix}prices:updated_at`),
          ]);

          const parsedPrices: Record<string, number> = {};
          for (const [k, v] of Object.entries(pricesHash)) {
            parsedPrices[k] = parseFloat(v);
          }

          return new Response(
            JSON.stringify({
              updatedAt: updatedAt ? parseInt(updatedAt, 10) : null,
              prices: parsedPrices,
            }),
            { headers: headersJson },
          );
        } catch (e: unknown) {
          throw new RedisError("Failed to fetch prices from Redis", {
            cause: toError(e),
          });
        }
      }

      // 3. GET /api/positions
      if (url.pathname === "/api/positions") {
        if (!user) {
          throw new ValidationError(
            "Missing required 'user' query parameter or HL_USER_ADDRESS",
          );
        }
        try {
          const key = `${prefix}positions:${user}`;
          const [positionsHash, updatedAt] = await Promise.all([
            redis.hgetall(key),
            redis.get(`${key}:updated_at`),
          ]);

          const positions = Object.values(positionsHash).map((item) => {
            try {
              return JSON.parse(item);
            } catch {
              return item;
            }
          });

          return new Response(
            JSON.stringify({
              user,
              updatedAt: updatedAt ? parseInt(updatedAt, 10) : null,
              positions,
            }),
            { headers: headersJson },
          );
        } catch (e: unknown) {
          if (e instanceof AppError) throw e;
          throw new RedisError(`Failed to fetch positions for user '${user}'`, {
            cause: toError(e),
            context: { user },
          });
        }
      }

      // 4. GET /api/orders
      if (url.pathname === "/api/orders") {
        if (!user) {
          throw new ValidationError(
            "Missing required 'user' query parameter or HL_USER_ADDRESS",
          );
        }
        try {
          const key = `${prefix}orders:${user}`;
          const [ordersHash, updatedAt] = await Promise.all([
            redis.hgetall(key),
            redis.get(`${key}:updated_at`),
          ]);

          const orders = Object.values(ordersHash).map((item) => {
            try {
              return JSON.parse(item);
            } catch {
              return item;
            }
          });

          // 日時降順（新しい順）にソート
          orders.sort((a, b) => {
            const timeA = (a.order?.timestamp ?? a.timestamp ?? 0) as number;
            const timeB = (b.order?.timestamp ?? b.timestamp ?? 0) as number;
            return timeB - timeA;
          });

          return new Response(
            JSON.stringify({
              user,
              updatedAt: updatedAt ? parseInt(updatedAt, 10) : null,
              orders,
            }),
            { headers: headersJson },
          );
        } catch (e: unknown) {
          if (e instanceof AppError) throw e;
          throw new RedisError(`Failed to fetch orders for user '${user}'`, {
            cause: toError(e),
            context: { user },
          });
        }
      }

      // 5. GET /api/fills (Redis から取得)
      if (url.pathname === "/api/fills") {
        if (!user) {
          throw new ValidationError(
            "Missing required 'user' query parameter or HL_USER_ADDRESS",
          );
        }
        const limitStr = url.searchParams.get("limit") || "100";
        const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 500);

        const { fills, updatedAt } = await fillsStore.getUserFills(user, limit);

        return new Response(
          JSON.stringify({
            user,
            updatedAt,
            count: fills.length,
            fills,
            source: fillsStore.isRedis ? "redis" : "deno_kv",
          }),
          { headers: headersJson },
        );
      }

      // 6. GET /api/errors
      if (url.pathname === "/api/errors" && req.method === "GET") {
        try {
          const limitStr = url.searchParams.get("limit") || "100";
          const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 500);
          const errorsKey = `${prefix}errors`;
          const rawList = await redis.lrange(errorsKey, 0, limit - 1);
          const errors = rawList.map((item) => {
            try {
              return JSON.parse(item);
            } catch {
              return {
                timestamp: new Date().toISOString(),
                service: "price-syncer-bot",
                level: "ERROR",
                context: "Unknown",
                message: item,
              };
            }
          });

          return new Response(
            JSON.stringify({
              status: "ok",
              count: errors.length,
              errors,
            }),
            { headers: headersJson },
          );
        } catch (e: unknown) {
          throw new RedisError("Failed to fetch error logs from Redis", {
            cause: toError(e),
          });
        }
      }

      // 6.1 DELETE /api/errors (Clear errors)
      if (url.pathname === "/api/errors" && req.method === "DELETE") {
        try {
          await redis.del(`${prefix}errors`);
          return new Response(JSON.stringify({ status: "ok", message: "Errors cleared" }), {
            headers: headersJson,
          });
        } catch (e: unknown) {
          throw new RedisError("Failed to clear errors in Redis", {
            cause: toError(e),
          });
        }
      }

      // 7. GET /api/events (SSE)
      if (url.pathname === "/api/events") {
        return handleSSE(req, user);
      }

      throw new NotFoundError(`Endpoint '${url.pathname}' not found`);
    }

    throw new NotFoundError("Not Found");
  }

  /**
   * HTTP リクエストハンドラ (中央エラーハンドリング)
   */
  async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headersJson });
    }

    try {
      return await dispatch(req);
    } catch (err: unknown) {
      await reportSlackError(err, "web request");
      return formatErrorResponse(err);
    }
  }

  return {
    port,
    start: () => {
      console.log(`=============================================`);
      console.log(`  Hyperliquid Price Syncer Web UI & API`);
      console.log(`=============================================`);
      console.log(`Port             : ${port}`);
      console.log(`Redis URL        : ${redisUrl}`);
      console.log(`Redis Key Prefix : ${prefix}`);
      console.log(`Default User     : ${defaultUser || "None"}`);
      console.log(`Web Dashboard    : http://localhost:${port}`);
      console.log(`=============================================`);

      return Deno.serve({ port, hostname: "0.0.0.0" }, handler);
    },
    close: async () => {
      await fillsStore.close();
      if (!options?.redisClient) {
        await redis.quit();
      }
    },
  };
}

if (import.meta.main) {
  installSlackErrorReporter("price-change-monitor-webui");
  try {
    const server = createWebServer();
    await server.start();
  } catch (error) {
    console.warn("[price-change-monitor-webui] Startup failed:", error);
    await reportSlackError(error, "webui startup");
    Deno.exit(1);
  }
}
