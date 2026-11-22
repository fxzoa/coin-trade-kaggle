/**
 * Slack 通知ゲートウェイ
 * Slack chat.postMessage API との HTTP 通信を担当
 */

import type { NotificationResult } from "../types.ts";
import { logger } from "../logger.ts";
import { C_WORKER } from "../constants.ts";

export interface SlackGatewayConfig {
  notificationsEnabled?: boolean;
  botToken: string;
  slackApiUrl?: string;
  fetchFn?: typeof fetch;
}

export class SlackNotificationGateway {
  private readonly enabled: boolean;
  private readonly botToken: string;
  private readonly slackApiUrl: string;
  private readonly fetch: typeof fetch;

  constructor(config: SlackGatewayConfig) {
    this.enabled = config.notificationsEnabled ?? true;
    this.botToken = config.botToken.trim();
    this.slackApiUrl = config.slackApiUrl ||
      "https://slack.com/api/chat.postMessage";
    this.fetch = config.fetchFn || globalThis.fetch;
  }

  /**
   * 通知機能が有効化されているかどうか判定
   */
  public isEnabled(): boolean {
    return this.enabled && this.botToken.length > 0;
  }

  /**
   * Slack API chat.postMessage へのメッセージ送信
   */
  public async send(
    channel: string,
    text: string,
    traceId?: string,
  ): Promise<NotificationResult> {
    const result = await this.dispatch(channel, text, traceId);
    return { ...result, text };
  }

  private async dispatch(
    channel: string,
    text: string,
    traceId?: string,
  ): Promise<NotificationResult> {
    if (!this.isEnabled()) {
      const msg =
        `${C_WORKER} Slack 通知が無効化されているか SLACK_BOT_TOKEN が未設定です。送信をスキップします。`;
      logger.warn(msg);
      return {
        ok: false,
        channel,
        error: "Notifications disabled or token missing",
      };
    }

    if (!channel || channel.trim().length === 0) {
      const msg = `${C_WORKER} 送信先チャンネルIDが空です。`;
      logger.error(msg);
      return { ok: false, channel, error: "Empty channel ID" };
    }

    // Traceヘッダーの付加
    let formattedText = text;
    if (traceId && traceId.trim().length > 0) {
      const traceShort = traceId.length > 8 ? traceId.slice(0, 8) : traceId;
      formattedText = `🌐 \`[Trace: ${traceShort}]\`\n${text}`;
    }

    const payload = {
      channel: channel.trim(),
      text: formattedText,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);

      const response = await this.fetch(this.slackApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Authorization": `Bearer ${this.botToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json();

      if (!response.ok || !data.ok) {
        const errorDetail = data.error ||
          `HTTP ${response.status} ${response.statusText}`;
        logger.error(
          `${C_WORKER} Slack API 送信エラー (channel=${channel}): ${errorDetail}`,
        );
        return {
          ok: false,
          channel,
          error: errorDetail,
        };
      }

      logger.info(
        `${C_WORKER} Slack メッセージ送信成功 (channel=${channel}, ts=${data.ts})`,
      );
      return {
        ok: true,
        channel,
        ts: data.ts,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        `${C_WORKER} Slack API 接続例外 (channel=${channel}): ${errorMsg}`,
      );
      return {
        ok: false,
        channel,
        error: errorMsg,
      };
    }
  }
}
