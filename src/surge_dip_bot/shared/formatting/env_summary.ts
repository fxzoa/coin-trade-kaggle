import { DEFAULT_DB_PATH } from "../constants/db_path.ts";
import { DEFAULT_MIN_24H_VOLUME_USD } from "../constants/kv_keys.ts";
import { redactSecrets } from "../domain/error_message.ts";
import { RANGE_WINDOWS } from "../domain/price_range.ts";
import { DEFAULT_SIGNAL_THRESHOLDS } from "../domain/trade_signal.ts";
import { DEFAULT_DCA_POSITIONS_REFRESH_SECONDS } from "../../worker/usecase/dca_position_cache.ts";
import { DEFAULT_COOLDOWN_SECONDS } from "../../worker/usecase/signal_cooldown.ts";
import { DEFAULT_RECHECK_MS } from "../../worker/usecase/signal_registrar.ts";

/**
 * 変数の種別 (表示方法を決める)。
 * - plain: 値をそのまま表示する
 * - list: カンマ区切りの一覧。先頭の一部のみ表示する
 * - identifier: Cloudflare の ID。先頭・末尾の一部だけ表示する
 * - secret: 認証情報。先頭・末尾の一部だけ表示する
 */
export type EnvKind = "plain" | "list" | "identifier" | "secret";

/** 環境変数の読み取り元 (loadConfig と同じ形。Deno.env を渡せる) */
type Env = { get(k: string): string | undefined };

/** 起動ログに出す環境変数 1 件の記述 */
export interface EnvVarSpec {
  name: string;
  kind: EnvKind;
  /** 未設定のときに表示する既定値の説明 */
  defaultText: string;
}

/** 表示用にグループ化した環境変数 */
export interface EnvGroup {
  title: string;
  vars: readonly EnvVarSpec[];
}

const MASK_EDGE_LENGTH = 4;
/** これより短い値は一切表示しない (先頭・末尾 4 文字ずつ + 伏せ字の余地がないため) */
const MASK_MIN_LENGTH = 12;
const MASK_FILL = "****";
/** HL_SYMBOLS の表示上限 */
const MAX_SYMBOLS_SHOWN = 20;

const plain = (name: string, defaultText: string): EnvVarSpec => ({
  name,
  kind: "plain",
  defaultText,
});

const identifier = (name: string): EnvVarSpec => ({
  name,
  kind: "identifier",
  defaultText: "なし",
});

/** `<PREFIX>_24H` 〜 `<PREFIX>_360D` の記述 (既定値は DEFAULT_SIGNAL_THRESHOLDS から取る) */
function periodThresholdSpecs(
  prefix: string,
  defaults: Readonly<Record<string, number>>,
): EnvVarSpec[] {
  return RANGE_WINDOWS.map(({ label }) => plain(`${prefix}_${label}`, `${defaults[label]}`));
}

