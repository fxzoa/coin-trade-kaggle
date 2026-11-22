/**
 * btc-grid-deno: Hyperliquid WebSocket クライアント
 * リアルタイム価格 (allMids)、約定 (userFills)、注文更新 (orderUpdates) を監視
 */

import { logger } from '../logger.ts';
import { AppKvStore } from './kv_store.ts';
import { getJstIsoString } from './time_helper.ts';
import type { OrderFillRecord, OrderStatus } from '../types.ts';
import { toError } from '../errors.ts';

export interface WsPriceUpdate {
  coin: string;
  price: number;
  timestamp: number;
}

export interface HyperliquidWsOptions {
  wsUrl?: string;
  isMainnet?: boolean;
  coin?: string;
  walletAddress?: string;
  store: AppKvStore;
  onPriceUpdate?: (update: WsPriceUpdate) => void;
  onFill?: (fill: OrderFillRecord) => void;
}

/** userFills の約定1件から決定的な約定IDを生成する (hash → tid → oid/time/px/sz の連結) */
export function buildFillId(f: { hash?: string; tid?: number | string; oid?: number | string; time?: number | string; px?: string; sz?: string }): string {
  if (f.hash) return String(f.hash);
  if (f.tid !== undefined && f.tid !== null) return `tid_${f.tid}`;
  return `${f.oid ?? ''}_${f.time ?? ''}_${f.px ?? ''}_${f.sz ?? ''}`;
}

/** userFills で受信する約定1件 (利用するフィールドのみ) */
interface UserFillMessage {
  coin: string;
  px?: string;
  sz?: string;
  fee?: string;
  closedPnl?: string;
  side?: string;
  oid?: number;
  cloid?: string;
  hash?: string;
  tid?: number | string;
  time?: number | string;
}

/** orderUpdates で受信する注文更新1件 (利用するフィールドのみ) */
interface OrderUpdateMessage {
  status?: string;
  order?: { cloid?: string; oid?: number };
}

/** userFills の約定1件を約定レコードへ変換する */
function toFillRecord(f: UserFillMessage): OrderFillRecord {
  const px = parseFloat(f.px || '0');
  const sz = parseFloat(f.sz || '0');
  return {
    // 再送(スナップショット)されても同一IDになるよう、取引所由来の値のみから決定する
    fillId: buildFillId(f),
    orderId: f.oid,
    cloid: f.cloid,
    coin: f.coin.toUpperCase(),
    side: f.side === 'B' ? 'BUY' : 'SELL',
    price: px,
    size: sz,
    notionalUsd: Math.round(px * sz * 100) / 100,
    fee: parseFloat(f.fee || '0'),
    closedPnl: parseFloat(f.closedPnl || '0'),
    timestamp: getJstIsoString(),
    exchangeTime: typeof f.time === 'number' ? f.time : undefined,
  };
}

/** KV への価格保存の最小間隔 (ms) */
const KV_PRICE_SAVE_INTERVAL_MS = 2000;
/** 最小間隔内でも保存する価格変動幅 (USD) */
const KV_PRICE_SAVE_MIN_DELTA_USD = 1;
/** ping 送信間隔 (ms) */
const HEARTBEAT_INTERVAL_MS = 50000;
/** 再接続待機時間の上限 (ms) */
const MAX_RECONNECT_DELAY_MS = 30000;

export class HyperliquidWsClient {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly walletAddress?: string;
  private readonly coin: string;
  private readonly store: AppKvStore;
  private readonly onPriceUpdate?: (update: WsPriceUpdate) => void;
  private readonly onFill?: (fill: OrderFillRecord) => void;

  private isClosedExplicitly = false;
  private pingIntervalId?: ReturnType<typeof setInterval>;
  private reconnectTimeoutId?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;

  private latestMidPrice = 0;
  private lastKvPriceSaveTime = 0;
  private lastSavedPrice = 0;

  constructor(options: HyperliquidWsOptions) {
    const defaultUrl = options.isMainnet !== false
      ? 'wss://api.hyperliquid.xyz/ws'
      : 'wss://api.hyperliquid-testnet.xyz/ws';

    this.wsUrl = options.wsUrl || defaultUrl;
    this.walletAddress = options.walletAddress;
    this.coin = (options.coin || 'BTC').toUpperCase();
    this.store = options.store;
    this.onPriceUpdate = options.onPriceUpdate;
    this.onFill = options.onFill;
  }

  get currentPrice(): number {
    return this.latestMidPrice;
  }

