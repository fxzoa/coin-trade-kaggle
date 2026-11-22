import type { PriceTick } from "./types.ts";

/**
 * Hyperliquid の allMids メッセージを価格ティック配列へ変換する。
 * 他チャンネル・不正JSON・非数値は無視し、例外は投げない。
 *
 * @param raw 受信した生のメッセージ文字列
 * @param now タイムスタンプ (省略時は現在時刻)
 */
export function parseAllMids(raw: string, now: number = Date.now()): PriceTick[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || parsed.channel !== "allMids") return [];
  const data = parsed.data;
  if (!isRecord(data) || !isRecord(data.mids)) return [];

  const ticks: PriceTick[] = [];
  for (const [symbol, value] of Object.entries(data.mids)) {
    const price = typeof value === "string" ? Number(value) : NaN;
    if (value === "" || !Number.isFinite(price)) continue;
    ticks.push({ symbol, price, timestamp: now });
  }
  return ticks;
}

/** 値が null でないオブジェクトかを判定する型ガード */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
