import type { Redis } from "ioredis";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import {
  isSideAllowed,
  REDIS_KEY_TRADE_MODE,
  type TradeMode,
} from "../../shared/domain/trade_mode.ts";
import { type CheckResult, PASS, skip } from "./signal_check.ts";

export class TradeModeCheck {
  readonly name = "TradeMode (BUY/SELL 制御フラグ)";
  private client: InstanceType<typeof Redis>;
  private cachedMode: TradeMode = "BOTH";
  private lastFetched = 0;
  private readonly ttlMs = 3000; // 3秒キャッシュ

  constructor(client: InstanceType<typeof Redis>) {
    this.client = client;
  }

  async getMode(): Promise<TradeMode> {
    const now = Date.now();
    if (now - this.lastFetched < this.ttlMs) {
      return this.cachedMode;
    }
    try {
      const mode = await this.client.get(REDIS_KEY_TRADE_MODE);
      if (mode === "BUY_ONLY" || mode === "SELL_ONLY" || mode === "DISABLED" || mode === "BOTH") {
        this.cachedMode = mode;
      } else {
        this.cachedMode = "BOTH";
      }
      this.lastFetched = now;
    } catch {
      // 取得失敗時は現在のキャッシュ値を継続
    }
    return this.cachedMode;
  }

  async check(signal: TradeSignal): Promise<CheckResult> {
    const mode = await this.getMode();
    if (!isSideAllowed(signal.side, mode)) {
      return skip(`現在のトレードモード (${mode}) により ${signal.side} は許可されていません`);
    }
    return PASS;
  }
}
