import type { Redis } from "ioredis";
import type { OpenPosition } from "../../shared/domain/dca_rules.ts";

export const REDIS_KEY_OPEN_POSITIONS = "hl:positions:open";

/**
 * Redis から OPEN ポジション一覧を取得するリポジトリ。
 * hl:positions:open キー (JSON 配列) から読み出す。
 */
export class RedisPositionRepository {
  constructor(private readonly client: InstanceType<typeof Redis>) {}

  async fetchOpenPositions(): Promise<OpenPosition[]> {
    try {
      const data = await this.client.get(REDIS_KEY_OPEN_POSITIONS);
      if (!data) return [];
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.map((p) => ({
          coin: p.coin || p.symbol,
          side: p.side,
          entryPx: Number(p.entryPx || p.entry_px || 0),
          positionValue: Number(p.positionValue || p.position_value || p.size || 0),
        }));
      }
      return [];
    } catch {
      return [];
    }
  }
}
