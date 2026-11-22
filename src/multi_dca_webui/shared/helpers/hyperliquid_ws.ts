/**
 * dca-deno: Hyperliquid WebSocket クライアント
 * リアルタイム 4H KLINE、リアルタイム価格 (allMids)、オーダー変動 (orderUpdates)、約定 (userFills) を常時監視
 */

import { logger } from '../logger.ts';
import type { DcaKvStore } from './kv_store.ts';
import type { OrderRecord, OrderFillRecord } from '../types.ts';
import { getJstIsoString } from './time_helper.ts';
import { toError } from '../errors.ts';

export interface HyperliquidWsOptions {
  wsUrl?: string;
  isMainnet?: boolean;
  targetCoins: string[];
  walletAddress?: string;
  store: DcaKvStore;
  onCandle?: (candle: any) => void;
  onPriceUpdate?: (coin: string, price: number) => void;
  onOrderUpdate?: (order: OrderRecord) => void;
  onFill?: (fill: OrderFillRecord) => void;
}

export class HyperliquidWsClient {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly targetCoins: string[];
  private readonly walletAddress?: string;
  private readonly store: DcaKvStore;
  private readonly onCandle?: (candle: any) => void;
  private readonly onPriceUpdate?: (coin: string, price: number) => void;
  private readonly onOrderUpdate?: (order: OrderRecord) => void;
  private readonly onFill?: (fill: OrderFillRecord) => void;

  private isClosedExplicitly = false;
  private pingIntervalId?: ReturnType<typeof setInterval>;
  private reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;

  // 最新の中間価格キャッシュ
  private latestPrices = new Map<string, number>();

  constructor(options: HyperliquidWsOptions) {
    const defaultUrl = options.isMainnet !== false
      ? 'wss://api.hyperliquid.xyz/ws'
      : 'wss://api.hyperliquid-testnet.xyz/ws';

    this.wsUrl = options.wsUrl || defaultUrl;
    this.targetCoins = options.targetCoins.map((c) => c.toUpperCase());
    this.walletAddress = options.walletAddress;
    this.store = options.store;
    this.onCandle = options.onCandle;
    this.onPriceUpdate = options.onPriceUpdate;
    this.onOrderUpdate = options.onOrderUpdate;
    this.onFill = options.onFill;
  }

  getPrice(coin: string): number {
    return this.latestPrices.get(coin.toUpperCase()) || 0;
  }

  start(): void {
    this.isClosedExplicitly = false;
    this.connect();
  }

  stop(): void {
    this.isClosedExplicitly = true;
    this.cleanup();
  }

