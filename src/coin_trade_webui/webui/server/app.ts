/**
 * close-trader-webui: Hono アプリケーションルーター
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { renderCloseWebUI } from "./webui_template.ts";
import { logger } from "../../shared/logger.ts";
import type { RedisHistoryStore } from "../../shared/redis_store.ts";
import type { WebUiConfig } from "../../shared/types.ts";

export interface AppDeps {
  store: RedisHistoryStore;
  config: WebUiConfig;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { store, config } = deps;

  app.use("*", cors());

  // ルートHTML
  app.get("/", (c) => {
    return c.html(renderCloseWebUI());
  });

  // ヘルスチェック
  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      service: "coid-trade-webui",
      time: new Date().toISOString(),
      redisConnected: store.isConnected,
      channels: {
        orders: config.redisOrderResultChannel,
        closes: config.redisCloseChannel,
      },
    });
  });

  // リアルタイム SSE ストリーム (Redis Pub/Sub -> Browser)
  app.get("/api/stream", () => {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: number | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };

        send("connected", { time: new Date().toISOString() });

        unsubscribe = store.subscribe((ev) => {
          send(ev.type, ev.record);
        });

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            // ignore
          }
        }, 20000);
      },
      cancel() {
        if (unsubscribe) unsubscribe();
        if (heartbeat !== null) clearInterval(heartbeat);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  // 決済履歴一覧
  app.get("/api/history", async (c) => {
    try {
      const coin = c.req.query("coin") || undefined;
      const limitStr = c.req.query("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : 100;
      const startTimeStr = c.req.query("startTime");
      const endTimeStr = c.req.query("endTime");
      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;

      const records = await store.listCloseHistory({
        coin,
        limit,
        startTime,
        endTime,
      });

      return c.json({
        success: true,
        count: records.length,
        records,
      });
    } catch (err: any) {
      logger.error("決済履歴取得エラー:", err);
      return c.json({ success: false, error: err.message }, 500);
    }
  });

  // 統計情報
  app.get("/api/stats", async (c) => {
    try {
      const stats = await store.getStats();
      return c.json({
        success: true,
        stats,
      });
    } catch (err: any) {
      logger.error("統計情報取得エラー:", err);
      return c.json({ success: false, error: err.message }, 500);
    }
  });

  // 注文履歴一覧
  app.get("/api/orders", async (c) => {
    try {
      const coin = c.req.query("coin") || undefined;
      const limitStr = c.req.query("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : 100;
      const startTimeStr = c.req.query("startTime");
      const endTimeStr = c.req.query("endTime");
      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;

      const records = await store.listOrderHistory({
        coin,
        limit,
        startTime,
        endTime,
      });

      return c.json({
        success: true,
        count: records.length,
        records,
      });
    } catch (err: any) {
      logger.error("注文履歴取得エラー:", err);
      return c.json({ success: false, error: err.message }, 500);
    }
  });

  // 注文統計情報
  app.get("/api/order-stats", async (c) => {
    try {
      const stats = await store.getOrderStats();
      return c.json({
        success: true,
        stats,
      });
    } catch (err: any) {
      logger.error("注文統計情報取得エラー:", err);
      return c.json({ success: false, error: err.message }, 500);
    }
  });

  return app;
}