/** 起動ログに出す環境変数の一覧 (src/ が読む全変数。tests/env_summary_test.ts で網羅を検証する) */
export const ENV_GROUPS: readonly EnvGroup[] = [
  {
    title: "Hyperliquid接続",
    vars: [
      plain("HL_NETWORK", "mainnet"),
      { name: "HL_SYMBOLS", kind: "list", defaultText: "全銘柄" },
      plain("HL_INCLUDE_OUTCOMES", "false"),
      plain("HL_DB_PATH", DEFAULT_DB_PATH),
    ],
  },
  {
    title: "実行スイッチ",
    vars: [
      plain("SIGNAL_WRITE_ENABLED", "無効 (ドライラン)"),
      plain("OPEN_QUEUE_ENABLED", "無効"),
      plain("DCA_ENABLED", "無効"),
      plain("PRICE_STATS_WRITE_ENABLED", "有効 (同期する)"),
    ],
  },
  {
    title: "キュー・DB連携",
    vars: [
      identifier("D1_DATABASE_ID"),
      identifier("OPEN_QUEUE_ID"),
    ],
  },
  {
    title: "チェック・クールダウン",
    vars: [
      plain("COOLDOWN_SECONDS", `${DEFAULT_COOLDOWN_SECONDS}`),
      plain("SIGNAL_RECHECK_SECONDS", `${DEFAULT_RECHECK_MS / 1000}`),
      plain("MIN_24H_VOLUME_USD", `${DEFAULT_MIN_24H_VOLUME_USD}`),
      plain("DCA_POSITIONS_REFRESH_SECONDS", `${DEFAULT_DCA_POSITIONS_REFRESH_SECONDS}`),
    ],
  },
  {
    title: "BUYしきい値",
    vars: [
      ...periodThresholdSpecs("DIP_THRESHOLD", DEFAULT_SIGNAL_THRESHOLDS.dip),
      plain("ADDITIONAL_DIP_THRESHOLD_24H", `${DEFAULT_SIGNAL_THRESHOLDS.additionalDip24h}`),
    ],
  },
  {
    title: "SELLしきい値",
    vars: [
      ...periodThresholdSpecs("SURGE_THRESHOLD", DEFAULT_SIGNAL_THRESHOLDS.surge),
      plain("ADDITIONAL_SURGE_THRESHOLD_24H", `${DEFAULT_SIGNAL_THRESHOLDS.additionalSurge24h}`),
    ],
  },
  {
    title: "表示",
    vars: [
      plain("BREAKOUT_LIST_ENABLED", "true"),
      plain("NO_COLOR", "なし"),
    ],
  },
];

/** 制御文字 (改行など) と Unicode の行・段落区切り */
// deno-lint-ignore no-control-regex -- 制御文字の検出が目的のため
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** 制御文字を `\n` や `\x1b` の形に置き換え、値でログの行を偽装できないようにする */
function escapeControlChars(text: string): string {
  return text.replace(UNSAFE_CHARS, (ch) => {
    switch (ch) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

/**
 * 値を先頭・末尾の数文字だけ残して伏せる (例: `cfut****f96c (53 文字)`)。
 * 12 文字未満の値は長さも含めて何も表示しない (`****`)
 */
function maskValue(value: string): string {
  const chars = Array.from(value);
  if (chars.length < MASK_MIN_LENGTH) return MASK_FILL;
  const head = chars.slice(0, MASK_EDGE_LENGTH).join("");
  const tail = chars.slice(-MASK_EDGE_LENGTH).join("");
  return `${head}${MASK_FILL}${tail} (${chars.length} 文字)`;
}

/** カンマ区切りの一覧を、先頭 MAX_SYMBOLS_SHOWN 件までに省略して表示する */
function formatList(value: string): string {
  const items = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length === 0) return "";
  const shown = items.slice(0, MAX_SYMBOLS_SHOWN).join(",");
  const omitted = items.length - MAX_SYMBOLS_SHOWN;
  return omitted > 0 ? `${shown} … 他 ${omitted} 件` : shown;
}

/** 種別に応じて設定済みの値を表示用に整える (空なら `(空)`) */
function formatValue(kind: EnvKind, raw: string): string {
  const value = raw.trim();
  if (kind === "list") return escapeControlChars(formatList(value)) || "(空)";
  if (value === "") return "(空)";
  return escapeControlChars(kind === "plain" ? value : maskValue(value));
}

/** 1 変数分の行 (インデント付き) */
function formatLine(spec: EnvVarSpec, env: Env): string {
  const raw = env.get(spec.name);
  return raw === undefined
    ? `  ${spec.name}=(未設定 → 既定: ${spec.defaultText})`
    : `  ${spec.name}=${formatValue(spec.kind, raw)}`;
}

/**
 * アプリが読む環境変数の値を、グループ別の複数行ブロックに整形する (起動時ログ用)。
 * 認証情報と ID は先頭・末尾のみ表示し、値に含まれる制御文字は escape する。
 * 最後に redactSecrets も通し、万一の混入を二重に防ぐ
 */
export function formatEnvSummary(env: Env): string {
  const lines = ["環境変数 (起動時の値)"];
  for (const group of ENV_GROUPS) {
    lines.push(`[${group.title}]`, ...group.vars.map((spec) => formatLine(spec, env)));
  }
  return redactSecrets(lines.join("\n"));
}
