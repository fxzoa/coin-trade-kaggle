/**
 * 通知結果を履歴ストアへ記録するレコーダー
 * 履歴保存の失敗は通知処理に影響させない。
 */

import type { MessageHistoryStore } from "../shared/message_history_store.ts";
import type { NotificationResult, SlackQueueMessage } from "./types.ts";
import { logger } from "./logger.ts";
import { C_WORKER } from "./constants.ts";

export class HistoryRecorder {
  constructor(private readonly store: MessageHistoryStore) {}

  public record(result: NotificationResult, msg: SlackQueueMessage): void {
    this.safeInsert({
      createdAt: Date.now(),
      type: msg.type || "UNKNOWN",
      worker: msg.worker || (msg.payload as { worker?: string })?.worker || "unknown",
      channel: result.channel,
      text: result.text ?? "",
      ok: result.ok,
      error: result.error,
      traceId: msg.traceId,
      slackTs: result.ts,
    });
  }

  /** パース不能などで通知に至らなかった生メッセージを記録 */
  public recordRawFailure(error: Error, rawData: string): void {
    this.safeInsert({
      createdAt: Date.now(),
      type: "UNKNOWN",
      worker: "unknown",
      channel: "-",
      text: rawData,
      ok: false,
      error: error.message,
    });
  }

  private safeInsert(rec: Parameters<MessageHistoryStore["insert"]>[0]): void {
    try {
      this.store.insert(rec);
    } catch (e) {
      logger.error(`${C_WORKER} 履歴保存に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
