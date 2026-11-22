import { classifyError, formatError } from "../../shared/errors.ts";
import type { Candle } from "../../shared/domain/candle.ts";

/** バックフィルの入力 */
export interface BackfillOptions {
  symbols: readonly string[];
  /** 取得範囲の開始時刻 (ms) */
  startTime: number;
  /** 取得範囲の終了時刻 (ms) */
  endTime: number;
  /** 通貨ごとの取得処理 (再試行はこの関数側で行う。失敗は AppError として投げると分類が保たれる) */
  fetchCandles: (symbol: string, startTime: number, endTime: number) => Promise<Candle[]>;
  /** 通貨ごとの保存処理 */
  save: (candles: Candle[]) => void | Promise<void>;
  /** 通貨間の待機 (レート制限対策) */
  sleep: (ms: number) => Promise<void>;
  /** 通貨間の待機時間 (ms) */
  intervalMs: number;
  onLog: (msg: string) => void;
}

/** バックフィル結果 */
export interface BackfillResult {
  /** 保存できた銘柄数 */
  saved: number;
  /** 保存した本数の合計 */
  totalCandles: number;
  /** HL にデータが無かった銘柄 */
  empty: string[];
  /** 取得に失敗した銘柄 */
  failed: string[];
}

/** 1銘柄を取得する。分類されていない失敗は Info API の失敗として扱う */
async function fetchOne(opts: BackfillOptions, symbol: string): Promise<Candle[]> {
  try {
    return await opts.fetchCandles(symbol, opts.startTime, opts.endTime);
  } catch (e) {
    throw classifyError(e, "HyperliquidInfo");
  }
}

/** 1銘柄分を保存する。分類されていない失敗は SQLite の失敗として扱う */
async function saveOne(opts: BackfillOptions, candles: Candle[]): Promise<void> {
  try {
    await opts.save(candles);
  } catch (e) {
    throw classifyError(e, "SQLite");
  }
}

/**
 * 全銘柄の指定範囲のローソク足を順次取得して保存する。
 * 1銘柄の失敗 (取得: HyperliquidInfo、保存: SQLite) は分類してログに残し、他の銘柄の処理を続ける
 */
export async function backfillCandles(opts: BackfillOptions): Promise<BackfillResult> {
  const result: BackfillResult = { saved: 0, totalCandles: 0, empty: [], failed: [] };

  for (const [i, symbol] of opts.symbols.entries()) {
    const progress = `[${i + 1}/${opts.symbols.length}] ${symbol}`;
    try {
      const candles = await fetchOne(opts, symbol);
      if (candles.length === 0) {
        opts.onLog(`${progress}: データがありません (スキップ)`);
        result.empty.push(symbol);
      } else {
        await saveOne(opts, candles);
        result.saved++;
        result.totalCandles += candles.length;
        opts.onLog(`${progress}: ${candles.length} 本を保存しました`);
      }
    } catch (e) {
      opts.onLog(`${progress}: 失敗しました ${formatError(e)}`);
      result.failed.push(symbol);
    }
    if (i < opts.symbols.length - 1) await opts.sleep(opts.intervalMs);
  }
  return result;
}
