import { ConfigError } from "../shared/price_monitor/errors.ts";
import { err, ok, type Result } from "../shared/price_monitor/result.ts";

export interface SlackChannels {
  notify: string;
  error: string;
  buy: string;
  sell: string;
  closePlus: string;
  closeMinus: string;
  ordOpen: string;
  ordTp: string;
}

export interface Config {
  wsUrl: string;
  infoUrl: string;
  userAddress?: string;
  targetCoins?: Set<string>;
  includeOutcomes: boolean;
  redisUrl: string;
  redisKeyPrefix: string;
  slackQueueKey: string;
  slackChannels: SlackChannels;
}

export function parseConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Result<Config, ConfigError> {
  const wsUrl = env.HL_WS_URL || "wss://api.hyperliquid.xyz/ws";
  if (!wsUrl.startsWith("ws://") && !wsUrl.startsWith("wss://")) {
    return err(
      new ConfigError(`Invalid HL_WS_URL: '${wsUrl}'. Must start with ws:// or wss://`, {
        context: { wsUrl },
      }),
    );
  }

  const infoUrl = env.HL_INFO_URL || "https://api.hyperliquid.xyz/info";
  if (!infoUrl.startsWith("http://") && !infoUrl.startsWith("https://")) {
    return err(
      new ConfigError(`Invalid HL_INFO_URL: '${infoUrl}'. Must start with http:// or https://`, {
        context: { infoUrl },
      }),
    );
  }

  const redisUrl = env.REDIS_URL || "redis://localhost:6379";
  if (!redisUrl.startsWith("redis://") && !redisUrl.startsWith("rediss://")) {
    return err(
      new ConfigError(
        `Invalid REDIS_URL: '${redisUrl}'. Must start with redis:// or rediss://`,
        { context: { redisUrl } },
      ),
    );
  }

  const userAddress = env.HL_USER_ADDRESS?.trim() || undefined;

  const rawTargets = env.HL_TARGET_COINS?.trim();
  const targetCoins = rawTargets
    ? new Set(rawTargets.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))
    : undefined;

  const includeOutcomes = env.HL_INCLUDE_OUTCOMES === "true" || env.HL_INCLUDE_OUTCOMES === "1";
  const redisKeyPrefix = env.REDIS_KEY_PREFIX || "hl:";
  const slackQueueKey = env.REDIS_QUEUE_KEY || env.SLACK_QUEUE_KEY || "slack:alert:queue";

  const slackChannels: SlackChannels = {
    notify:     env.SLACK_CHANNEL_NOTIFY     || "C066VHECJ7R",
    error:      env.SLACK_CHANNEL_ERROR      || "C063VF2H8ES",
    buy:        env.SLACK_CHANNEL_BUY        || "C06445Q9VA8",
    sell:       env.SLACK_CHANNEL_SELL       || "C067GQ7SM5F",
    closePlus:  env.SLACK_CHANNEL_CLOSE_PLUS || "C0644H4P84U",
    closeMinus: env.SLACK_CHANNEL_CLOSE_MINUS || "C066PJS0QEB",
    ordOpen:    env.SLACK_CHANNEL_ORD_OPEN   || "C04JW4TBMU6",
    ordTp:      env.SLACK_CHANNEL_ORD_TP     || "C067CQ8CJ3W",
  };

  return ok({
    wsUrl,
    infoUrl,
    userAddress,
    targetCoins,
    includeOutcomes,
    redisUrl,
    redisKeyPrefix,
    slackQueueKey,
    slackChannels,
  });
}

export function loadConfig(env?: Record<string, string | undefined>): Config {
  const result = parseConfig(env);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
