/**
 * slack-alert-webui エントリーポイント (Worker とは別プロセス)
 */

import { MessageHistoryStore } from "../shared/message_history_store.ts";
import { Redis } from "ioredis";
import { HistoryWebServer } from "./server.ts";

const port = Number(Deno.env.get("WEB_PORT") || Deno.env.get("PORT") || "8010");
const redisUrl = Deno.env.get("REDIS_URL") || "redis://127.0.0.1:6379";
const queueKey = Deno.env.get("REDIS_QUEUE_KEY") || "slack:alert:queue";
const dbPath = Deno.env.get("HISTORY_DB_PATH") || "./data/slack_history.db";

console.log(`[SlackWebUI] Port=${port} DB=${dbPath}`);
const store = new MessageHistoryStore(dbPath);
const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

const enqueueTestMessage = async (): Promise<string> => {
  const traceId = `webui-test-${Date.now()}`;
  await redis.lpush(
    queueKey,
    JSON.stringify({
      type: "TEXT",
      worker: "slack-alert-webui",
      traceId,
      timestamp: Date.now(),
      payload: { text: `🧪 [テスト通知] Slack Alert Bot WebUI からの疎通テスト (${traceId})` },
    }),
  );
  return traceId;
};

const server = new HistoryWebServer({ port, store, enqueueTestMessage });
installSlackErrorReporter("slack-alert-sender-webui");
try {
  await server.start();
} catch (error) {
  await reportSlackError(error, "webui startup");
  throw error;
}

const shutdown = async () => {
  await server.stop();
  store.close();
  redis.disconnect();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
