/**
 * Redis 接続マネージャー
 */

import { Redis, type RedisOptions } from "ioredis";
import { logger } from "../logger.ts";
import { C_WORKER } from "../constants.ts";

export function createRedisClient(urlOrOptions: string | RedisOptions): Redis {
  const options: RedisOptions = typeof urlOrOptions === "string"
    ? {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      autoResubscribe: true,
      retryStrategy(times: number) {
        const delay = Math.min(times * 200, 3000);
        logger.warn(
          `${C_WORKER} Redis 再接続試行中... (${times} 回目, 遅延: ${delay}ms)`,
        );
        return delay;
      },
    }
    : {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      autoResubscribe: true,
      ...urlOrOptions,
    };

  const client = typeof urlOrOptions === "string"
    ? new Redis(urlOrOptions, options)
    : new Redis(options);

  client.on("connect", () => {
    logger.info(`${C_WORKER} Redis 接続確立`);
  });

  client.on("ready", () => {
    logger.info(`${C_WORKER} Redis レディ完了`);
  });

  client.on("error", (err: Error) => {
    logger.error(`${C_WORKER} Redis エラー: ${err.message}`);
  });

  client.on("close", () => {
    logger.warn(`${C_WORKER} Redis 接続切断`);
  });

  return client;
}
