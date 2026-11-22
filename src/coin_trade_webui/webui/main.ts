/**
 * close-trader-webui: メインエントリポイント
 */

import "@std/dotenv/load";
import { logger, setLogLevel } from "../shared/logger.ts";
import { RedisHistoryStore } from "../shared/redis_store.ts";
import { createApp } from "./server/app.ts";
import type { WebUiConfig } from "../shared/types.ts";

const config: WebUiConfig = {
  port: parseInt(Deno.env.get("PORT") || "8013", 10),
  redisUrl: Deno.env.get("REDIS_URL") || "redis://host.docker.internal:6379",
  redisOrderResultChannel: Deno.env.get("REDIS_ORDER_RESULT_CHANNEL") || "hl:events:orders:result",
  redisOrderHistoryKey: Deno.env.get("REDIS_ORDER_HISTORY_KEY") || "hl:history:orders:result",
  redisCloseChannel: Deno.env.get("REDIS_CLOSE_CHANNEL") || "hl:events:closes",
  redisCloseHistoryKey: Deno.env.get("REDIS_CLOSE_HISTORY_KEY") || "hl:history:closes",
  logLevel: Deno.env.get("LOG_LEVEL") || "INFO",
};

setLogLevel(config.logLevel);

logger.info("========================================================");
logger.info("🚀 coid-trade-webui (Redis Pub/Sub 新規注文・決済履歴ダッシュボード) 起動中");
logger.info(`- ポート: ${config.port}`);
logger.info(`- Redis URL: ${config.redisUrl}`);
logger.info(`- 新規注文 Pub/Sub: ${config.redisOrderResultChannel}`);
logger.info(`- 決済注文 Pub/Sub: ${config.redisCloseChannel}`);
logger.info("========================================================");

const store = new RedisHistoryStore(config);
await store.init();

const app = createApp({ store, config });

const server = Deno.serve(
  {
    port: config.port,
    onListen({ port, hostname }) {
      logger.info(`[WebUI] 🌐 サーバー稼働中: http://${hostname || "localhost"}:${port}/`);
    },
  },
  app.fetch,
);

const shutdown = async (signal: string) => {
  logger.info(`[WebUI] ${signal} 受信。サーバーシャットダウン中...`);
  await server.shutdown();
  await store.close();
  logger.info("[WebUI] 正常終了");
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
