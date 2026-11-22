import { Redis } from "ioredis";
import type { HlOrderUpdate, HlUserFill } from "./types.ts";
import { KvError, toError } from "./errors.ts";
import { RedisFillsStore, type RedisFillsStoreOptions } from "./redis_fills_store.ts";

export { RedisFillsStore, type RedisFillsStoreOptions };

export interface FillsStoreOptions {
  redisClient?: InstanceType<typeof Redis>;
  redisUrl?: string;
  prefix?: string;
  kvPath?: string;
  enableKvFallback?: boolean;
  useKvOnly?: boolean;
}

export class FillsStore {
  private redisStore?: RedisFillsStore;
  private kv?: Deno.Kv;
  private readonly dbPath?: string;
  private readonly useKvOnly: boolean;
  private readonly enableKvFallback: boolean;
  private redisActive = false;
  private kvInitialized = false;
  private initialized = false;

  constructor(options?: FillsStoreOptions) {
    this.useKvOnly = options?.useKvOnly ?? false;
    this.enableKvFallback = options?.enableKvFallback ?? false;

    if (!this.useKvOnly) {
      this.redisStore = new RedisFillsStore({
        redisClient: options?.redisClient,
        redisUrl: options?.redisUrl,
        prefix: options?.prefix,
      });
    }

    let envPath = Deno.env.get("KV_PATH");
    if (envPath && envPath.startsWith("/app/")) {
      try {
        Deno.statSync("/app");
      } catch {
        envPath = `.${envPath.slice(4)}`;
      }
    }
    this.dbPath = options?.kvPath ??
      (this.useKvOnly || this.enableKvFallback ? (envPath ?? "./data/kv.sqlite") : undefined);
  }

  get isRedis(): boolean {
    return this.redisActive;
  }

  get redisClient(): InstanceType<typeof Redis> | undefined {
    return this.redisStore?.getClient();
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (!this.useKvOnly && this.redisStore) {
      try {
        await this.redisStore.init();
        this.redisActive = true;
      } catch (e: unknown) {
        if (!this.enableKvFallback && !this.dbPath) {
          throw e;
        }
        console.warn(
          "[FillsStore] Redis init failed, falling back to Deno KV:",
          toError(e).message,
        );
        this.redisActive = false;
      }
    }

    if (
      this.useKvOnly || (this.enableKvFallback && this.dbPath) ||
      (!this.redisActive && this.dbPath) || this.dbPath
    ) {
      await this.initKv();
    }

    this.initialized = true;
  }

  private async initKv(): Promise<void> {
    if (this.kvInitialized) return;
    const path = this.dbPath ?? "./data/kv.sqlite";

    if (path !== ":memory:" && path.includes("/")) {
      const lastSlash = path.lastIndexOf("/");
      const dir = path.slice(0, lastSlash);
      try {
        await Deno.mkdir(dir, { recursive: true });
      } catch {
        // ignore if directory exists
      }
    }

    try {
      this.kv = await Deno.openKv(path);
      this.kvInitialized = true;
    } catch (e: unknown) {
      throw new KvError(`Failed to open Deno KV database at '${path}'`, {
        cause: toError(e),
        context: { dbPath: path },
      });
    }
  }

  async close(): Promise<void> {
    if (this.redisStore && this.redisActive) {
      try {
        await this.redisStore.close();
      } finally {
        this.redisActive = false;
      }
    }

    if (this.kvInitialized && this.kv) {
      try {
        await this.kv.close();
      } catch (e: unknown) {
        throw new KvError("Failed to close Deno KV database", {
          cause: toError(e),
        });
      } finally {
        this.kvInitialized = false;
      }
    }

    this.initialized = false;
  }

