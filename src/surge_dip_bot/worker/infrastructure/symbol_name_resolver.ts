import { formatError } from "../../shared/errors.ts";
import { defaultFetch, type FetchLike } from "./fetch_like.ts";
import { type ResilienceOptions, runRead } from "./resilience.ts";
import { badResponse, postInfo } from "./rest_response.ts";

/** spotMeta レスポンスのうち、名前解決に必要な部分 */
export interface SpotMeta {
  universe: { name: string; index: number; tokens: number[] }[];
  tokens: { name: string; index: number }[];
}

/** outcomeMeta レスポンスのうち、名前解決に必要な部分 */
export interface OutcomeMeta {
  outcomes: {
    outcome: number;
    name: string;
    description: string;
    sideSpecs: { name: string }[];
  }[];
}

/** 内部銘柄名を表示用の名前へ変換する関数 (未知の銘柄はそのまま返す) */
export type SymbolNameResolver = (symbol: string) => string;

const OUTCOME_SYMBOL = /^#(\d+)$/;

/** `template:Yes` のようなテンプレート接頭辞を取り除く */
function stripTemplate(name: string): string {
  return name.replace(/^template:/, "");
}

/** 現物ペア (`@107` → `HYPE/USDC`) の対応表を作る */
function buildSpotNames(meta: SpotMeta): Map<string, string> {
  const tokenNames = new Map(meta.tokens.map((t) => [t.index, t.name]));
  const names = new Map<string, string>();
  for (const pair of meta.universe) {
    const [base, quote] = pair.tokens.map((i) => tokenNames.get(i));
    // `PURR/USDC` のように最初から名前が付いているペアは変換不要
    if (pair.name.startsWith("@") && base && quote) names.set(pair.name, `${base}/${quote}`);
  }
  return names;
}

/** 予測市場 (`#88600` → `予測市場 <説明> [Yes]`) の対応表を作る */
function buildOutcomeNames(meta: OutcomeMeta): Map<number, { label: string; sides: string[] }> {
  return new Map(meta.outcomes.map((o) => [
    o.outcome,
    {
      label: stripTemplate(o.description || o.name),
      sides: o.sideSpecs.map((s) => stripTemplate(s.name)),
    },
  ]));
}

/** メタ情報から名前解決関数を組み立てる (純粋関数) */
export function buildSymbolNameResolver(
  spot: SpotMeta | null,
  outcome: OutcomeMeta | null,
): SymbolNameResolver {
  const spotNames = spot ? buildSpotNames(spot) : new Map<string, string>();
  const outcomeNames = outcome ? buildOutcomeNames(outcome) : new Map();

  return (symbol) => {
    const spotName = spotNames.get(symbol);
    if (spotName) return spotName;

    const matched = OUTCOME_SYMBOL.exec(symbol);
    if (matched) {
      const encoded = Number(matched[1]);
      // 末尾1桁が側 (0=1番目, 1=2番目)、残りが outcome ID
      const info = outcomeNames.get(Math.floor(encoded / 10));
      if (info) {
        const side = info.sides[encoded % 10];
        return `予測市場 ${info.label}${side ? ` [${side}]` : ""}`;
      }
    }
    return symbol;
  };
}

/** spotMeta として使える形か (universe / tokens が配列) */
function isSpotMeta(data: unknown): data is SpotMeta {
  const meta = data as Partial<SpotMeta> | null;
  return Array.isArray(meta?.universe) && Array.isArray(meta.tokens);
}

/** outcomeMeta として使える形か (outcomes が配列) */
function isOutcomeMeta(data: unknown): data is OutcomeMeta {
  return Array.isArray((data as Partial<OutcomeMeta> | null)?.outcomes);
}

/**
 * Info API から spotMeta / outcomeMeta を取得して名前解決関数を作る。
 * 取得に失敗したメタ情報は無視し (onLog に通知)、その種別は内部名のまま表示する。
 * 参照のみで冪等なため、一時的な失敗は再試行する (遮断器(再試行(POST)))。
 */
export async function fetchSymbolNameResolver(
  infoUrl: string,
  onLog: (msg: string) => void = () => {},
  fetchFn: FetchLike = defaultFetch,
  resilience: ResilienceOptions = {},
): Promise<SymbolNameResolver> {
  const load = async <T>(
    type: string,
    isValid: (data: unknown) => data is T,
  ): Promise<T | null> => {
    try {
      return await runRead("HyperliquidInfo", resilience, async () => {
        const data = await postInfo(fetchFn, infoUrl, { type }, type);
        if (!isValid(data)) throw badResponse("HyperliquidInfo", `${type} の応答形式が不正です`);
        return data;
      });
    } catch (e) {
      onLog(
        `${
          formatError(e, "HyperliquidInfo")
        } - ${type} を取得できなかったため内部名のまま表示します`,
      );
      return null;
    }
  };
  const [spot, outcome] = await Promise.all([
    load("spotMeta", isSpotMeta),
    load("outcomeMeta", isOutcomeMeta),
  ]);
  return buildSymbolNameResolver(spot, outcome);
}
