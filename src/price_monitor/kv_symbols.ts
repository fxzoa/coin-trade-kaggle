import { Redis } from "ioredis";
import { toError, UpstreamApiError, ValidationError } from "../shared/price_monitor/errors.ts";
import { err, ok, type Result } from "../shared/price_monitor/result.ts";

export const FALLBACK_TARGET_COINS: string[] = [
  "BTC",
  "ETH",
  "ATOM",
  "DYDX",
  "SOL",
  "AVAX",
  "BNB",
  "APE",
  "OP",
  "LTC",
  "ARB",
  "DOGE",
  "INJ",
  "SUI",
  "kPEPE",
  "CRV",
  "LDO",
  "LINK",
  "STX",
  "CFX",
  "GMX",
  "SNX",
  "XRP",
  "BCH",
  "APT",
  "AAVE",
  "COMP",
  "WLD",
  "YGG",
  "TRX",
  "kSHIB",
  "UNI",
  "SEI",
  "RUNE",
  "ZRO",
  "DOT",
  "BANANA",
  "TRB",
  "BIGTIME",
  "KAS",
  "BLUR",
  "TIA",
  "BSV",
  "ADA",
  "MINA",
  "POLYX",
  "GAS",
  "PENDLE",
  "FET",
  "NEAR",
  "MEME",
  "ORDI",
  "NEO",
  "ZEN",
  "FIL",
  "PYTH",
  "SUSHI",
  "IMX",
  "kBONK",
  "GMT",
  "SUPER",
  "JUP",
  "kLUNC",
  "RSR",
  "GALA",
  "JTO",
  "ACE",
  "WIF",
  "CAKE",
  "PEOPLE",
  "ENS",
  "ETC",
  "XAI",
  "MANTA",
  "UMA",
  "ONDO",
  "ALT",
  "ZETA",
  "DYM",
  "W",
  "STRK",
  "TAO",
  "AR",
  "kFLOKI",
  "BOME",
  "ETHFI",
  "ENA",
  "MNT",
  "TNSR",
  "SAGA",
  "MERL",
  "HBAR",
  "POPCAT",
  "EIGEN",
  "REZ",
  "NOT",
  "TURBO",
  "BRETT",
  "IO",
  "ZK",
  "RENDER",
  "POL",
  "CELO",
  "HMSTR",
  "kNEIRO",
  "GOAT",
  "MOODENG",
  "GRASS",
  "PURR",
  "PNUT",
  "XLM",
  "SAND",
  "IOTA",
  "ALGO",
  "HYPE",
  "ME",
  "MOVE",
  "VIRTUAL",
  "PENGU",
  "USUAL",
  "FARTCOIN",
  "AIXBT",
  "BIO",
  "GRIFFAIN",
  "SPX",
  "S",
  "MORPHO",
  "TRUMP",
  "MELANIA",
  "ANIME",
  "VVV",
  "BERA",
  "LAYER",
  "KAITO",
  "NIL",
  "PAXG",
  "BABY",
  "WCT",
  "HYPER",
  "ZORA",
  "INIT",
  "NXPC",
  "SOPH",
  "RESOLV",
  "SYRUP",
  "PUMP",
  "PROVE",
  "XPL",
  "WLFI",
  "LINEA",
  "SKY",
  "ASTER",
  "AVNT",
  "STBL",
  "0G",
  "HEMI",
  "APEX",
  "2Z",
  "ZEC",
  "MON",
  "MET",
  "MEGA",
  "CC",
  "ICP",
  "AERO",
  "STABLE",
  "FOGO",
  "LIT",
  "XMR",
  "AXS",
  "DASH",
  "SKR",
  "AZTEC",
  "CHIP",
  "GRAM",
  "CASHCAT",
  "PONS",
  "USELESS",
];

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set?(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

export interface LoadTargetCoinsOptions {
  infoUrl?: string;
  redis?: RedisClientLike;
  redisUrl?: string;
  redisKeyPrefix?: string;
  redisKey?: string;
  preferCache?: boolean;
  onLog?: (msg: string) => void;
  onError?: (err: unknown) => void;
  // Backward compatibility options (deprecated)
  accountId?: string;
  namespaceId?: string;
  apiToken?: string;
}

export type FetchKvTargetCoinsOptions = LoadTargetCoinsOptions;

/**
 * Hyperliquid Info API またはキャッシュのレスポンスから銘柄名リストを抽出する
 */
export function extractCoinsFromMeta(body: unknown): string[] {
  const coins: string[] = [];

  if (Array.isArray(body)) {
    // Hyperliquid 標準形式: [ { universe: [ { name: "BTC", isDelisted?: boolean } ] }, [ ... ] ]
    if (
      body.length > 0 &&
      body[0] &&
      typeof body[0] === "object" &&
      "universe" in body[0] &&
      Array.isArray((body[0] as Record<string, unknown>).universe)
    ) {
      const universe = (
        body[0] as { universe: Array<{ name?: string; isDelisted?: boolean; coin?: string }> }
      ).universe;
      for (const item of universe) {
        if (!item || item.isDelisted) continue;
        const name = item.name ?? item.coin;
        if (typeof name === "string" && name.trim().length > 0) {
          coins.push(name.trim());
        }
      }
      return coins;
    }

    // 単純配列形式: [ { name: "BTC" }, { coin: "ETH" }, "SOL" ]
    for (const item of body) {
      if (typeof item === "string" && item.trim().length > 0) {
        coins.push(item.trim());
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (record.isDelisted) continue;
        const name = record.name ?? record.coin;
        if (typeof name === "string" && name.trim().length > 0) {
          coins.push(name.trim());
        }
      }
    }
    return coins;
  }

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    // { universe: [ ... ] }
    if (Array.isArray(record.universe)) {
      for (
        const item of record.universe as Array<{
          name?: string;
          isDelisted?: boolean;
          coin?: string;
        }>
      ) {
        if (!item || item.isDelisted) continue;
        const name = item.name ?? item.coin;
        if (typeof name === "string" && name.trim().length > 0) {
          coins.push(name.trim());
        }
      }
      return coins;
    }
    // { data: [ ... ] }
    if ("data" in record) {
      return extractCoinsFromMeta(record.data);
    }
  }

  return coins;
}