  /**
   * 約定 (userFills) を保存 (Redis を主ストレージとし、KVフォールバックが有効ならKVにも書き込み)
   */
  async saveUserFills(user: string, fills: HlUserFill[]): Promise<number> {
    if (!this.initialized) await this.init();
    if (!fills || fills.length === 0) return 0;

    let savedCount = 0;

    if (this.redisActive && this.redisStore) {
      savedCount = await this.redisStore.saveUserFills(user, fills);
    }

    if (this.kvInitialized && this.kv) {
      const kvSaved = await this.saveUserFillsToKv(user, fills);
      if (!this.redisActive) {
        savedCount = kvSaved;
      }
    }

    return savedCount;
  }

  /**
   * 注文更新 (orderUpdates) を Deno KV へ永続化保存
   */
  async saveOrderUpdate(user: string, update: HlOrderUpdate): Promise<void> {
    if (!this.initialized) await this.init();
    if (this.kvInitialized && this.kv) {
      await this.saveOrderUpdateToKv(user, update);
    }
  }

  /**
   * 注文更新履歴を取得 (Deno KV より)
   */
  async getOrderUpdates(
    user: string,
    limit = 100,
  ): Promise<{ orders: HlOrderUpdate[]; updatedAt: number | null }> {
    if (!this.initialized) await this.init();
    if (this.kvInitialized && this.kv) {
      return await this.getOrderUpdatesFromKv(user, limit);
    }
    return { orders: [], updatedAt: null };
  }

  /**
   * 約定履歴を取得 (Redis が有効なら Redis から、エラー時や無効時は KV から取得)
   */
  async getUserFills(
    user: string,
    limit = 100,
  ): Promise<{ fills: HlUserFill[]; updatedAt: number | null }> {
    if (!this.initialized) await this.init();

    if (this.redisActive && this.redisStore) {
      try {
        return await this.redisStore.getUserFills(user, limit);
      } catch (err: unknown) {
        if (this.kvInitialized && this.kv) {
          console.warn(
            "[FillsStore] Redis getUserFills failed, falling back to KV:",
            toError(err).message,
          );
          return await this.getUserFillsFromKv(user, limit);
        }
        throw err;
      }
    }

    if (this.kvInitialized && this.kv) {
      return await this.getUserFillsFromKv(user, limit);
    }

    return { fills: [], updatedAt: null };
  }

  /**
   * 約定履歴および注文履歴を全削除
   */
  async clearUserFills(user: string): Promise<void> {
    if (!this.initialized) await this.init();

    if (this.redisActive && this.redisStore) {
      await this.redisStore.clearUserFills(user);
    }

    if (this.kvInitialized && this.kv) {
      await this.clearUserFillsFromKv(user);
    }
  }

  async clearOrderUpdates(user: string): Promise<void> {
    if (!this.initialized) await this.init();
    if (this.kvInitialized && this.kv) {
      await this.clearOrderUpdatesFromKv(user);
    }
  }

  // --- Deno KV Order Methods ---

