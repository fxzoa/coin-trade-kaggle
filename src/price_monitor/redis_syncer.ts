import { Redis } from "ioredis";
import type { HlBasicOrder, HlOrderUpdate, HlPosition, HlUserFill, PriceTick } from "../shared/price_monitor/types.ts";
import { RedisError, toError } from "../shared/price_monitor/errors.ts";

export interface RedisSyncerOptions {
  redisUrl: string;
  prefix: string;
  onLog?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

export class RedisSyncer {
  private client: InstanceType<typeof Redis>;
  private prefix: string;
  private onLog: (msg: string) => void;
  private onError: (err: unknown) => void;
  private consecutiveTransientErrors = 0;

  constructor(options: RedisSyncerOptions) {
    this.prefix = options.prefix;
    this.onLog = options.onLog ?? console.log;
    this.onError = (err: unknown) => {
      const error = toError(err);
      if (options.onError) {
        options.onError(error);
      } else {
        console.error(error);
      }
      this.recordError(error, "RedisSyncer").catch(() => {});
    };

    this.client = new Redis(options.redisUrl, {
      maxRetriesPerRequest: 3,
      keepAlive: 10000,
      enableReadyCheck: true,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 500, 5000);
        return delay;
      },
    });

    this.client.on("connect", () => {
      this.consecutiveTransientErrors = 0;
      this.onLog(`[Redis] 接続しました: ${options.redisUrl}`);
    });

    this.client.on("ready", () => {
      this.consecutiveTransientErrors = 0;
    });

