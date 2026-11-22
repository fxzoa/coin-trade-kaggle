import { err, ok, type Result } from "../result.ts";
import { DomainError } from "../errors.ts";

/** ローソク足 (1本分) */
export interface Candle {
  /** 銘柄 (HL の内部名) */
  symbol: string;
  /** 足の開始時刻 (ms) */
  openTime: number;
  /** 足の終了時刻 (ms) */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 出来高 (ベース通貨建て) */
  volume: number;
  /** 約定回数 */
  trades: number;
}

/**
 * Validate that an unknown value conforms to a Candle structure.
 */
export function validateCandle(data: unknown): Result<Candle, DomainError> {
  if (typeof data !== "object" || data === null) {
    return err(new DomainError("Candle data must be a non-null object"));
  }
  const c = data as Record<string, unknown>;
  if (typeof c.symbol !== "string" || c.symbol.trim() === "") {
    return err(new DomainError("Candle symbol must be a non-empty string"));
  }
  if (typeof c.openTime !== "number" || !Number.isFinite(c.openTime)) {
    return err(new DomainError("Candle openTime must be a finite number"));
  }
  if (typeof c.closeTime !== "number" || !Number.isFinite(c.closeTime)) {
    return err(new DomainError("Candle closeTime must be a finite number"));
  }
  for (const prop of ["open", "high", "low", "close", "volume", "trades"] as const) {
    if (typeof c[prop] !== "number" || !Number.isFinite(c[prop] as number)) {
      return err(new DomainError(`Candle ${prop} must be a finite number`));
    }
  }
  return ok(c as unknown as Candle);
}
