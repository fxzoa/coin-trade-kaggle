import type { Redis } from "ioredis";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import type { ExistingRecords } from "../../shared/domain/signal_eligibility.ts";
import type { DcaExistingCounts } from "../../shared/domain/dca_rules.ts";
import { REDIS_KEY_SIGNALS_LIST } from "../../shared/domain/trade_mode.ts";
import type { RedisSignalRecord } from "./redis_signal_repository.ts";
import { REDIS_KEY_OPEN_POSITIONS } from "./redis_position_repository.ts";

/**
 * D1 の代わりに Redis を参照してシグナルの適格性判定を行うリポジトリ。
 */
export class RedisEligibilityRepository {
  constructor(private readonly client: InstanceType<typeof Redis>) {}

  /**
   * 同一銘柄・同一方向の未約定シグナル、OPEN ポジションなどを Redis から集約する
   */
  async fetchRecords(signal: TradeSignal): Promise<ExistingRecords> {
    const symbol = signal.symbol;
    const side = signal.side;
    try {
      // 1. 直近シグナル一覧から未処理 (NEW) 件数をカウント
      const items = await this.client.lrange(REDIS_KEY_SIGNALS_LIST, 0, 99);
      let signalNewCount = 0;
      for (const raw of items) {
        try {
          const s = JSON.parse(raw) as RedisSignalRecord;
          if (s.symbol === symbol && s.side === side && s.status === "NEW") {
            signalNewCount++;
          }
        } catch {
          // ignore parse error
        }
      }

      // 2. OPEN ポジション確認
      let openPos = null;
      const posRaw = await this.client.get(REDIS_KEY_OPEN_POSITIONS);
      if (posRaw) {
        try {
          const positions = JSON.parse(posRaw);
          if (Array.isArray(positions)) {
            const found = positions.find(
              (p: any) => (p.coin === symbol || p.symbol === symbol) && p.side === side
            );
            if (found) {
              openPos = {
                opened_at: found.opened_at || found.timestamp || null,
              };
            }
          }
        } catch {
          // ignore
        }
      }

      return {
        signalNewCount,
        orderNewCount: 0,
        openPos,
        closedPos: null,
        openOrder: null,
      };
    } catch {
      return {
        signalNewCount: 0,
        orderNewCount: 0,
        openPos: null,
        closedPos: null,
        openOrder: null,
      };
    }
  }

  /**
   * DCA 用の未処理件数取得
   */
  async fetchDcaCounts(signal: TradeSignal): Promise<DcaExistingCounts> {
    const symbol = signal.symbol;
    const side = signal.side;
    const signalType = signal.signalType;
    try {
      const items = await this.client.lrange(REDIS_KEY_SIGNALS_LIST, 0, 99);
      let signalNewCount = 0;
      for (const raw of items) {
        try {
          const s = JSON.parse(raw) as RedisSignalRecord;
          if (s.symbol === symbol && s.side === side && s.signalType === signalType && s.status === "NEW") {
            signalNewCount++;
          }
        } catch {
          // ignore
        }
      }
      return { signalNewCount, orderNewCount: 0 };
    } catch {
      return { signalNewCount: 0, orderNewCount: 0 };
    }
  }
}
