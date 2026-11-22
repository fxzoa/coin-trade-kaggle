import type { SignalSide } from "../domain/trade_signal.ts";

/**
 * buyer-worker / seller-worker が参照する KV キーと既定値。
 * 出典は cf-workers/common-worker-utils/src/shared_kv_keys.ts と各 worker の constants.ts
 * (Worker 間の連携契約のため、値は完全一致させること)
 */

/** 売買方向ごとのトレード有効化フラグ (主キーが未設定のときだけ旧キーを見る) */
export const TRADE_ENABLED_KEYS: Readonly<
  Record<SignalSide, { label: string; key: string; fallbackKey: string }>
> = {
  LONG: { label: "buyer", key: "buyer:trade:enabled", fallbackKey: "buyer_trade_enabled" },
  SHORT: { label: "seller", key: "seller:trade:enabled", fallbackKey: "seller_trade_enabled" },
};

/** システム全体の緊急停止フラグ */
export const SYSTEM_MAINTENANCE_KEY = "system:maintenance";

/** 価格騰落シグナルシステム専用の緊急停止フラグ */
export const SYSTEM_MAINTENANCE_PRICE_CHANGE_KEY = "system:maintenance:price_change";

/** 証拠金・残高不足による自動取引停止フラグ */
export const INSUFFICIENT_COOLDOWN_KEY = "system:insufficient_cooldown";

/** 取引対象から除外する銘柄リストの KV キー (未設定時は DEFAULT_EXCLUDED_COINS) */
export const EXCLUDED_COINS_KEY = "signal:excluded_coins";

/** EXCLUDED_COINS_KEY が未設定のときの既定の除外銘柄 */
export const DEFAULT_EXCLUDED_COINS: readonly string[] = [
  "ENA",
  "NEAR",
  "AAVE",
  "HYPE",
  "BTC",
  "TRX",
  "LINK",
  "HEMI",
];

/** btc-grid-worker が専任で扱う銘柄 (本アプリでは扱わない) */
export const BTC_GRID_COINS: readonly string[] = ["BTC"];

/** dca-worker の対象銘柄リスト (カンマ区切り) の KV キー。dca-worker / dashboard-worker と共有 */
export const DCA_TARGET_COINS_KEY = "trade:dca_target_coins";

/**
 * DCA_TARGET_COINS_KEY が未設定・空のときの既定の DCA 対象銘柄。
 * dca-worker (common-worker-utils の DEFAULT_DCA_TARGET_COINS) と同じ値
 */
export const DEFAULT_DCA_TARGET_COINS: readonly string[] = [
  "ENA",
  "NEAR",
  "AAVE",
  "HYPE",
  "TRX",
  "LINK",
];

/** 24H 最小取引高 (USD) の KV キー */
export const MIN_24H_VOLUME_USD_KEY = "trade:min_24h_volume_usd";

/** 24H 最小取引高の既定値 (USD) */
export const DEFAULT_MIN_24H_VOLUME_USD = 10_000_000;

/** 決済後・保有中の再エントリー待機期間 (ms)。signal_type に依らず固定 24 時間 */
export const REENTRY_AFTER_CLOSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 価格統計キャッシュの KV キー接頭辞 (Worker 間の契約定数) */
export const PRICE_STATS_KEY_PREFIX = "price_stats:";

/** 全銘柄まとめ価格統計の KV キー (Worker 間の契約定数) */
export const PRICE_STATS_KEY_ALL = `${PRICE_STATS_KEY_PREFIX}all`;
