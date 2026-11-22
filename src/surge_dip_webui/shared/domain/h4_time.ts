/** 4時間足1本分の長さ (ms) */
export const H4_MS = 4 * 60 * 60 * 1000;

/** 時刻 (ms) を直前の H4 境界 (UTC 0/4/8/12/16/20時) に切り下げる */
export function floorToH4(ms: number): number {
  return Math.floor(ms / H4_MS) * H4_MS;
}

/** 時刻 (ms) より後で最初の H4 境界を返す */
export function nextH4Boundary(ms: number): number {
  return floorToH4(ms) + H4_MS;
}
