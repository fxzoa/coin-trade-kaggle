import type { TradeSignal } from "../domain/trade_signal.ts";

/** 売買方向の表示名 */
const SIDE_LABELS = { LONG: "BUY", SHORT: "SELL" } as const;

/** 登録の状態 */
export type SignalLogMode = "dry-run" | "registered" | "detected";

/**
 * シグナル 1 件を 1 行のログへ整形する。
 * note を指定すると末尾に付ける (ドライランでのチェック実施状況など)
 */
export function formatSignal(signal: TradeSignal, mode: SignalLogMode, note?: string): string {
  const prefix = mode === "registered"
    ? "シグナルを登録しました"
    : mode === "detected"
    ? "シグナル発生"
    : "シグナル検出 (ドライラン・未登録)";
  return `${prefix}: ${SIDE_LABELS[signal.side]}(${signal.side}) ${signal.symbol} ` +
    `${signal.signalType} 価格=${signal.price} ${formatChangePct(signal.changePct)} ` +
    `サイズ=$${signal.targetSize} source=${signal.source}${note ? ` [${note}]` : ""}`;
}

/** 変動率の表示。DCA シグナルのように未設定の場合は「変動率なし」 */
function formatChangePct(changePct: number | undefined): string {
  return changePct === undefined ? "変動率なし" : `変動率=${changePct.toFixed(2)}%`;
}
