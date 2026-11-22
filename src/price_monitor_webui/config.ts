import { ConfigError } from "../shared/price_monitor/errors.ts";
import { err, ok, type Result } from "../shared/price_monitor/result.ts";

export interface WebConfig {
  port: number;
  redisUrl: string;
  redisKeyPrefix: string;
  userAddress?: string;
  kvPath?: string;
}

export function parseConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Result<WebConfig, ConfigError> {
  const portStr = env.PORT || env.WEB_PORT || "8005";
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    return err(
      new ConfigError(`Invalid PORT: '${portStr}'. Must be an integer between 1 and 65535`, {
        context: { port: portStr },
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

  const redisKeyPrefix = env.REDIS_KEY_PREFIX || "hl:";
  const userAddress = env.HL_USER_ADDRESS?.trim() || undefined;
  const kvPath = env.KV_PATH?.trim() || undefined;

  return ok({
    port,
    redisUrl,
    redisKeyPrefix,
    userAddress,
    kvPath,
  });
}

export function loadConfig(env?: Record<string, string | undefined>): WebConfig {
  const result = parseConfig(env);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
