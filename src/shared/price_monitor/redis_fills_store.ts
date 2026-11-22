import { Redis } from "ioredis";
import type { HlUserFill } from "./types.ts";
import { RedisError, toError } from "./errors.ts";

export interface RedisFillsStoreOptions {
  redisClient?: InstanceType<typeof Redis>;
  redisUrl?: string;
  prefix?: string;
}

export class RedisFillsStore {
  private redis!: InstanceType<typeof Redis>;
  private readonly prefix: string;
  private readonly redisUrl?: string;
  private readonly ownedClient: boolean;
  private initialized = false;

  constructor(options?: RedisFillsStoreOptions) {
    this.prefix = options?.prefix ?? Deno.env.get("REDIS_KEY_PREFIX") ?? "hl:";
    if (options?.redisClient) {
      this.redis = options.redisClient;
      this.ownedClient = false;
      this.initialized = true;
    } else {
      this.redisUrl = options?.redisUrl ?? Deno.env.get("REDIS_URL") ?? "redis://127.0.0.1:6379";
      this.ownedClient = true;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      this.redis = new Redis(this.redisUrl!, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 500, 3000),
      });
      await this.redis.ping();
      this.initialized = true;
    } catch (e: unknown) {
      throw new RedisError(`Failed to initialize Redis fills store at '${this.redisUrl}'`, {
        cause: toError(e),
        context: { redisUrl: this.redisUrl },
      });
    }
  }

  async close(): Promise<void> {
    if (this.initialized && this.ownedClient && this.redis) {
      try {
        await this.redis.quit();
      } catch (e: unknown) {
        throw new RedisError("Failed to close Redis fills store connection", {
          cause: toError(e),
        });
      } finally {
        this.initialized = false;
      }
    }
  }

  getClient(): InstanceType<typeof Redis> {
    return this.redis;
  }

  /**
   * 約定 (userFills) を Redis へ保存
   * キー設計:
   *   Hash:     ${prefix}fills:${user} (uid -> JSON string)
   *   Timeline: ${prefix}fills:${user}:timeline (score = fill.time, member = uid)
   *   更新日時: ${prefix}fills:${user}:updated_at (timestamp)
   */
  async saveUserFills(user: string, fills: HlUserFill[]): Promise<number> {
    if (!this.initialized) await this.init();
    if (!fills || fills.length === 0) return 0;

    const normalizedUser = user.toLowerCase();
    const now = Date.now();
    const hashKey = `${this.prefix}fills:${normalizedUser}`;
    const timelineKey = `${this.prefix}fills:${normalizedUser}:timeline`;
    const updatedAtKey = `${this.prefix}fills:${normalizedUser}:updated_at`;

    let savedCount = 0;

    try {
      for (let i = 0; i < fills.length; i += 100) {
        const chunk = fills.slice(i, i + 100);
        const pipeline = this.redis.pipeline();
        const hashData: Record<string, string> = {};
        const zaddArgs: (string | number)[] = [];

        for (const fill of chunk) {
          const time = fill.time || now;
          const uid = String(
            fill.tid ?? fill.oid ?? fill.hash ??
              `${now}_${Math.random().toString(36).substring(2, 7)}`,
          );
          hashData[uid] = JSON.stringify(fill);
          zaddArgs.push(time, uid);
          savedCount++;
        }

        pipeline.hset(hashKey, hashData);
        pipeline.zadd(timelineKey, ...zaddArgs);
        pipeline.set(updatedAtKey, now.toString());

        const results = await pipeline.exec();
        if (results) {
          for (const [err] of results) {
            if (err) {
              throw err;
            }
          }
        }
      }

      return savedCount;
    } catch (e: unknown) {
      if (e instanceof RedisError) throw e;
      throw new RedisError(`Error saving user fills to Redis for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser, fillsCount: fills.length },
      });
    }
  }

  /**
   * 約定履歴を取得 (timeline ZSet から zrevrange で新しい順に uid を取得し、Hash から hmget で取得)
   */
  async getUserFills(
    user: string,
    limit = 100,
  ): Promise<{ fills: HlUserFill[]; updatedAt: number | null }> {
    if (!this.initialized) await this.init();
    const normalizedUser = user.toLowerCase();
    const hashKey = `${this.prefix}fills:${normalizedUser}`;
    const timelineKey = `${this.prefix}fills:${normalizedUser}:timeline`;
    const updatedAtKey = `${this.prefix}fills:${normalizedUser}:updated_at`;

    try {
      const fetchLimit = Math.max(1, limit);
      const [uids, updatedAtStr] = await Promise.all([
        this.redis.zrevrange(timelineKey, 0, fetchLimit - 1),
        this.redis.get(updatedAtKey),
      ]);

      if (!uids || uids.length === 0) {
        return {
          fills: [],
          updatedAt: updatedAtStr ? parseInt(updatedAtStr, 10) : null,
        };
      }

      const rawFills = await this.redis.hmget(hashKey, ...uids);
      const fills: HlUserFill[] = [];
      for (const raw of rawFills) {
        if (raw) {
          try {
            fills.push(JSON.parse(raw));
          } catch {
            // ignore corrupted record
          }
        }
      }

      const updatedAt = updatedAtStr
        ? parseInt(updatedAtStr, 10)
        : (fills.length > 0 ? (fills[0].time || null) : null);

      return { fills, updatedAt };
    } catch (e: unknown) {
      if (e instanceof RedisError) throw e;
      throw new RedisError(`Error retrieving user fills from Redis for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser, limit },
      });
    }
  }

  /**
   * ユーザーの約定履歴を全削除
   */
  async clearUserFills(user: string): Promise<void> {
    if (!this.initialized) await this.init();
    const normalizedUser = user.toLowerCase();
    const hashKey = `${this.prefix}fills:${normalizedUser}`;
    const timelineKey = `${this.prefix}fills:${normalizedUser}:timeline`;
    const updatedAtKey = `${this.prefix}fills:${normalizedUser}:updated_at`;

    try {
      await this.redis.del(hashKey, timelineKey, updatedAtKey);
    } catch (e: unknown) {
      if (e instanceof RedisError) throw e;
      throw new RedisError(`Error clearing user fills from Redis for user: ${normalizedUser}`, {
        cause: toError(e),
        context: { user: normalizedUser },
      });
    }
  }
}
