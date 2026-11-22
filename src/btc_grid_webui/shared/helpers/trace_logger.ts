/**
 * btc-grid-deno: トレースロガー
 * スキャン実行履歴のファイル永続化 (JSONLines) および traceId 生成
 */

import type { TraceRecord } from '../types.ts';
import { logger } from '../logger.ts';
import { toError } from '../errors.ts';

export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getTraceIdDisplayLength(): number {
  const envVal = Deno.env.get('TRACE_ID_DISPLAY_LENGTH');
  if (envVal !== undefined && envVal !== '') {
    const num = Number(envVal);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 4;
}

/**
 * ログ表示用に traceId を短縮 (既定値: TRACE_ID_DISPLAY_LENGTH または 4桁)
 * 例: "4ed003cae7b199259d022d4e9ae6fef2" -> "4ed0"
 */
export function formatShortTraceId(traceId?: string, length: number = getTraceIdDisplayLength()): string {
  if (!traceId) return '';
  return traceId.length > length ? traceId.slice(0, length) : traceId;
}


export class TraceLogger {
  private readonly logFilePath: string;

  constructor(logFilePath?: string) {
    this.logFilePath = logFilePath || Deno.env.get('TRACE_LOG_PATH') || './data/trace.log';
  }

  /**
   * トレースレコードをファイルへ JSONL 形式で追記
   */
  async append(record: TraceRecord): Promise<void> {
    try {
      const line = JSON.stringify(record) + '\n';
      await Deno.writeTextFile(this.logFilePath, line, { append: true, create: true });
    } catch (err: unknown) {
      const error = toError(err);
      logger.warn(`[TraceLogger] トレースログ書き込み失敗 (${this.logFilePath}):`, error);
    }
  }

  /**
   * 直近 N 行のトレースログを読み込む
   */
  async readRecent(limit = 50): Promise<TraceRecord[]> {
    try {
      const content = await Deno.readTextFile(this.logFilePath);
      const lines = content.trim().split('\n').filter(Boolean);
      const recentLines = lines.slice(-limit);
      const records: TraceRecord[] = [];
      for (const line of recentLines) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // ignore corrupted line
        }
      }
      return records.reverse(); // 新しい順
    } catch (err: unknown) {
      const error = toError(err);
      logger.debug(`[TraceLogger] トレースログ読み込みスキップ (${this.logFilePath}):`, error.message);
      return [];
    }
  }
}