async function getCachedCoinsFromRedis(
  redisClient: RedisClientLike,
  key: string,
): Promise<Set<string> | null> {
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const coins = extractCoinsFromMeta(parsed);
    if (coins.length > 0) {
      return new Set(coins);
    }
  } catch {
    // Redis 読み取りエラーは無視して上位へ
  }
  return null;
}

/**
 * 固定178銘柄リストを返し、Redis の hl:target_coins に同期保存する。
 * Hyperliquid Info API (metaAndAssetCtxs) への外部取得は行わない。
 */
export async function loadTargetCoinsResult(
  options: LoadTargetCoinsOptions = {},
): Promise<Result<Set<string>, ValidationError>> {
  const redisKey = options.redisKey ?? `${options.redisKeyPrefix ?? "hl:"}target_coins`;
  const coinSet = new Set(FALLBACK_TARGET_COINS);

  let temporaryRedis: InstanceType<typeof Redis> | null = null;
  const getRedisClient = (): RedisClientLike | null => {
    if (options.redis) return options.redis;
    if (options.redisUrl) {
      try {
        temporaryRedis = new Redis(options.redisUrl, {
          lazyConnect: true,
          connectTimeout: 2000,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        });
        return temporaryRedis;
      } catch {
        return null;
      }
    }
    return null;
  };

  try {
    options.onLog?.(
      `[Target Coins] Using fixed ${coinSet.size} coins list (metaAndAssetCtxs fetch disabled).`,
    );

    // Redis へ固定178銘柄を同期保存
    const redisClient = getRedisClient();
    if (redisClient && redisClient.set) {
      try {
        await redisClient.set(redisKey, JSON.stringify(FALLBACK_TARGET_COINS));
        options.onLog?.(`[Target Coins] Synced fixed ${coinSet.size} coins to Redis (${redisKey})`);
      } catch (e: unknown) {
        options.onError?.(toError(e));
      }
    }

    return ok(coinSet);
  } finally {
    if (temporaryRedis) {
      try {
        await (temporaryRedis as InstanceType<typeof Redis>).quit();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 後方互換性エイリアス
 */
export const fetchKvTargetCoinsResult = loadTargetCoinsResult;
export const fetchTargetCoinsResult = loadTargetCoinsResult;

/**
 * 固定178銘柄を取得し、Redisに同期する
 */
export async function loadTargetCoins(
  options: LoadTargetCoinsOptions = {},
): Promise<Set<string>> {
  const result = await loadTargetCoinsResult(options);
  if (result.ok) {
    return result.value;
  }
  return new Set(FALLBACK_TARGET_COINS);
}

/**
 * 後方互換性エイリアス
 */
export const fetchKvTargetCoins = loadTargetCoins;
