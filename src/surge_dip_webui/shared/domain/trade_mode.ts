/**
 * トレード制御フラグ (BUY / SELL の許可モード)
 */
export type TradeMode = "BOTH" | "BUY_ONLY" | "SELL_ONLY" | "DISABLED";

export const REDIS_KEY_TRADE_MODE = "hl:flags:trade_mode";
export const REDIS_CHANNEL_SIGNALS = "hl:events:signals";
export const REDIS_KEY_SIGNALS_LIST = "hl:signals:list";

/** トレードモードから BUY / SELL が許可されているかを判定する */
export function isSideAllowed(side: "LONG" | "SHORT", mode: TradeMode): boolean {
  if (mode === "DISABLED") return false;
  if (mode === "BOTH") return true;
  if (mode === "BUY_ONLY") return side === "LONG";
  if (mode === "SELL_ONLY") return side === "SHORT";
  return false;
}
