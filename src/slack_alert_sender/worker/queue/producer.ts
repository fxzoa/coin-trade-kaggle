/**
 * Redis キュー プロデューサー (LPUSH)
 */

import type { Redis } from "ioredis";
import type { SlackQueueMessage } from "../types.ts";
import { logger } from "../logger.ts";
import { C_WORKER } from "../constants.ts";

export class QueueProducer {
  constructor(
    private readonly redis: Redis,
    private readonly queueKey: string,
  ) {}

  /**
   * メッセージをキューにプッシュ (LPUSH)
   * @returns プッシュ後のキューの長さ
   */
  public async push(message: SlackQueueMessage): Promise<number> {
    const payloadWithMeta: SlackQueueMessage = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };

    const serialized = JSON.stringify(payloadWithMeta);
    const queueLength = await this.redis.lpush(this.queueKey, serialized);
    logger.debug(
      `${C_WORKER} キューにメッセージ投入成功: type=${message.type}, queue=${this.queueKey}, len=${queueLength}`,
    );
    return queueLength;
  }

  /**
   * 現在のキュー長を取得
   */
  public async getQueueLength(): Promise<number> {
    return await this.redis.llen(this.queueKey);
  }
}
