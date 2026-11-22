/**
 * Top10 Volume Tracker: Time Helper Utilities
 * Provides timezone-aware date formatting (UTC+9 JST default) and scheduling calculations.
 */

import { DEFAULT_TZ_OFFSET_HOURS } from '../constants.ts';

export function getTzOffsetHours(): number {
  const envVal = Deno.env.get('TZ_OFFSET_HOURS');
  if (envVal !== undefined && envVal !== '') {
    const num = Number(envVal);
    if (Number.isFinite(num)) return num;
  }
  return DEFAULT_TZ_OFFSET_HOURS;
}

/**
 * Returns formatted ISO 8601 string with timezone offset (default UTC+9)
 * e.g. "2026-10-19T07:30:00.000+09:00"
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
 * Returns formatted date string for console logs
 * e.g. "2026-10-19 07:30:00"
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

/**
 * Calculates milliseconds remaining until the next top-of-the-hour (:00:00)
 * Adds a small buffer (500ms) to ensure execution strictly occurs in the new hour.
 */
export function getMsUntilNextHour(now: Date = new Date(), bufferMs: number = 500): number {
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  const diff = nextHour.getTime() - now.getTime() + bufferMs;
  return diff <= 0 ? 3600_000 : diff;
}
