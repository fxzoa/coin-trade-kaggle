/**
 * btc-grid-deno: JST 日時ヘルパー
 * OS/コンテナのタイムゾーンに関係なく確実に日本標準時 (UTC+9) を生成
 */

function getTzOffsetHours(): number {
  const envVal = Deno.env.get('TZ_OFFSET_HOURS');
  if (envVal !== undefined && envVal !== '') {
    const num = Number(envVal);
    if (Number.isFinite(num)) return num;
  }
  return 9;
}

/**
 * 指定オフセット (既定値: TZ_OFFSET_HOURS または 9=JST) の ISO 8601 文字列を生成
 * 例: "2026-10-18T16:17:50.123+09:00"
 */
export function getJstIsoString(date: Date = new Date(), offsetHours: number = getTzOffsetHours()): string {
  const targetMs = date.getTime() + offsetHours * 60 * 60 * 1000;
  const target = new Date(targetMs);

  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  const ss = String(target.getUTCSeconds()).padStart(2, '0');
  const ms = String(target.getUTCMilliseconds()).padStart(3, '0');

  const sign = offsetHours >= 0 ? '+' : '-';
  const absHours = Math.abs(offsetHours);
  const hhOffset = String(Math.floor(absHours)).padStart(2, '0');
  const mmOffset = String(Math.floor((absHours % 1) * 60)).padStart(2, '0');
  const offsetStr = `${sign}${hhOffset}:${mmOffset}`;

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}${offsetStr}`;
}

/**
 * コンソールログ表示用の日時文字列を生成
 * 例: "2026-10-18 16:17:50"
 */
export function getJstLogString(date: Date = new Date(), offsetHours: number = getTzOffsetHours()): string {
  const targetMs = date.getTime() + offsetHours * 60 * 60 * 1000;
  const target = new Date(targetMs);

  const y = target.getUTCFullYear();
  const m = String(target.getUTCMonth() + 1).padStart(2, '0');
  const d = String(target.getUTCDate()).padStart(2, '0');
  const hh = String(target.getUTCHours()).padStart(2, '0');
  const mm = String(target.getUTCMinutes()).padStart(2, '0');
  const ss = String(target.getUTCSeconds()).padStart(2, '0');

  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}
