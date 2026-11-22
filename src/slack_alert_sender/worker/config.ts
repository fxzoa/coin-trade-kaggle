/**
 * アプリケーション設定ローダー
 */

import type { AppConfig, ChannelConfig } from "./types.ts";
import { DEFAULT_REDIS_QUEUE_KEY } from "./constants.ts";
import { type LogLevel, setLogLevel } from "./logger.ts";

export function loadConfig(): AppConfig {
  const enabledStr = (Deno.env.get("NOTIFICATIONS_ENABLED") ?? "true")
    .toLowerCase();
  const notificationsEnabled = enabledStr === "true" || enabledStr === "1" ||
    enabledStr === "yes";

  const redisHost = Deno.env.get("REDIS_HOST") || "127.0.0.1";
  const redisPort = Deno.env.get("REDIS_PORT") || "6379";
  const redisPassword = Deno.env.get("REDIS_PASSWORD");
  const redisAuthPart = redisPassword ? `:${redisPassword}@` : "";
  const defaultRedisUrl = `redis://${redisAuthPart}${redisHost}:${redisPort}`;

  const redisUrl = Deno.env.get("REDIS_URL") || defaultRedisUrl;
  const redisQueueKey = Deno.env.get("REDIS_QUEUE_KEY") ||
    DEFAULT_REDIS_QUEUE_KEY;
  const slackBotToken = Deno.env.get("SLACK_BOT_TOKEN") || "";

  const channels: ChannelConfig = {
    channelNotify: Deno.env.get("SLACK_CHANNEL_NOTIFY"),
    channelError: Deno.env.get("SLACK_CHANNEL_ERROR"),
    channelBuy: Deno.env.get("SLACK_CHANNEL_BUY"),
    channelSell: Deno.env.get("SLACK_CHANNEL_SELL"),
    channelClosePlus: Deno.env.get("SLACK_CHANNEL_CLOSE_PLUS"),
    channelCloseMinus: Deno.env.get("SLACK_CHANNEL_CLOSE_MINUS"),
    channelOrdOpen: Deno.env.get("SLACK_CHANNEL_ORD_OPEN"),
    channelOrdTp: Deno.env.get("SLACK_CHANNEL_ORD_TP"),
  };

  const rawLogLevel = (Deno.env.get("LOG_LEVEL") || "INFO").toUpperCase();
  const validLogLevels: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];
  const logLevel: LogLevel = validLogLevels.includes(rawLogLevel as LogLevel)
    ? (rawLogLevel as LogLevel)
    : "INFO";

  setLogLevel(logLevel);

  return {
    slackBotToken,
    notificationsEnabled,
    redisUrl,
    redisQueueKey,
    channels,
    historyDbPath: Deno.env.get("HISTORY_DB_PATH") || "./data/slack_history.db",
    historyRetentionDays: Number(Deno.env.get("HISTORY_RETENTION_DAYS") || "0") || 0,
    logLevel,
  };
}
