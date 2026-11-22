import type { PriceTick } from "../shared/price_monitor/types.ts";
import { toError, ValidationError } from "../shared/price_monitor/errors.ts";
import { err, ok, type Result } from "../shared/price_monitor/result.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hyperliquid の allMids メッセージから価格ティック配列をパースする (Result 版)
 */
export function parseAllMidsResult(
  raw: string,
  now: number = Date.now(),
): Result<PriceTick[], ValidationError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    return err(
      new ValidationError("Invalid JSON in allMids payload", {
        cause: toError(e),
      }),
    );
  }

  if (!isRecord(parsed)) {
    return err(new ValidationError("Payload must be a JSON object"));
  }

  if (parsed.channel !== "allMids") {
    return err(
      new ValidationError(
        `Unexpected channel '${String(parsed.channel)}', expected 'allMids'`,
        { context: { channel: parsed.channel } },
      ),
    );
  }

  const data = parsed.data;
  if (!isRecord(data) || !isRecord(data.mids)) {
    return err(new ValidationError("Missing 'data.mids' object in payload"));
  }

  const ticks: PriceTick[] = [];
  for (const [symbol, value] of Object.entries(data.mids)) {
    const price = typeof value === "string" ? Number(value) : NaN;
    if (value === "" || !Number.isFinite(price)) continue;
    ticks.push({ symbol, price, timestamp: now });
  }
  return ok(ticks);
}

/**
 * Hyperliquid の allMids メッセージから価格ティック配列をパースする
 */
export function parseAllMids(raw: string, now: number = Date.now()): PriceTick[] {
  const result = parseAllMidsResult(raw, now);
  return result.ok ? result.value : [];
}

/**
 * 予測市場銘柄 (#XXXXX 形式) かどうかを判定する
 */
export function isOutcomeSymbol(symbol: string): boolean {
  return symbol.startsWith("#") && !isNaN(Number(symbol.slice(1)));
}
