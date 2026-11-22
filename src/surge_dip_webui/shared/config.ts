import { AppError } from "./errors.ts";
import type { RangeLabel } from "./domain/price_range.ts";
import {
  DEFAULT_SIGNAL_THRESHOLDS,
  type PeriodThresholds,
  type SignalThresholds,
} from "./domain/trade_signal.ts";
import { DEFAULT_MIN_24H_VOLUME_USD } from "./constants/kv_keys.ts";
import type { D1Credentials } from "../worker/infrastructure/d1_signal_repository.ts";
import type { OpenQueueCredentials } from "../worker/infrastructure/open_queue_publisher.ts";
import { DEFAULT_COOLDOWN_SECONDS } from "../worker/usecase/signal_cooldown.ts";
import { DEFAULT_DCA_POSITIONS_REFRESH_SECONDS } from "../worker/usecase/dca_position_cache.ts";
import { DEFAULT_RECHECK_MS } from "../worker/usecase/signal_registrar.ts";

/** アプリケーション設定 */
export interface AppConfig {
  network: "mainnet" | "testnet";
  wsUrl: string;
  /** 銘柄名解決に使う Info API の URL */
  infoUrl: string;
  /** 監視対象銘柄 (空配列 = 全銘柄) */
  symbols: string[];
  /** 予測市場 (`#...` 銘柄) を監視対象に含めるか */
  includeOutcomes: boolean;
  /** 最高値/最低値の更新一覧を出力するか (BREAKOUT_LIST_ENABLED。既定 true。判定・シグナルには影響しない) */
  listLogEnabled: boolean;
  /** Redis URL (未指定時は環境変数 REDIS_URL または redis://localhost:6379) */
  redisUrl: string;
  /** シグナル判定・登録の設定 */
  signal: SignalConfig;
}

/** シグナル判定・登録の設定 */
export interface SignalConfig {
  /** 判定の閾値 */
  thresholds: SignalThresholds;
  /** SIGNAL_WRITE_ENABLED=true で true (false ならドライラン) */
  writeEnabled: boolean;
  /** D1 の接続情報 (未使用・後方互換用) */
  d1?: D1Credentials | null;
  /** OPEN_QUEUE_ENABLED=true で true (true でも writeEnabled が false なら通知しない) */
  openQueueEnabled: boolean;
  /** open-queue の接続情報 (未使用・後方互換用) */
  openQueue?: OpenQueueCredentials | null;
  /** 銘柄 × 売買方向のクールダウン (秒)。worker の COOLDOWN_SECONDS と同じ */
  cooldownSeconds: number;
  /** 同一 (銘柄・方向・種別) を再判定しない間隔 (秒)。API 呼び出しの抑制用 */
  recheckSeconds: number;
  /** 最小取引高の閾値 (USD) */
  minVolumeUsd: number;
  /** DCA_ENABLED=true で true */
  dcaEnabled: boolean;
  /** DCA ポジションを読み直す間隔 (秒) */
  dcaPositionsRefreshSeconds: number;
  /** 価格統計の同期が有効か (PRICE_STATS_WRITE_ENABLED=true または KV_PRICE_STATS_WRITE_ENABLED=true) */
  priceStatsWriteEnabled: boolean;
  /** @deprecated 後方互換性用エイリアス */
  kvPriceStatsWriteEnabled?: boolean;
}

type Env = { get(k: string): string | undefined };

const RANGE_LABELS: readonly RangeLabel[] = ["24H", "7D", "30D", "90D", "180D", "360D"];

