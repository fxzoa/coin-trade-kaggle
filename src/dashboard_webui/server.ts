/**
 * Deno Gateway サーバー (Hono 版)
 * - 静的アセット (SPA) の配信
 * - 統合ヘルスチェック & メトリクス API
 * - 各ボット WebUI へのリバースプロキシ
 */

import { Hono } from "jsr:@hono/hono@^4.6.14";
import { type AppConfig, type BotServiceConfig, loadConfig } from "./config.ts";
import { AppError, NotFoundError, toError, UpstreamApiError } from "../shared/price_monitor/errors.ts";
import { err, ok, type Result } from "../shared/price_monitor/result.ts";
import { installSlackErrorReporter, reportSlackError } from "./slack_error_reporter.ts";

export interface BotStatusResult {
  key: string;
  name: string;
  category: string;
  description: string;
  targetUrl: string;
  directPort: number;
  isHealthy: boolean;
  statusCode: number | null;
  latencyMs: number;
  lastChecked: string;
  details?: unknown;
}

// ボットヘルスチェック関数
export async function checkBotHealth(bot: BotServiceConfig): Promise<BotStatusResult> {
  const start = performance.now();
  const url = `${bot.targetUrl.replace(/\/$/, "")}${bot.healthEndpoint}`;
  const now = new Date().toISOString();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json, text/plain, */*" },
    });
    clearTimeout(timeout);

    const latencyMs = Math.round(performance.now() - start);
    let details: unknown = null;
    try {
      const text = await res.text();
      try {
        details = JSON.parse(text);
      } catch {
        details = { raw: text.slice(0, 100) };
      }
    } catch {
      // ignore body read error
    }

    return {
      key: bot.key,
      name: bot.name,
      category: bot.category,
      description: bot.description,
      targetUrl: bot.targetUrl,
      directPort: bot.directPort,
      isHealthy: res.ok,
      statusCode: res.status,
      latencyMs,
      lastChecked: now,
      details,
    };
  } catch (err: unknown) {
    const error = toError(err);
    const latencyMs = Math.round(performance.now() - start);
    return {
      key: bot.key,
      name: bot.name,
      category: bot.category,
      description: bot.description,
      targetUrl: bot.targetUrl,
      directPort: bot.directPort,
      isHealthy: false,
      statusCode: null,
      latencyMs,
      lastChecked: now,
      details: { error: error.message },
    };
  }
}

// 静的ファイルの提供
export async function serveStaticFile(reqPath: string): Promise<Result<Response, NotFoundError>> {
  const cleanPath = reqPath === "/" ? "/index.html" : reqPath;
  const filePath = new URL(`./static${cleanPath}`, import.meta.url);

  try {
    const file = await Deno.readFile(filePath);
    let contentType = "application/octet-stream";
    if (cleanPath.endsWith(".html")) contentType = "text/html; charset=utf-8";
    else if (cleanPath.endsWith(".css")) contentType = "text/css; charset=utf-8";
    else if (cleanPath.endsWith(".js")) contentType = "application/javascript; charset=utf-8";
    else if (cleanPath.endsWith(".json")) contentType = "application/json; charset=utf-8";
    else if (cleanPath.endsWith(".svg")) contentType = "image/svg+xml";

    return ok(
      new Response(file, {
        status: 200,
        headers: { "Content-Type": contentType },
      }),
    );
  } catch (e: unknown) {
    return err(
      new NotFoundError(`Static file '${cleanPath}' not found`, {
        cause: toError(e),
        context: { path: cleanPath },
      }),
    );
  }
}

// ボット設定の検索
export function findBot(
  config: AppConfig,
  botKey: string,
): Result<BotServiceConfig, NotFoundError> {
  const bot = config.bots.find((b) => b.key === botKey);
  if (!bot) {
    return err(new NotFoundError(`Bot key '${botKey}' not found`, { context: { botKey } }));
  }
  return ok(bot);
}

// リバースプロキシハンドラ
export async function proxyRequest(
  req: Request,
  bot: BotServiceConfig,
  pathAfterBot: string,
): Promise<Response> {
  const targetBase = bot.targetUrl.replace(/\/$/, "");
  const targetUrl = new URL(
    `${targetBase}${pathAfterBot.startsWith("/") ? "" : "/"}${pathAfterBot}`,
  );

  const reqUrl = new URL(req.url);
  targetUrl.search = reqUrl.search;

  const headers = new Headers(req.headers);
  headers.set("X-Forwarded-Host", reqUrl.host);
  headers.set("X-Forwarded-Proto", reqUrl.protocol.replace(":", ""));
  headers.delete("host");

  try {
    const body = (req.method !== "GET" && req.method !== "HEAD") ? await req.blob() : undefined;

    const proxyRes = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const responseHeaders = new Headers(proxyRes.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(proxyRes.body, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    const error = toError(err);
    await reportSlackError(error, `proxy:${bot.key}`);
    const upstreamError = new UpstreamApiError(
      `Proxy error for bot '${bot.name}': ${error.message}`,
      {
        cause: error,
        context: { bot: bot.key, targetUrl: targetUrl.toString() },
      },
    );
    return new Response(
      JSON.stringify({
        error: upstreamError.message,
        code: upstreamError.code,
        target: targetUrl.toString(),
      }),
      { status: upstreamError.statusCode, headers: { "Content-Type": "application/json" } },
    );
  }
}

export function createApp(config: AppConfig): Hono {
  const app = new Hono();

  // 中央エラーハンドラー (app.onError)
  app.onError(async (err: unknown, c) => {
    const error = toError(err);
    await reportSlackError(error, "http");
    if (error instanceof AppError) {
      return c.json(
        {
          error: error.message,
          code: error.code,
          ...(error.context ? { context: error.context } : {}),
        },
        // deno-lint-ignore no-explicit-any
        error.statusCode as any,
      );
    }
    return c.json(
      {
        error: error.message || "Internal Server Error",
        code: "INTERNAL_ERROR",
      },
      500,
    );
  });

  // 1. API: Gateway Health
  app.get("/api/health", async (c) => {
    let redisStatus = "disconnected";
    let redisLatencyMs: number | null = null;
    let insufficientCooldown: { active: boolean; reason?: string; expiresAt?: string; remainingSec?: number } = { active: false };
    const redisUrl = Deno.env.get("REDIS_URL") || "redis://host.docker.internal:6379";
    try {
      const { Redis } = await import("ioredis");
      const start = performance.now();
      const r = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
      await r.connect();
      const pong = await r.ping();
      redisLatencyMs = Math.round(performance.now() - start);
      if (pong === "PONG") {
        redisStatus = "connected";
        const cdRaw = await r.get("hl:system:insufficient_cooldown");
        const ttl = await r.ttl("hl:system:insufficient_cooldown");
        if (cdRaw) {
          try {
            const parsed = JSON.parse(cdRaw);
            insufficientCooldown = {
              active: Boolean(parsed.active),
              reason: parsed.reason,
              expiresAt: parsed.expiresAt,
              remainingSec: ttl > 0 ? ttl : undefined,
            };
          } catch {
            // ignore JSON parse error
          }
        }
      }
      await r.quit().catch(() => {});
    } catch {
      redisStatus = "disconnected";
    }

    return c.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      redis: redisStatus,
      redisLatencyMs,
      insufficientCooldown,
    });
  });

  // 2. API: 全BOTステータス一括取得
  app.get("/api/bots/status", async (c) => {
    const statuses = await Promise.all(config.bots.map((b) => checkBotHealth(b)));
    const allHealthy = statuses.every((s) => s.isHealthy);
    const healthyCount = statuses.filter((s) => s.isHealthy).length;

    return c.json({
      summary: {
        total: statuses.length,
        healthy: healthyCount,
        unhealthy: statuses.length - healthyCount,
        allHealthy,
      },
      bots: statuses,
    });
  });

  // 3. リバースプロキシ: /proxy/:botKey/*
  app.all("/proxy/:botKey/*", async (c) => {
    const botKey = c.req.param("botKey");
    const botResult = findBot(config, botKey);
    if (!botResult.ok) {
      return c.json({ error: botResult.error.message, code: botResult.error.code }, 404);
    }

    const pathname = new URL(c.req.url).pathname;
    const prefix = `/proxy/${botKey}`;
    const pathAfterBot = pathname.slice(prefix.length) || "/";

    return await proxyRequest(c.req.raw, botResult.value, pathAfterBot);
  });

  // 4. 静的ファイル提供 (ルートおよび SPA 静的アセット)
  app.get("*", async (c) => {
    const fileResult = await serveStaticFile(c.req.path);
    if (!fileResult.ok) {
      return c.text("Not Found", 404);
    }
    return fileResult.value;
  });

  return app;
}

if (import.meta.main) {
  installSlackErrorReporter();
  try {
    const config = loadConfig();
    console.log(
      `[hl-dashboard-webui] Starting Deno Gateway on http://${config.host}:${config.port}`,
    );
    console.log(`[hl-dashboard-webui] Monitoring ${config.bots.length} trading bots...`);

    const app = createApp(config);
    Deno.serve({ port: config.port, hostname: config.host }, app.fetch);
  } catch (error) {
    console.warn("[hl-dashboard-webui] Startup failed:", error);
    await reportSlackError(error, "server startup");
    Deno.exit(1);
  }
}
