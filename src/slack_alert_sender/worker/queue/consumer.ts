/**
 * Redis キュー コンシューマー (BRPOP ループ)
 */

import type { Redis } from "ioredis";
import type { NotificationResult, SlackQueueMessage } from "../types.ts";
import type { DispatchNotificationUseCase } from "../usecases/dispatch_notification.ts";
import { logger } from "../logger.ts";
import { C_WORKER } from "../constants.ts";

export interface QueueConsumerOptions {
  queueKey: string;
  popTimeoutSeconds?: number;
  onNotificationSent?: (
    result: NotificationResult,
    message: SlackQueueMessage,
  ) => void;
  onError?: (error: Error, rawData?: string) => void;
}

export class QueueConsumer {
  private isRunning = false;
  private readonly queueKey: string;
  private readonly popTimeoutSeconds: number;
  private currentAbortController: AbortController | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly useCase: DispatchNotificationUseCase,
    private readonly options: QueueConsumerOptions,
  ) {
    this.queueKey = options.queueKey;
    this.popTimeoutSeconds = options.popTimeoutSeconds ?? 2;
  }

  /**
   * コンシューマーループを開始
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(`${C_WORKER} コンシューマーは既に実行中です`);
      return;
    }

    this.isRunning = true;
    logger.info(
      `${C_WORKER} Redis キューコンシューマー開始: queue=${this.queueKey}`,
    );

    while (this.isRunning) {
      try {
        // BRPOP: 末尾からブロック pop (戻り値: [key, element] または null)
        const result = await this.redis.brpop(
          this.queueKey,
          this.popTimeoutSeconds,
        );

        if (!result) {
          // タイムアウト時はループ継続
          continue;
        }

        const [, rawMessage] = result;
        await this.processRawMessage(rawMessage);
      } catch (err) {
        if (!this.isRunning) {
          // 停止指示による正常終了
          break;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`${C_WORKER} キュー受信ループ例外: ${error.message}`);
        if (this.options.onError) {
          this.options.onError(error);
        }
        // 連続高速ループによるCPU高負荷・接続エラー時の連鎖を防ぐ待機
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.info(`${C_WORKER} Redis キューコンシューマーループ終了`);
  }

  /**
   * 1件の生メッセージをパースして通知実行
   */
  public async processRawMessage(
    rawMessage: string,
  ): Promise<NotificationResult | null> {
    let message: SlackQueueMessage;
    try {
      message = JSON.parse(rawMessage) as SlackQueueMessage;
    } catch (parseErr) {
      const err = parseErr instanceof Error
        ? parseErr
        : new Error(String(parseErr));
      logger.error(
        `${C_WORKER} キューメッセージの JSON パース失敗: ${err.message}, raw=${rawMessage}`,
      );
      if (this.options.onError) {
        this.options.onError(err, rawMessage);
      }
      return null;
    }

    const msgType = message.type || "UNKNOWN";
    logger.info(
      `${C_WORKER} キューメッセージ受信: type=${msgType}, id=${
        message.id || "N/A"
      }`,
    );

    try {
      const result = await this.useCase.execute(message);
      if (this.options.onNotificationSent) {
        this.options.onNotificationSent(result, message);
      }
      return result;
    } catch (execErr) {
      const err = execErr instanceof Error
        ? execErr
        : new Error(String(execErr));
      logger.error(`${C_WORKER} 通知ディスパッチ実行時エラー: ${err.message}`);
      if (this.options.onError) {
        this.options.onError(err, rawMessage);
      }
      const failed: NotificationResult = {
        ok: false,
        channel: "UNKNOWN",
        error: err.message,
        text: JSON.stringify(message.payload ?? {}),
      };
      if (this.options.onNotificationSent) {
        this.options.onNotificationSent(failed, message);
      }
      return failed;
    }
  }

  /**
   * コンシューマーの安全な停止 (Graceful Shutdown)
   */
  public stop(): void {
    if (!this.isRunning) return;
    logger.info(`${C_WORKER} コンシューマー停止処理開始...`);
    this.isRunning = false;
  }

  public get running(): boolean {
    return this.isRunning;
  }
}
