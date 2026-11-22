import { Redis } from "ioredis";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import {
  REDIS_CHANNEL_SIGNALS,
  REDIS_KEY_SIGNALS_LIST,
} from "../../shared/domain/trade_mode.ts";

export interface RedisSignalRecord {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  price: number;
  signalType: string;
  source: string;
  status: "NEW" | "EXECUTED" | "SKIPPED";
  targetSize: number;
  changePct: number | null;
  timestamp: number;
  createdAt: string;
}

export class RedisSignalRepository {
  private client: InstanceType<typeof Redis>;
  private maxListLength: number;
  private onLog: (msg: string) => void;
  private onError: (msg: string) => void;

  constructor(options: {
    redisUrl?: string;
    client?: InstanceType<typeof Redis>;
    maxListLength?: number;
    onLog?: (msg: string) => void;
    onError?: (msg: string) => void;
  }) {
    const url = options.redisUrl || Deno.env.get("REDIS_URL") || "redis://localhost:6379";
    this.client = options.client ?? new Redis(url, { maxRetriesPerRequest: 3 });
    this.maxListLength = options.maxListLength ?? 500;
    this.onLog = options.onLog ?? console.log;
    this.onError = options.onError ?? console.error;
  }

  /**
   * シグナルを Redis に保存し、Pub/Sub で発行する。
   * @returns 正常に処理されたら true
   */
  async insert(signal: TradeSignal): Promise<boolean> {
    try {
      const id = `${signal.symbol}-${signal.side}-${signal.signalType}-${Date.now()}`;
      const record: RedisSignalRecord = {
        id,
        symbol: signal.symbol,
        side: signal.side,
        price: signal.price,
        signalType: signal.signalType,
        source: signal.source,
        status: "NEW",
        targetSize: signal.targetSize,
        changePct: signal.changePct ?? null,
        timestamp: signal.timestamp,
        createdAt: new Date().toISOString(),
      };

      const payload = JSON.stringify(record);

      // 1. リストの先頭に追加して上限数に切り詰める
      await this.client
        .pipeline()
        .lpush(REDIS_KEY_SIGNALS_LIST, payload)
        .ltrim(REDIS_KEY_SIGNALS_LIST, 0, this.maxListLength - 1)
        .exec();

      // 2. Pub/Sub でイベントを発行
      await this.client.publish(REDIS_CHANNEL_SIGNALS, payload);

      this.onLog(`[RedisSignalRepository] シグナル登録 & Pub/Sub 発行: ${signal.symbol} ${signal.side} (${signal.signalType})`);
      return true;
    } catch (err) {
      this.onError(`[RedisSignalRepository] シグナル保存/PubSub失敗: ${err}`);
      return false;
    }
  }

  /** 最新のシグナル一覧を取得する */
  async listSignals(limit = 100): Promise<RedisSignalRecord[]> {
    try {
      const items = await this.client.lrange(REDIS_KEY_SIGNALS_LIST, 0, limit - 1);
      return items.map((item) => JSON.parse(item) as RedisSignalRecord);
    } catch (err) {
      this.onError(`[RedisSignalRepository] シグナル一覧取得失敗: ${err}`);
      return [];
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