    this.client.on("error", (err: unknown) => {
      const rawErr = toError(err);
      const isTransient = /ECONNRESET|EPIPE|ETIMEDOUT/i.test(rawErr.message);
      if (isTransient) {
        this.consecutiveTransientErrors += 1;
        if (this.consecutiveTransientErrors < 3) {
          this.onLog(
            `[Redis] 一時的な接続断を検知 (自動再接続待ち ${this.consecutiveTransientErrors}/3): ${rawErr.message}`,
          );
          return;
        }
      }
      const error = new RedisError(`[Redis] エラーが発生しました: ${rawErr.message}`, {
        cause: rawErr,
      });
      this.onError(error);
    });
  }

  /**
   * 内部の Redis クライアントインスタンスを取得する
   */
  getClient(): InstanceType<typeof Redis> {
    return this.client;
  }

  /**
   * 最新価格のバッチ保存
   * 1. HSET {prefix}prices {symbol} {price}
   * 2. PUBLISH {prefix}events:prices (最新価格イベント通知)
   */
  async savePrices(ticks: PriceTick[]): Promise<void> {
    if (ticks.length === 0) return;

    try {
      const pipeline = this.client.pipeline();
      const priceHash: Record<string, string> = {};
      const payload: Record<string, number> = {};

      for (const tick of ticks) {
        priceHash[tick.symbol] = tick.price.toString();
        payload[tick.symbol] = tick.price;
      }

      pipeline.hset(`${this.prefix}prices`, priceHash);
      pipeline.set(`${this.prefix}prices:updated_at`, Date.now().toString());
      pipeline.publish(
        `${this.prefix}events:prices`,
        JSON.stringify({ timestamp: Date.now(), prices: payload }),
      );

      await pipeline.exec();
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] 価格データの保存に失敗しました: ${toError(err).message}`,
        {
          cause: toError(err),
        },
      );
      this.onError(error);
    }
  }

  /**
   * ポジション情報の保存 (ClearinghouseState や WebData2 由来)
   * {prefix}positions:{user} ハッシュに coin ごとのポジションJSONを格納
   */
  async savePositions(user: string, positions: HlPosition[]): Promise<void> {
    try {
      const key = `${this.prefix}positions:${user.toLowerCase()}`;
      const pipeline = this.client.pipeline();

      pipeline.del(key);
      if (positions.length > 0) {
        const hashData: Record<string, string> = {};
        for (const pos of positions) {
          hashData[pos.coin] = JSON.stringify(pos);
        }
        pipeline.hset(key, hashData);
      }

      pipeline.set(`${key}:updated_at`, Date.now().toString());
      pipeline.publish(
        `${this.prefix}events:positions`,
        JSON.stringify({ user, timestamp: Date.now(), positions }),
      );

      await pipeline.exec();
      this.onLog(`[Redis] ポジションを同期しました (User: ${user}, 件数: ${positions.length})`);
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] ポジションデータの保存に失敗しました: ${toError(err).message}`,
        { cause: toError(err), context: { user } },
      );
      this.onError(error);
    }
  }

  /**
   * 注文更新 (orderUpdates) の保存
   */
  async saveOrderUpdate(user: string, update: HlOrderUpdate): Promise<void> {
    try {
      const key = `${this.prefix}orders:${user.toLowerCase()}`;
      const oid = update.order.oid.toString();

      if (
        update.status === "filled" ||
        update.status === "canceled" ||
        update.status === "rejected"
      ) {
        await this.client.hdel(key, oid);
      } else {
        await this.client.hset(key, oid, JSON.stringify(update));
      }

      await this.client.publish(
        `${this.prefix}events:orders`,
        JSON.stringify({ user, timestamp: Date.now(), update }),
      );
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] 注文更新の保存に失敗しました: ${toError(err).message}`,
        {
          cause: toError(err),
          context: { user, oid: update.order.oid },
        },
      );
      this.onError(error);
    }
  }

  /**
   * 約定 (userFills) イベントの配信 (Redis Pub/Sub)
   * 永続化は Deno KV (FillsStore) が行い、Redis はリアルタイム通知を担当
   */
  async publishUserFills(user: string, fills: HlUserFill[]): Promise<void> {
    try {
      await this.client.publish(
        `${this.prefix}events:fills`,
        JSON.stringify({ user, timestamp: Date.now(), fills }),
      );
      this.onLog(`[Redis] 約定イベントを配信しました (User: ${user}, 件数: ${fills.length})`);
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] 約定イベントの送信に失敗しました: ${toError(err).message}`,
        {
          cause: toError(err),
          context: { user },
        },
      );
      this.onError(error);
    }
  }

  /**
   * 約定 (userFills) の保存およびイベント配信 (後方互換性メソッド)
   */
  async saveUserFills(user: string, fills: HlUserFill[]): Promise<void> {
    await this.publishUserFills(user, fills);
  }

  /**
   * ユーザーの最新約定履歴を取得
   */
  async getRecentFills(user: string, limit = 50): Promise<HlUserFill[]> {
    try {
      const normalizedUser = user.toLowerCase();
      const hashKey = `${this.prefix}fills:${normalizedUser}`;
      const timelineKey = `${this.prefix}fills:${normalizedUser}:timeline`;
      const stop = Math.max(0, limit - 1);
      const uids = await this.client.zrevrange(timelineKey, 0, stop);
      if (!uids || uids.length === 0) return [];

      const items = await this.client.hmget(hashKey, ...uids);
      const fills: HlUserFill[] = [];
      for (const item of items) {
        if (item) {
          try {
            fills.push(JSON.parse(item) as HlUserFill);
          } catch {
            // ignore corrupted item
          }
        }
      }
      return fills;
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] 約定履歴の取得に失敗しました: ${toError(err).message}`,
        {
          cause: toError(err),
          context: { user },
        },
      );
      this.onError(error);
      return [];
    }
  }

  /**
   * オープン注文一覧の同期
   */
  async syncOpenOrders(user: string, orders: HlBasicOrder[]): Promise<void> {
    try {
      const key = `${this.prefix}orders:${user.toLowerCase()}`;
      const pipeline = this.client.pipeline();

      pipeline.del(key);
      if (orders.length > 0) {
        const hashData: Record<string, string> = {};
        for (const order of orders) {
          hashData[order.oid.toString()] = JSON.stringify(order);
        }
        pipeline.hset(key, hashData);
      }
      pipeline.set(`${key}:updated_at`, Date.now().toString());

      await pipeline.exec();
      this.onLog(`[Redis] オープン注文を同期しました (User: ${user}, 件数: ${orders.length})`);
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] オープン注文の同期に失敗しました: ${toError(err).message}`,
        {
          cause: toError(err),
          context: { user },
        },
      );
      this.onError(error);
    }
  }

  /**
   * エラーログを Redis リストに記録する ({prefix}errors)
   */
  async recordError(err: unknown, context?: string): Promise<void> {
    try {
      const error = toError(err);
      const message = error.message;
      const stack = error.stack;
      const errorEntry = {
        timestamp: new Date().toISOString(),
        service: "price-syncer-bot",
        level: "ERROR",
        context: context || "General",
        message,
        stack,
      };
      const key = `${this.prefix}errors`;
      const pipeline = this.client.pipeline();
      pipeline.lpush(key, JSON.stringify(errorEntry));
      pipeline.ltrim(key, 0, 99); // 直近100件を保持
      pipeline.publish(`${this.prefix}events:errors`, JSON.stringify(errorEntry));
      await pipeline.exec();
    } catch (e: unknown) {
      const error = toError(e);
      console.error("[Redis] Failed to record error:", error);
    }
  }

  /**
   * 直近のエラーログを取得する ({prefix}errors)
   */
  async getRecentErrors(
    limit = 50,
  ): Promise<
    Array<
      {
        timestamp: string;
        service: string;
        level: string;
        context: string;
        message: string;
        stack?: string;
      }
    >
  > {
    try {
      const key = `${this.prefix}errors`;
      const rawList = await this.client.lrange(key, 0, limit - 1);
      return rawList.map((item) => {
        try {
          return JSON.parse(item);
        } catch {
          return {
            timestamp: new Date().toISOString(),
            service: "price-syncer-bot",
            level: "ERROR",
            context: "Unknown",
            message: item,
          };
        }
      });
    } catch (err: unknown) {
      const error = new RedisError(`[Redis] Failed to get recent errors: ${toError(err).message}`, {
        cause: toError(err),
      });
      this.onError(error);
      return [];
    }
  }

  /**
   * エラーログを全削除（クリア）する
   */
  async clearErrors(): Promise<void> {
    try {
      await this.client.del(`${this.prefix}errors`);
    } catch (err: unknown) {
      const error = new RedisError(`[Redis] Failed to clear errors: ${toError(err).message}`, {
        cause: toError(err),
      });
      this.onError(error);
    }
  }

  /**
   * 許可されていない銘柄の古い価格データを Redis から削除する
   * @param allowedSymbols 保持を許可するシンボルのSet
   * @returns 削除されたシンボルの数
   */
  async cleanStalePrices(allowedSymbols: Set<string>): Promise<number> {
    try {
      const key = `${this.prefix}prices`;
      const allSymbols: string[] = await this.client.hkeys(key);
      const staleSymbols = allSymbols.filter((sym) => !allowedSymbols.has(sym));

      if (staleSymbols.length > 0) {
        await this.client.hdel(key, ...staleSymbols);
        this.onLog(
          `[Redis] 不正または古い銘柄の価格データを削除しました (削除件数: ${staleSymbols.length}, 保持: ${
            allSymbols.length - staleSymbols.length
          })`,
        );
      }
      return staleSymbols.length;
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] 古い価格データのクリーンアップに失敗しました: ${toError(err).message}`,
        {
          cause: toError(err),
        },
      );
      this.onError(error);
      return 0;
    }
  }

  /**
   * クライアントを正常終了する
   */
  async close(): Promise<void> {
    try {
      await this.client.quit();
      this.onLog("[Redis] 切断しました");
    } catch (err: unknown) {
      const error = new RedisError(
        `[Redis] 切断時にエラーが発生しました: ${toError(err).message}`,
        {
          cause: toError(err),
        },
      );
      this.onError(error);
    }
  }
}