  /**
   * WebSocket 接続の確立
   */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isClosedExplicitly = false;
    logger.info(`[HyperliquidWsClient] WS接続開始: ${this.wsUrl} (${this.coin})`);

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        logger.info('[HyperliquidWsClient] ✅ WS接続成功');
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.subscribeChannels();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (event: Event) => {
        logger.warn('[HyperliquidWsClient] ⚠️ WSエラー:', event);
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        if (!this.isClosedExplicitly) {
          this.scheduleReconnect();
        }
      };
    } catch (err: unknown) {
      logger.error('[HyperliquidWsClient] ❌ WS接続例外:', toError(err));
      this.scheduleReconnect();
    }
  }

  /**
   * 購読チャンネルの登録
   */
  private subscribeChannels(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // 1. 全銘柄中間価格 (allMids)
    this.send({
      method: 'subscribe',
      subscription: { type: 'allMids' },
    });

    // 2. ユーザー関連イベント (ウォレットアドレスが指定されている場合)
    if (this.walletAddress) {
      // 約定履歴
      this.send({
        method: 'subscribe',
        subscription: { type: 'userFills', user: this.walletAddress },
      });
      // 注文更新
      this.send({
        method: 'subscribe',
        subscription: { type: 'orderUpdates', user: this.walletAddress },
      });
      logger.info(`[HyperliquidWsClient] 📡 購読登録: allMids, userFills, orderUpdates (${this.walletAddress.slice(0, 6)}...${this.walletAddress.slice(-4)})`);
    }
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * 受信メッセージの処理 (チャンネルごとのハンドラへ振り分ける)
   */
  private async handleMessage(rawData: string): Promise<void> {
    try {
      const msg = JSON.parse(rawData);

      switch (msg.channel) {
        case 'allMids':
          if (msg.data?.mids) this.handleAllMids(msg.data.mids as Record<string, string>);
          break;
        case 'userFills':
          if (msg.data?.fills && Array.isArray(msg.data.fills)) await this.handleUserFills(msg.data.fills);
          break;
        case 'orderUpdates':
          if (Array.isArray(msg.data)) await this.handleOrderUpdates(msg.data);
          break;
        // pong / subscriptionResponse などは処理不要
      }
    } catch (err: unknown) {
      logger.warn('[HyperliquidWsClient] ⚠️ メッセージ処理エラー:', toError(err));
    }
  }

  /**
   * allMids (価格更新): 最新価格の保持・通知・間引き付き KV 保存
   */
  private handleAllMids(mids: Record<string, string>): void {
    const priceStr = mids[this.coin];
    if (!priceStr) return;

    const px = parseFloat(priceStr);
    if (!(px > 0)) return;

    this.latestMidPrice = px;
    if (this.onPriceUpdate) {
      this.onPriceUpdate({ coin: this.coin, price: px, timestamp: Date.now() });
    }
    if (Date.now() - this.lastKvPriceSaveTime > KV_PRICE_SAVE_INTERVAL_MS || Math.abs(px - this.lastSavedPrice) >= KV_PRICE_SAVE_MIN_DELTA_USD) {
      this.lastKvPriceSaveTime = Date.now();
      this.lastSavedPrice = px;
      this.store.saveCurrentPrice(px).catch((err: unknown) => {
        logger.debug('[HyperliquidWsClient] saveCurrentPrice error:', toError(err).message);
      });
    }
  }

  /**
   * userFills (約定イベント): 約定テーブルへ保存し、元注文ステータスを自動更新する
   */
  private async handleUserFills(fills: UserFillMessage[]): Promise<void> {
    for (const f of fills) {
      if (f.coin?.toUpperCase() !== this.coin) continue;

      const fillRecord = toFillRecord(f);
      logger.info(`[HyperliquidWsClient] 🎉 約定: ${fillRecord.side} ${fillRecord.coin} ${fillRecord.size} @ $${fillRecord.price.toLocaleString()} [OID: ${fillRecord.cloid || fillRecord.orderId}]`);

      // 約定テーブルへの保存と元注文ステータスの自動更新
      await this.store.saveFill(fillRecord);

      if (this.onFill) {
        this.onFill(fillRecord);
      }
    }
  }

  /**
   * orderUpdates (注文状態更新: キャンセル・約定完了)
   */
  private async handleOrderUpdates(items: OrderUpdateMessage[]): Promise<void> {
    for (const item of items) {
      const order = item.order;
      if (!order) continue;

      const targetId = order.cloid || (order.oid ? order.oid.toString() : '');
      if (!targetId) continue;

      if (item.status === 'canceled') {
        logger.info(`[HyperliquidWsClient] 📝 注文取消: [OID: ${targetId}]`);
        await this.updateOrderStatuses(targetId, 'CANCELLED');
      } else if (item.status === 'filled') {
        logger.info(`[HyperliquidWsClient] 📝 注文約定完了: [OID: ${targetId}]`);
        await this.updateOrderStatuses(targetId, 'FILLED');
      }
    }
  }

  /** グリッド注文・TP注文の両テーブルで該当注文のステータスを更新する */
  private async updateOrderStatuses(targetId: string, status: OrderStatus): Promise<void> {
    await this.store.updateGridOrderStatus(targetId, status);
    await this.store.updateTpOrderStatus(targetId, status);
  }

  /**
   * ハートビート (50秒おきのping)
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingIntervalId = setInterval(() => {
      this.send({ method: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingIntervalId !== undefined) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = undefined;
    }
  }

  /**
   * 切断時の自動再接続 (Exponential Backoff: 最大30秒)
   */
  private scheduleReconnect(): void {
    if (this.isClosedExplicitly) return;

    this.reconnectAttempts++;
    const delayMs = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    logger.warn(`[HyperliquidWsClient] ⚠️ WS切断: ${Math.round(delayMs / 1000)}秒後に再接続 (試行 #${this.reconnectAttempts})`);

    if (this.reconnectTimeoutId !== undefined) {
      clearTimeout(this.reconnectTimeoutId);
    }
    this.reconnectTimeoutId = setTimeout(() => {
      this.connect();
    }, delayMs);
  }

  /**
   * 明示的クローズ
   */
  close(): void {
    this.isClosedExplicitly = true;
    this.stopHeartbeat();
    if (this.reconnectTimeoutId !== undefined) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (err: unknown) {
        logger.debug('[HyperliquidWsClient] WS切断例外:', toError(err).message);
      }
      this.ws = null;
    }
    logger.info('[HyperliquidWsClient] WS切断完了');
  }
}