  private async saveOrderUpdateToKv(user: string, update: HlOrderUpdate): Promise<void> {
    if (!this.kv) return;
    const normalizedUser = user.toLowerCase();
    const timestamp = update.statusTimestamp || update.order.timestamp || Date.now();
    const oid = String(update.order.oid);
    const key = ["orders", normalizedUser, timestamp, oid];

    try {
      const atomic = this.kv.atomic();
      atomic.set(key, update);
      atomic.set(["orders_updated_at", normalizedUser], timestamp);
      const res = await atomic.commit();
      if (!res.ok) {
        throw new KvError(`Failed to commit order update to KV for user: ${normalizedUser}`);
      }
    } catch (e: unknown) {
      if (e instanceof KvError) throw e;
      throw new KvError(`Error saving order update to KV for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser, oid },
      });
    }
  }

  private async getOrderUpdatesFromKv(
    user: string,
    limit = 100,
  ): Promise<{ orders: HlOrderUpdate[]; updatedAt: number | null }> {
    if (!this.kv) return { orders: [], updatedAt: null };
    const normalizedUser = user.toLowerCase();

    try {
      const prefix = ["orders", normalizedUser];
      const iter = this.kv.list<HlOrderUpdate>(
        { prefix },
        { reverse: true, limit: Math.max(1, limit) },
      );

      const orders: HlOrderUpdate[] = [];
      for await (const entry of iter) {
        if (entry.value) {
          orders.push(entry.value);
        }
      }

      const updatedRes = await this.kv.get<number>(["orders_updated_at", normalizedUser]);
      const updatedAt = updatedRes.value ??
        (orders.length > 0 ? (orders[0].statusTimestamp || null) : null);

      return { orders, updatedAt };
    } catch (e: unknown) {
      if (e instanceof KvError) throw e;
      throw new KvError(`Error retrieving order updates from KV for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser },
      });
    }
  }

  private async clearOrderUpdatesFromKv(user: string): Promise<void> {
    if (!this.kv) return;
    const normalizedUser = user.toLowerCase();

    try {
      const prefix = ["orders", normalizedUser];
      const iter = this.kv.list<HlOrderUpdate>({ prefix });
      for await (const entry of iter) {
        await this.kv.delete(entry.key);
      }
      await this.kv.delete(["orders_updated_at", normalizedUser]);
    } catch (e: unknown) {
      if (e instanceof KvError) throw e;
      throw new KvError(`Error clearing order updates from KV for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser },
      });
    }
  }

  // --- Deno KV Fallback Methods ---

  private async saveUserFillsToKv(user: string, fills: HlUserFill[]): Promise<number> {
    if (!this.kv) return 0;
    const normalizedUser = user.toLowerCase();
    const now = Date.now();
    let savedCount = 0;

    try {
      for (let i = 0; i < fills.length; i += 100) {
        const chunk = fills.slice(i, i + 100);
        const atomic = this.kv.atomic();

        for (const fill of chunk) {
          const uid = String(
            fill.tid ?? fill.oid ?? fill.hash ??
              `${now}_${Math.random().toString(36).substring(2, 7)}`,
          );
          const time = fill.time || now;
          const key = ["fills", normalizedUser, time, uid];
          atomic.set(key, fill);
          savedCount++;
        }

        atomic.set(["fills_updated_at", normalizedUser], now);
        const res = await atomic.commit();
        if (!res.ok) {
          throw new KvError(`Failed to commit fills batch to KV for user: ${normalizedUser}`, {
            context: { user: normalizedUser, batchSize: chunk.length },
          });
        }
      }

      return savedCount;
    } catch (e: unknown) {
      if (e instanceof KvError) throw e;
      throw new KvError(`Error saving user fills to KV for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser },
      });
    }
  }

  private async getUserFillsFromKv(
    user: string,
    limit = 100,
  ): Promise<{ fills: HlUserFill[]; updatedAt: number | null }> {
    if (!this.kv) return { fills: [], updatedAt: null };
    const normalizedUser = user.toLowerCase();

    try {
      const prefix = ["fills", normalizedUser];
      const iter = this.kv.list<HlUserFill>(
        { prefix },
        { reverse: true, limit: Math.max(1, limit) },
      );

      const fills: HlUserFill[] = [];
      for await (const entry of iter) {
        if (entry.value) {
          fills.push(entry.value);
        }
      }

      const updatedRes = await this.kv.get<number>(["fills_updated_at", normalizedUser]);
      const updatedAt = updatedRes.value ?? (fills.length > 0 ? (fills[0].time || null) : null);

      return { fills, updatedAt };
    } catch (e: unknown) {
      if (e instanceof KvError) throw e;
      throw new KvError(`Error retrieving user fills from KV for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser },
      });
    }
  }

  private async clearUserFillsFromKv(user: string): Promise<void> {
    if (!this.kv) return;
    const normalizedUser = user.toLowerCase();

    try {
      const prefix = ["fills", normalizedUser];
      const iter = this.kv.list<HlUserFill>({ prefix });
      for await (const entry of iter) {
        await this.kv.delete(entry.key);
      }
      await this.kv.delete(["fills_updated_at", normalizedUser]);
    } catch (e: unknown) {
      if (e instanceof KvError) throw e;
      throw new KvError(`Error clearing user fills from KV for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser },
      });
    }
  }
}
