import type { Candle } from "../../shared/domain/candle.ts";
import { defaultFetch, type FetchLike } from "./fetch_like.ts";
import { type ResilienceOptions, runRead } from "./resilience.ts";
import { badResponse, postInfo } from "./rest_response.ts";

/** candleSnapshot レスポンスの1要素 (数値は文字列で返る) */
interface RawCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

/** 生レスポンスを Candle へ変換する */
function toCandle(raw: RawCandle): Candle {
  return {
    symbol: raw.s,
    openTime: raw.t,
    closeTime: raw.T,
    open: Number(raw.o),
    high: Number(raw.h),
    low: Number(raw.l),
    close: Number(raw.c),
    volume: Number(raw.v),
    trades: raw.n,
  };
}

/**
 * Info API の candleSnapshot からローソク足を取得する。
 * 参照のみで冪等なため、429 / 5xx / 通信エラー・タイムアウトは指数バックオフ + ジッタで最初の呼出しから 100 秒まで再試行し (共通方式: withRetry)、
 * それでも失敗したら AppError (service="HyperliquidInfo") を投げる。
 * 該当銘柄が無い場合は空配列を返す。
 */
export function fetchCandles(
  infoUrl: string,
  coin: string,
  interval: string,
  startTime: number,
  endTime: number,
  fetchFn: FetchLike = defaultFetch,
  resilience: ResilienceOptions = {},
): Promise<Candle[]> {
  return runRead("HyperliquidInfo", resilience, async () => {
    const data = await postInfo(
      fetchFn,
      infoUrl,
      { type: "candleSnapshot", req: { coin, interval, startTime, endTime } },
      `coin=${coin}`,
    );
    if (!Array.isArray(data)) {
      throw badResponse(
        "HyperliquidInfo",
        `candleSnapshot の応答が配列ではありません (coin=${coin})`,
      );
    }
    return (data as RawCandle[]).map(toCandle);
  });
}