/** 正の有限数なら採用し、未設定・不正値なら既定値を返す */
function parsePositive(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `<PREFIX>_24H` 〜 `<PREFIX>_360D` から期間別の閾値を読み込む */
function loadPeriodThresholds(
  env: Env,
  prefix: string,
  defaults: PeriodThresholds,
): PeriodThresholds {
  const result = { ...defaults };
  for (const label of RANGE_LABELS) {
    result[label] = parsePositive(env.get(`${prefix}_${label}`), defaults[label]);
  }
  return result;
}

/** シグナル判定の閾値を環境変数から読み込む (不正値は既定値) */
function loadSignalThresholds(env: Env): SignalThresholds {
  const d = DEFAULT_SIGNAL_THRESHOLDS;
  return {
    dip: loadPeriodThresholds(env, "DIP_THRESHOLD", d.dip),
    surge: loadPeriodThresholds(env, "SURGE_THRESHOLD", d.surge),
    additionalDip24h: parsePositive(env.get("ADDITIONAL_DIP_THRESHOLD_24H"), d.additionalDip24h),
    additionalSurge24h: parsePositive(
      env.get("ADDITIONAL_SURGE_THRESHOLD_24H"),
      d.additionalSurge24h,
    ),
  };
}

/** シグナル判定・登録の設定を環境変数から読み込む */
function loadSignalConfig(env: Env): SignalConfig {
  const priceStatsWriteRaw = (env.get("PRICE_STATS_WRITE_ENABLED") ?? env.get("KV_PRICE_STATS_WRITE_ENABLED") ?? "").trim().toLowerCase();
  const priceStatsWriteEnabled = !["false", "0", "off", "no"].includes(priceStatsWriteRaw);

  return {
    thresholds: loadSignalThresholds(env),
    writeEnabled: env.get("SIGNAL_WRITE_ENABLED")?.trim() === "true",
    d1: null,
    openQueueEnabled: env.get("OPEN_QUEUE_ENABLED")?.trim() === "true",
    openQueue: null,
    cooldownSeconds: parsePositive(env.get("COOLDOWN_SECONDS"), DEFAULT_COOLDOWN_SECONDS),
    recheckSeconds: parsePositive(env.get("SIGNAL_RECHECK_SECONDS"), DEFAULT_RECHECK_MS / 1000),
    minVolumeUsd: parsePositive(env.get("MIN_24H_VOLUME_USD"), DEFAULT_MIN_24H_VOLUME_USD),
    dcaEnabled: env.get("DCA_ENABLED")?.trim() === "true",
    dcaPositionsRefreshSeconds: parsePositive(
      env.get("DCA_POSITIONS_REFRESH_SECONDS"),
      DEFAULT_DCA_POSITIONS_REFRESH_SECONDS,
    ),
    priceStatsWriteEnabled,
    kvPriceStatsWriteEnabled: priceStatsWriteEnabled,
  };
}

const WS_URLS = {
  mainnet: "wss://api.hyperliquid.xyz/ws",
  testnet: "wss://api.hyperliquid-testnet.xyz/ws",
} as const;

const INFO_URLS = {
  mainnet: "https://api.hyperliquid.xyz/info",
  testnet: "https://api.hyperliquid-testnet.xyz/info",
} as const;

/**
 * 環境変数から設定を読み込む。
 * HL_NETWORK (既定 mainnet), HL_SYMBOLS (カンマ区切り),
 * HL_INCLUDE_OUTCOMES (true で予測市場も監視、既定 false)、
 * BREAKOUT_LIST_ENABLED (false / 0 / off / no で最高値・最低値の更新一覧を出力しない、既定は出力)。
 * シグナル関連: DIP_THRESHOLD_* / SURGE_THRESHOLD_* / ADDITIONAL_*_THRESHOLD_24H (不正値は既定値)、
 * SIGNAL_WRITE_ENABLED (true で D1 へ登録、既定はドライラン)、CF_ACCOUNT_ID / CF_TRADE_API_TOKEN / D1_DATABASE_ID /
 * CF_KV_NAMESPACE_ID、OPEN_QUEUE_ENABLED (true で登録直後に open-queue へ通知、既定は無効) /
 * OPEN_QUEUE_ID、COOLDOWN_SECONDS / SIGNAL_RECHECK_SECONDS / MIN_24H_VOLUME_USD (不正値は既定値)、
 * DCA_ENABLED (true で DCA シグナルを生成、既定は無効) / DCA_POSITIONS_REFRESH_SECONDS (不正値は既定値)
 *
 * @throws AppError (kind: "config") 不正な値が指定された場合。メッセージに該当の環境変数名を含む
 */
export function loadConfig(env: Env): AppConfig {
  const network = (env.get("HL_NETWORK")?.trim() || "mainnet").toLowerCase();
  if (network !== "mainnet" && network !== "testnet") {
    throw new AppError({
      kind: "config",
      service: "App",
      message: `HL_NETWORK が不正です: "${network}" (mainnet または testnet を指定してください)`,
      hint: "環境変数 HL_NETWORK に mainnet または testnet を指定してください",
    });
  }

  const symbols = (env.get("HL_SYMBOLS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const includeOutcomes = ["true", "1"].includes(
    (env.get("HL_INCLUDE_OUTCOMES") ?? "").trim().toLowerCase(),
  );

  // 一覧ログは既定で出力する。false / 0 / off / no (大文字小文字不問) のときだけ止める
  const listLogEnabled = !["false", "0", "off", "no"].includes(
    (env.get("BREAKOUT_LIST_ENABLED") ?? "").trim().toLowerCase(),
  );

  const redisUrl = env.get("REDIS_URL")?.trim() || "redis://localhost:6379";

  return {
    network,
    wsUrl: WS_URLS[network],
    infoUrl: INFO_URLS[network],
    symbols,
    includeOutcomes,
    listLogEnabled,
    redisUrl,
    signal: loadSignalConfig(env),
  };
}

/** 真偽値フラグの解釈規則: 有効と読む値・無効と読む値、認識できない値の扱い */
interface FlagRule {
  name: string;
  /** 有効として扱う値 (小文字化後) */
  on: readonly string[];
  /** 無効として扱う値 (小文字化後) */
  off: readonly string[];
  /** 認識できない値を、どう扱うか (警告文に使う) */
  fallback: string;
}

/**
 * 真偽値フラグの解釈規則の一覧。loadConfig の解釈と一致させること。
 * 実行スイッチは安全のため `true` だけを有効とし (大文字や `1` は無効)、
 * 一覧ログだけは既定が「出力する」のため、無効と読める値だけを無効にする
 */
const FLAG_RULES: readonly FlagRule[] = [
  { name: "SIGNAL_WRITE_ENABLED", on: ["true"], off: ["false"], fallback: "無効 (ドライラン)" },
  { name: "OPEN_QUEUE_ENABLED", on: ["true"], off: ["false"], fallback: "無効" },
  { name: "DCA_ENABLED", on: ["true"], off: ["false"], fallback: "無効" },
  {
    name: "PRICE_STATS_WRITE_ENABLED",
    on: ["true"],
    off: ["false", "0", "off", "no"],
    fallback: "有効 (同期する)",
  },
  {
    name: "KV_PRICE_STATS_WRITE_ENABLED",
    on: ["true"],
    off: ["false", "0", "off", "no"],
    fallback: "有効 (同期する)",
  },
  { name: "HL_INCLUDE_OUTCOMES", on: ["true", "1"], off: ["false", "0"], fallback: "無効 (除外)" },
  {
    name: "BREAKOUT_LIST_ENABLED",
    on: ["true"],
    off: ["false", "0", "off", "no"],
    fallback: "有効 (一覧を出力する)",
  },
];

/**
 * 真偽値フラグに、認識できない値 (打ち間違いなど) が指定されていないか調べ、警告文を返す。
 * 未設定・空は正常。loadConfig は認識できない値を安全側 (または既定) に倒すため、
 * 打ち間違いが無言で見過ごされないよう、起動時に警告する
 */
export function findInvalidFlagValues(env: Env): string[] {
  const warnings: string[] = [];
  for (const rule of FLAG_RULES) {
    const raw = env.get(rule.name);
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "" || rule.on.includes(value) || rule.off.includes(value)) continue;
    const accepted = [...rule.on, ...rule.off].join(" / ");
    warnings.push(
      `${rule.name} の値が認識できません: "${JSON.stringify(raw ?? "").slice(1, -1)}" ` +
        `(指定できる値: ${accepted})。${rule.fallback}として扱います`,
    );
  }
  return warnings;
}

/** 監視対象に指定されたが、既知の銘柄一覧に無い銘柄を返す (予測市場 `#...` は一覧の対象外のため除く) */
export function findUnknownSymbols(
  symbols: readonly string[],
  known: readonly string[],
): string[] {
  const knownSet = new Set(known);
  return symbols.filter((s) => !s.startsWith("#") && !knownSet.has(s));
}
