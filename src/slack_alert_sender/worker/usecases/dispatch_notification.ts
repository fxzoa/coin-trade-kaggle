/**
 * 通知ディスパッチユースケース
 */

import type {
  ChannelConfig,
  NotificationResult,
  SendClosePositionAlertRequest,
  SendErrorAlertRequest,
  SendFillEventAlertRequest,
  SendInfoAlertRequest,
  SendOrderCanceledAlertRequest,
  SendOrderOpenAlertRequest,
  SendTextMessageRequest,
  SlackQueueMessage,
} from "../types.ts";
import { DEFAULT_CHANNELS } from "../constants.ts";
import {
  resolveChannel,
  resolveClosePositionChannel,
  resolveErrorChannel,
  resolveFillChannel,
  resolveInfoChannel,
  resolveOrderCanceledChannel,
  resolveOrderOpenChannel,
  resolveTextChannel,
} from "../domain/channel_resolver.ts";
import {
  formatClosePositionMessage,
  formatErrorMessage,
  formatFillEventMessage,
  formatInfoMessage,
  formatOrderCanceledMessage,
  formatOrderOpenMessage,
} from "../domain/formatters.ts";
import type { SlackNotificationGateway } from "../gateways/slack_gateway.ts";

export class UnsupportedNotificationTypeError extends Error {
  constructor(type: string) {
    super(`未対応の通知タイプです: ${type}`);
    this.name = "UnsupportedNotificationTypeError";
  }
}

export class DispatchNotificationUseCase {
  constructor(
    private readonly gateway: SlackNotificationGateway,
    private readonly channelConfig: ChannelConfig,
  ) {}

  public async execute(
    message: SlackQueueMessage,
  ): Promise<NotificationResult> {
    const { type, payload, traceId } = message;

    switch (type) {
      case "ORD_OPEN":
      case "ORD_TP":
      case "BUY":
      case "SELL":
      case "CLOSE_PLUS":
      case "CLOSE_MINUS": {
        const req = payload as Record<string, unknown> & {
          text?: string;
          channel?: string;
        };
        const channel = (() => {
          switch (type) {
            case "ORD_OPEN":
              return resolveOrderOpenChannel(req.channel, this.channelConfig);
            case "ORD_TP":
              return resolveOrderCanceledChannel(
                req.channel,
                this.channelConfig,
              );
            case "BUY":
              return resolveChannel(
                req.channel,
                this.channelConfig.channelBuy,
                DEFAULT_CHANNELS.BUY,
              );
            case "SELL":
              return resolveChannel(
                req.channel,
                this.channelConfig.channelSell,
                DEFAULT_CHANNELS.SELL,
              );
            case "CLOSE_PLUS":
              return resolveChannel(
                req.channel,
                this.channelConfig.channelClosePlus,
                DEFAULT_CHANNELS.CLOSE_PLUS,
              );
            case "CLOSE_MINUS":
              return resolveChannel(
                req.channel,
                this.channelConfig.channelCloseMinus,
                DEFAULT_CHANNELS.CLOSE_MINUS,
              );
          }
        })();
        const text = typeof req.text === "string"
          ? req.text
          : JSON.stringify(req);
        return await this.gateway.send(channel, text, traceId);
      }

      case "TEXT": {
        const req = payload as SendTextMessageRequest;
        const explicitChannel = message.worker === "volume-change-monitor"
          ? undefined
          : req.channel;
        const channel = resolveTextChannel(explicitChannel, this.channelConfig);
        return await this.gateway.send(
          channel,
          req.text,
          traceId || req.traceId,
        );
      }

      case "ERROR": {
        const req = payload as SendErrorAlertRequest;
        const channel = resolveErrorChannel(req.channel, this.channelConfig);
        const text = formatErrorMessage(req);
        return await this.gateway.send(channel, text, traceId || req.traceId);
      }

      case "INFO": {
        const req = payload as SendInfoAlertRequest;
        const channel = resolveInfoChannel(req.channel, this.channelConfig);
        const text = formatInfoMessage(req);
        return await this.gateway.send(channel, text, traceId || req.traceId);
      }

      case "ORDER_OPEN": {
        const req = payload as SendOrderOpenAlertRequest;
        const channel = resolveOrderOpenChannel(
          req.channel,
          this.channelConfig,
        );
        const text = formatOrderOpenMessage(req);
        return await this.gateway.send(channel, text, traceId || req.traceId);
      }

      case "ORDER_CANCELED": {
        const req = payload as SendOrderCanceledAlertRequest;
        const channel = resolveOrderCanceledChannel(
          req.channel,
          this.channelConfig,
        );
        const text = formatOrderCanceledMessage(req);
        return await this.gateway.send(channel, text, traceId || req.traceId);
      }

      case "CLOSE_POSITION": {
        const req = payload as SendClosePositionAlertRequest;
        const channel = resolveClosePositionChannel(req, this.channelConfig);
        const text = formatClosePositionMessage(req);
        return await this.gateway.send(channel, text, traceId || req.traceId);
      }

      case "FILL": {
        const req = payload as SendFillEventAlertRequest;
        const channel = resolveFillChannel(req, this.channelConfig);
        const text = formatFillEventMessage(req);
        return await this.gateway.send(channel, text, traceId || req.traceId);
      }

      default:
        throw new UnsupportedNotificationTypeError(type);
    }
  }
}
