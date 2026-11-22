/**
 * KV の生値を解釈する純粋関数群。
 * cf-workers/common-worker-utils/src/kv_helper.ts と buyer/seller-worker の kv_helper.ts の
 * 判定を、挙動 (癖を含む) ごと移植している
 */

/**
 * フラグ文字列または JSON を真偽値にする (common-worker-utils の parseBooleanFlag と同じ)。
 * JSON の真偽値、`enabled` キーを持つオブジェクト、文字列 true / 1 / on を ON とする
 */
export function parseBooleanFlag(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "object" && parsed !== null && "enabled" in parsed) {
      return Boolean(parsed.enabled);
    }
  } catch {
    // 非 JSON 文字列は下の文字列判定へ
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "on";
}

/**
 * トレード有効化フラグを解決する (isTradeFlagEnabled と同じ)。
 * 主キーが設定済みならそれだけを見て、未設定 (null) のときだけ旧キーを見る。どちらも無ければ OFF
 */
export function resolveTradeFlag(rawKey: string | null, rawFallback: string | null): boolean {
  if (rawKey !== null) return parseBooleanFlag(rawKey);
  if (rawFallback !== null) return parseBooleanFlag(rawFallback);
  return false;
}

/** Insufficient 停止の状態 */
export interface InsufficientCooldownState {
  active: boolean;
  reason?: string;
  untilIso?: string;
}

/**
 * Insufficient 停止フラグを解釈する (getInsufficientCooldown と同じ)。
 * - 未設定・空: 停止していない
 * - JSON オブジェクト: `enabled ?? active ?? false` が真、かつ untilIso が未設定または未来なら停止中
 * - それ以外 (JSON の真偽値・数値や非 JSON 文字列を含む): 停止中として扱う (worker の挙動のまま)
 */
export function parseInsufficientCooldown(
  raw: string | null,
  nowMs: number,
): InsufficientCooldownState {
  if (!raw) return { active: false };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const isEnabled = parsed.enabled ?? parsed.active ?? false;
      const notExpired = !parsed.untilIso || nowMs < new Date(parsed.untilIso).getTime();
      return {
        active: Boolean(isEnabled) && notExpired,
        reason: parsed.reason,
        untilIso: parsed.untilIso,
      };
    }
  } catch {
    // JSON でない値は下で停止中として扱う
  }
  return { active: true, reason: raw };
}

/**
 * 除外銘柄リストの生値 (JSON 配列またはカンマ区切り) を大文字の Set にする
 * (getOrInitExcludedCoins と同じ。JSON として解釈できるが配列でない値は空集合)
 */
export function parseExcludedCoins(raw: string): Set<string> {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(
        parsed
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim().toUpperCase()),
      );
    }
  } catch {
    const items = raw.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
    if (items.length > 0) return new Set(items);
  }
  return new Set();
}

/**
 * 最小取引高の KV 上書き値を解釈する (resolveMinVolumeUsd と同じ)。
 * 空でない 0 以上の数値のときだけ採用し、それ以外は null (上書きなし)
 */
export function parseMinVolumeOverride(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return !isNaN(parsed) && parsed >= 0 ? parsed : null;
}
