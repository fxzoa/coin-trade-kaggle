/**
 * multi-dca-bot: 日本標準時 (JST) 日時ヘルパー
 */

export function getJstDate(date: Date = new Date()): Date {
  const envVal = Deno.env.get('TZ_OFFSET_HOURS');
  const offsetHours = envVal !== undefined && envVal !== '' ? Number(envVal) : 9;
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 3600000 * offsetHours);
}

/**
 * ログ用フォーマット: YYYY-MM-DD HH:mm:ss (JST文字なし)
 */
export function formatJstLog(date: Date = new Date()): string {
  const jst = getJstDate(date);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = jst.getFullYear();
  const mm = pad(jst.getMonth() + 1);
  const dd = pad(jst.getDate());
  const HH = pad(jst.getHours());
  const MM = pad(jst.getMinutes());
  const SS = pad(jst.getSeconds());
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

/**
 * ISO 形式の JST 文字列 (YYYY-MM-DDTHH:mm:ss.sss+09:00)
 */
export function getJstIsoString(date: Date = new Date()): string {
  const jst = getJstDate(date);
  const pad = (n: number, width = 2) => n.toString().padStart(width, '0');
  const yyyy = jst.getFullYear();
  const mm = pad(jst.getMonth() + 1);
  const dd = pad(jst.getDate());
  const HH = pad(jst.getHours());
  const MM = pad(jst.getMinutes());
  const SS = pad(jst.getSeconds());
  const mss = pad(jst.getMilliseconds(), 3);
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}.${mss}+09:00`;
}
