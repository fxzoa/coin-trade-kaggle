/** 予測市場 (outcome market) の銘柄かどうか。`#<outcomeId><側>` 形式で表される */
export function isOutcomeSymbol(symbol: string): boolean {
  return symbol.startsWith("#");
}
