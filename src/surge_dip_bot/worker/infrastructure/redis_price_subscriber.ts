import { Redis } from "ioredis";
import type { PriceTick } from "../../shared/domain/types.ts";

export interface RedisPriceSubscriberOptions {
  redisUrl: string;
  channel?: string;
  onPrices: (ticks: PriceTick[]) => void;
  onLog?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * syncer サービスが発行する `hl:events:prices` を購読し、
 * 受信したリアルタイム価格マップを PriceTick[] に変換してコールバックに渡す。
 */
export class RedisPriceSubscriber {
  private client: InstanceType<typeof Redis>;
  private channel: string;
  private onPrices: (ticks: PriceTick[]) => void;
  private onLog: (msg: string) => void;
  private onError: (err: unknown) => void;
  private closed = false;

  constructor(opts: RedisPriceSubscriberOptions) {
    this.channel = opts.channel ?? "hl:events:prices";
    this.onPrices = opts.onPrices;
    this.onLog = opts.onLog ?? console.log;
    this.onError = opts.onError ?? console.error;

    this.client = new Redis(opts.redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => {
        if (this.closed) return null;
        const delay = Math.min(times * 500, 5000);
        this.onLog(`[RedisPriceSubscriber] ${delay}ms 後に再接続します (試行 ${times})`);
        return delay;
      },
    });

    this.client.on("connect", () => {
      this.onLog(`[RedisPriceSubscriber] Redis に接続しました: ${opts.redisUrl}`);
    });

    this.client.on("error", (err: unknown) => {
      if (!this.closed) {
        this.onError(`[RedisPriceSubscriber] エラー: ${err}`);
      }
    });

    this.client.on("message", (channel: string, message: string) => {
      if (channel !== this.channel) return;
      this.handleMessage(message);
    });
  }

  async start(): Promise<void> {
    this.closed = false;
    try {
      await this.client.subscribe(this.channel);
      this.onLog(`[RedisPriceSubscriber] チャンネル '${this.channel}' を購読開始しました`);
    } catch (err) {
      this.onError(`[RedisPriceSubscriber] 購読の開始に失敗しました: ${err}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.client.unsubscribe(this.channel);
      await this.client.quit();
      this.onLog("[RedisPriceSubscriber] 接続を終了しました");
    } catch (err) {
      this.onError(`[RedisPriceSubscriber] 切断時にエラーが発生しました: ${err}`);
    }
  }

  private handleMessage(message: string): void {
    try {
      const parsed = JSON.parse(message);
      if (typeof parsed !== "object" || parsed === null) return;
      const prices = parsed.prices;
      if (typeof prices !== "object" || prices === null) return;

      const now = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      const ticks: PriceTick[] = [];

      for (const [symbol, val] of Object.entries(prices)) {
        const price = typeof val === "number" ? val : Number(val);
        if (Number.isFinite(price)) {
          ticks.push({ symbol, price, timestamp: now });
        }
      }

      if (ticks.length > 0) {
        this.onPrices(ticks);
      }
    } catch (e) {
      this.onError(`[RedisPriceSubscriber] メッセージのパースに失敗しました: ${e}`);
    }
  }
}
