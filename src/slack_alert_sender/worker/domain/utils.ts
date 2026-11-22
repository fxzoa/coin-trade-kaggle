/**
 * ドメインユーティリティ (日時・数値フォーマット)
 */

/**
 * 現在の日本時間 (JST: UTC+9) 文字列 (YYYY-MM-DD HH:mm:ss JST)
 */
export function getJstNowString(baseDate?: Date): string {
  const d = baseDate || new Date();
  const jstTime = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jstTime.toISOString().replace("T", " ").substring(0, 19) + " JST";
}

/**
 * タイムスタンプ（ミリ秒数値、秒数値、ISO文字列）を日本時間 (JST) 表記に変換
 * 10桁(秒) は 1000倍してミリ秒補正
 */
export function formatToJstString(
  timestamp?: number | string | null,
): string | null {
  if (timestamp === null || timestamp === undefined || timestamp === "") {
    return null;
  }
  let date: Date;
  if (typeof timestamp === "number") {
    date = timestamp < 1e11 ? new Date(timestamp * 1000) : new Date(timestamp);
  } else if (!isNaN(Number(timestamp))) {
    const num = Number(timestamp);
    date = num < 1e11 ? new Date(num * 1000) : new Date(num);
  } else {
    date = new Date(timestamp);
  }
  if (isNaN(date.getTime())) return null;
  const jstTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jstTime.toISOString().replace("T", " ").substring(0, 19) + " JST";
}

/**
 * 3桁カンマ区切りの数値文字列
 */
export function formatNumber(
  num: number | null | undefined,
  decimals: number = 2,
): string {
  if (num === null || num === undefined || isNaN(num)) return "0.00";
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
