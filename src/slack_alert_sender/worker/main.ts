/**
 * slack-alert-deno: 常駐 Redis キュー Worker エントリーポイント
 */

import { loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { C_WORKER } from "./constants.ts";
import { createRedisClient } from "./queue/connection.ts";
import { SlackNotificationGateway } from "./gateways/slack_gateway.ts";
import { DispatchNotificationUseCase } from "./usecases/dispatch_notification.ts";
import { QueueConsumer } from "./queue/consumer.ts";
import { MessageHistoryStore } from "../shared/message_history_store.ts";
import { HistoryRecorder } from "./history_recorder.ts";

async function main() {
  logger.info(`${C_WORKER} サービス起動中...`);
  const config = loadConfig();

  logger.info(
    `${C_WORKER} 設定読み込み完了: Redis=${config.redisUrl}, Queue=${config.redisQueueKey}, Enabled=${config.notificationsEnabled}`,
  );

  if (!config.slackBotToken) {
    logger.warn(
      `${C_WORKER} 警告: SLACK_BOT_TOKEN が設定されていません。Slack通知はスキップされます。`,
    );
  }

  // Redis クライアント初期化
  const redis = createRedisClient(config.redisUrl);

  // 履歴ストア (WebUI と DB ファイルを共有)
  const historyStore = new MessageHistoryStore(config.historyDbPath);
  const recorder = new HistoryRecorder(historyStore);
  if (config.historyRetentionDays > 0) {
    const purged = historyStore.purgeOlderThan(config.historyRetentionDays);
    logger.info(`${C_WORKER} 履歴保持期間 ${config.historyRetentionDays}日: ${purged}件を削除`);
  }

  // 依存関係構築
  const slackGateway = new SlackNotificationGateway({
    notificationsEnabled: config.notificationsEnabled,
    botToken: config.slackBotToken,
  });

  const useCase = new DispatchNotificationUseCase(
    slackGateway,
    config.channels,
  );

  const consumer = new QueueConsumer(redis, useCase, {
    queueKey: config.redisQueueKey,
    popTimeoutSeconds: 2,
    onNotificationSent: (result, msg) => {
      recorder.record(result, msg);
      logger.info(
        `${C_WORKER} 通知処理完了: type=${msg.type}, ok=${result.ok}, channel=${result.channel}`,
      );
    },
    onError: (err, rawData) => {
      if (rawData) recorder.recordRawFailure(err, rawData);
      logger.error(`${C_WORKER} コンシューマーエラー: ${err.message}`);
    },
  });

  // Graceful Shutdown ハンドラー
  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(
      `\n${C_WORKER} ${signal} 受信。Graceful Shutdown を開始します...`,
    );

    consumer.stop();

    try {
      historyStore.close();
    } catch { /* ignore */ }

    try {
      await redis.quit();
      logger.info(`${C_WORKER} Redis 接続を正常に切断しました`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`${C_WORKER} Redis 切断時エラー: ${msg}`);
    }

    logger.info(`${C_WORKER} サービス停止完了`);
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", () => handleShutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => handleShutdown("SIGTERM"));

  // キュー待機ループ開始
  await consumer.start();
}

if (import.meta.main) {
  installSlackErrorReporter("slack-alert-sender");
  main().catch(async (err) => {
    logger.warn(`${C_WORKER} 起動時致命的エラー:`, err);
    await reportSlackError(err, "worker startup");
    Deno.exit(1);
  });
}
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