  private connect(): void {
    if (this.isClosedExplicitly) return;

    logger.info(`[HyperliquidWsClient] 🔌 WebSocket 接続開始: ${this.wsUrl} (監視対象通貨: ${this.targetCoins.join(', ')})`);
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        logger.info(`[HyperliquidWsClient] ✅ WebSocket 接続確立完了 (接続先: ${this.wsUrl})`);
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.subscribeChannels();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          this.handleMessage(msg);
        } catch (err: unknown) {
          logger.error('[HyperliquidWsClient] ❌ メッセージパースエラー:', toError(err));
        }
      };

      this.ws.onerror = (event: Event) => {
        logger.error('[HyperliquidWsClient] ❌ WebSocket 通信エラー検知:', (event as ErrorEvent).message || '通信異常');
      };

      this.ws.onclose = () => {
        logger.warn('[HyperliquidWsClient] ⚠️ WebSocket 接続が切断されました。再接続プロセスを開始します');
        this.cleanup();
        this.scheduleReconnect();
      };
    } catch (err: unknown) {
      logger.error('[HyperliquidWsClient] ❌ 接続試行例外:', toError(err));
      this.scheduleReconnect();
    }
  }

  private subscribeChannels(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // 1. 各対象通貨の 4H KLINE を購読
    for (const coin of this.targetCoins) {
      this.send({
        method: 'subscribe',
        subscription: {
          type: 'candle',
          coin,
          interval: '4h',
        },
      });
      logger.info(`[HyperliquidWsClient] 📡 4H KLINE 購読: ${coin} (interval: 4h)`);
    }

    // 2. 全通貨リアルタイム中間価格を購読
    this.send({
      method: 'subscribe',
      subscription: {
        type: 'allMids',
      },
    });
    logger.info(`[HyperliquidWsClient] 📡 リアルタイム価格購読: allMids`);

    // 3. ユーザーのオーダー変動 & 約定を購読 (ウォレットアドレスがある場合)
    if (this.walletAddress) {
      this.send({
        method: 'subscribe',
        subscription: {
          type: 'orderUpdates',
          user: this.walletAddress,
        },
      });
      this.send({
        method: 'subscribe',
        subscription: {
          type: 'userFills',
          user: this.walletAddress,
        },
      });
      logger.info(`[HyperliquidWsClient] 📡 オーダー・約定変動購読: ${this.walletAddress.substring(0, 8)}...`);
    }
  }

  private handleMessage(msg: any): void {
    if (!msg || !msg.channel) return;

    // A. 4H KLINE (candle) 更新
    if (msg.channel === 'candle' && msg.data) {
      if (this.onCandle) {
        this.onCandle(msg.data);
      }
      return;
    }

    // B. allMids (全通貨リアルタイム価格)
    if (msg.channel === 'allMids' && msg.data && msg.data.mids) {
      for (const coin of this.targetCoins) {
        const rawPx = msg.data.mids[coin];
        if (rawPx !== undefined) {
          const px = parseFloat(rawPx);
          this.latestPrices.set(coin, px);
          if (this.onPriceUpdate) {
            this.onPriceUpdate(coin, px);
          }
        }
      }
      return;
    }

    // C. orderUpdates (HYで発注成功した既存注文のみステータス更新)
    if (msg.channel === 'orderUpdates' && Array.isArray(msg.data)) {
      const nowIso = getJstIsoString();
      for (const item of msg.data) {
        const o = item.order || item;
        const oid = o.oid ? Number(o.oid) : undefined;
        const cloid = o.cloid || '';
        const status = (item.status || o.status || 'OPEN').toUpperCase();

        (async () => {
          // 本ボットが HY で発注成功し、既に orders テーブルに登録済みの注文のみ検索
          let existing: OrderRecord | null = null;
          if (cloid) {
            existing = await this.store.getOrderByCloid(cloid);
          }
          if (!existing && oid) {
            existing = await this.store.getOrder(oid.toString());
          }

          // 登録済みの注文が存在する場合のみステータスを更新 (外部注文は新規登録しない)
          if (existing) {
            existing.status = status === 'FILLED' ? 'FILLED' : status === 'CANCELED' || status === 'CANCELLED' ? 'CANCELLED' : 'OPEN';
            existing.updatedAt = nowIso;
            await this.store.saveOrder(existing);
            logger.info(`[HyperliquidWsClient] 📝 注文ステータス更新: ${existing.coin} [${existing.id}] -> ${existing.status}`);
            if (this.onOrderUpdate) {
              this.onOrderUpdate(existing);
            }
          }
        })().catch((e: unknown) => logger.error('[HyperliquidWsClient] 注文ステータス更新エラー:', toError(e)));
      }
      return;
    }

    // D. userFills (監視対象通貨の約定のみ検知・保存)
    if (msg.channel === 'userFills' && msg.data && Array.isArray(msg.data.fills)) {
      const nowIso = getJstIsoString();
      for (const f of msg.data.fills) {
        const coin = (f.coin || '').toUpperCase();
        // 監視対象通貨以外の外部取引は約定テーブルに保存しない
        if (!this.targetCoins.includes(coin)) {
          continue;
        }

        const px = parseFloat(f.px || '0');
        const sz = parseFloat(f.sz || '0');
        const fillRecord: OrderFillRecord = {
          fillId: f.hash || `${f.tid || Date.now()}_${f.oid}`,
          orderId: f.oid,
          cloid: f.cloid,
          coin,
          side: f.side === 'B' ? 'BUY' : 'SELL',
          price: px,
          size: sz,
          notionalUsd: Math.round(px * sz * 100) / 100,
          fee: parseFloat(f.fee || '0'),
          closedPnl: parseFloat(f.closedPnl || '0'),
          timestamp: nowIso,
        };

        this.store.saveFill(fillRecord).catch((e: unknown) => logger.error('[HyperliquidWsClient] ❌ 約定保存エラー:', toError(e)));
        logger.info(
          `[HyperliquidWsClient] 🎉 約定検知: ${coin} ${fillRecord.side} 価格=$${px}, 数量=${sz} (約定金額=$${fillRecord.notionalUsd}, 手数料=$${fillRecord.fee})`
        );
        if (this.onFill) {
          this.onFill(fillRecord);
        }
      }
      return;
    }
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingIntervalId = setInterval(() => {
      this.send({ method: 'ping' });
    }, 30000); // 30秒ごとに ping
  }

  private stopHeartbeat(): void {
    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.isClosedExplicitly) return;
    if (this.reconnectTimeoutId) return;

    this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(1.5, this.reconnectAttempts));
    const delaySec = Math.round(delay / 1000);
    logger.info(`[HyperliquidWsClient] 🔄 ${delaySec} 秒後に再接続を試みます (再接続試行 ${this.reconnectAttempts} 回目)`);

    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = undefined;
      this.connect();
    }, delay);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
