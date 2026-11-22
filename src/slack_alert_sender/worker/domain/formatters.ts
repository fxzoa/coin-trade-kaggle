/**
 * メッセージフォーマッター実装
 * 各種取引・エラー・通知イベントを Slack 向け markdown 形式に整形する
 */

import type {
  SendClosePositionAlertRequest,
  SendErrorAlertRequest,
  SendFillEventAlertRequest,
  SendInfoAlertRequest,
  SendOrderCanceledAlertRequest,
  SendOrderOpenAlertRequest,
} from "../types.ts";
import { formatNumber, formatToJstString, getJstNowString } from "./utils.ts";

export { formatNumber, formatToJstString, getJstNowString };

function buildTimestampLines(
  apiTimestamp?: string | number,
  label: string = "HY Time",
): string[] {
  const apiJst = formatToJstString(apiTimestamp);
  const lines: string[] = [];
  if (apiJst) {
    lines.push(`• *${label}*: \`${apiJst}\``);
  }
  return lines;
}

/**
 * 1. ERROR 通知メッセージ整形
 * 🚨 【ERROR ALERT】 🚨
 */
export function formatErrorMessage(req: SendErrorAlertRequest): string {
  const nowJst = getJstNowString();
  const lines: string[] = [
    `[${nowJst}]`,
    "🚨 *【ERROR ALERT】* 🚨",
    ...buildTimestampLines(req.apiTimestamp),
  ];

  if (req.context) lines.push(`• *処理*: \`${req.context}\``);
  if (req.coin) lines.push(`• *対象銘柄*: *${req.coin}*`);
  lines.push(`• *エラー内容*: \`\`\`${req.errorMessage}\`\`\``);

  if (req.stackTrace) {
    let tb = req.stackTrace;
    if (tb.length > 600) tb = tb.slice(-600);
    lines.push(`• *スタックトレース*:\n\`\`\`${tb}\`\`\``);
  }

  return lines.join("\n");
}

/**
 * 2. INFO 通知メッセージ整形
 * ℹ️ [Notify [context]]
 */
export function formatInfoMessage(req: SendInfoAlertRequest): string {
  const nowJst = getJstNowString();
  const ctxStr = req.context ? ` [${req.context}]` : "";
  const bodyText = req.message || (req as unknown as { text?: string }).text || "";
  const lines: string[] = [
    `[${nowJst}]`,
    `ℹ️ *[Notify${ctxStr}]*`,
    ...buildTimestampLines(req.apiTimestamp),
  ];
  if (bodyText) {
    lines.push(bodyText);
  }
  return lines.join("\n");
}

/**
 * 3. ORDER_OPEN 通知メッセージ整形
 * 🟢 BUY (LONG) / 🔴 SELL (SHORT)
 */
export function formatOrderOpenMessage(req: SendOrderOpenAlertRequest): string {
  const nowJst = getJstNowString();
  const isDca = req.signalType.toUpperCase().includes("DCA");
  const isLong = req.action === "LONG";
  const sideLabel = isLong ? "BUY (LONG)" : "SELL (SHORT)";
  const actionEmoji = isLong ? "🟢" : "🔴";
  const orderTypeLabel = `${req.signalType} (${
    isDca ? "ナンピン増玉" : "新規建て"
  })`;

  let p0Text = "";
  if (isDca && req.priceChangeFromP0Pct !== undefined) {
    const sign = req.priceChangeFromP0Pct >= 0 ? "+" : "";
    p0Text = ` (${sign}${req.priceChangeFromP0Pct.toFixed(2)}% vs P0)`;
  }

  const lines: string[] = [
    `[${nowJst}]`,
    `${actionEmoji} *注文受付 (NEW): ${sideLabel}*`,
    `• *銘柄*: \`${req.coin}\``,
    `• *種別*: *${orderTypeLabel}*`,
    `• *発注価格*: \`$${formatNumber(req.markPrice, 4)}\`${p0Text}`,
    `• *発注額*: \`$${
      formatNumber(req.notionalUsd, 2)
    }\` (${req.targetSize} ${req.coin})`,
    `• *トリガー根拠*: ${req.triggerReason || "シグナル判定"}`,
    ...buildTimestampLines(req.apiTimestamp, "シグナル検出時刻"),
  ];

  return lines.join("\n");
}

/**
 * 4. ORDER_CANCELED 通知メッセージ整形
 * 🚫 注文キャンセル (CANCELED)
 */
export function formatOrderCanceledMessage(
  req: SendOrderCanceledAlertRequest,
): string {
  const nowJst = getJstNowString();
  const lines: string[] = [
    `[${nowJst}]`,
    `🚫 *注文キャンセル (CANCELED)*`,
    `• *銘柄*: \`${req.coin}\``,
    `• *種別*: *${req.signalType}*`,
    `• *注文ID (CLOID)*: \`${req.cloid}\``,
    `• *理由*: ${req.reason}`,
    ...buildTimestampLines(req.apiTimestamp),
  ];
  return lines.join("\n");
}

/**
 * 5. CLOSE_POSITION 通知メッセージ整形
 * 🎉 💰 利確・決済完了 / ⚠️ 🔻 損切り・決済完了
 */
export function formatClosePositionMessage(
  req: SendClosePositionAlertRequest,
): string {
  const nowJst = getJstNowString();
  const isLong = req.side === "LONG";
  const isProfit = req.pnlUsd >= 0;
  const pnlEmoji = isProfit ? "🎉 💰" : "⚠️ 🔻";
  const sideLabel = isLong ? "LONG決済" : "SHORT決済";

  const pnlSign = req.pnlUsd > 0 ? "+" : "";
  const profitPctSign = req.profitPct > 0 ? "+" : "";

  let reason = req.reason || (isProfit ? "利確ターゲット到達" : "損切り決済");

  const isPositionSyncReason = reason.includes("POSITION_CLOSED_PROFIT") ||
    reason.includes("POSITION_CLOSED_LOSS");

  if (isPositionSyncReason && !reason.includes("ポジション同期で、")) {
    reason = `ポジション同期で、${reason}`;
  }

  const titleAction = isProfit ? "利確・決済完了" : "損切り・決済完了";
  const headerText = isPositionSyncReason || reason.includes("ポジション同期")
    ? `${pnlEmoji} *ポジション同期で${titleAction} (TP): ${sideLabel}*`
    : `${pnlEmoji} *${titleAction} (TP): ${sideLabel}*`;

  const lines: string[] = [
    `[${nowJst}]`,
    headerText,
    `• *銘柄*: \`${req.coin}\``,
    `• *決済数量*: \`$${formatNumber(req.size * req.exitPrice, 0)}\``,
    `• *平均建値*: \`$${formatNumber(req.avgEntryPrice, 4)}\``,
    `• *決済価格*: \`$${formatNumber(req.exitPrice, 4)}\``,
    `• *獲得利益率*: *${profitPctSign}${req.profitPct.toFixed(2)}%*`,
    `• *確定損益*: *${pnlSign}$${formatNumber(req.pnlUsd, 2)}*`,
    `• *決済理由*: ${reason}`,
    ...buildTimestampLines(req.apiTimestamp),
  ];

  return lines.join("\n");
}

/**
 * 6. FILL (約定イベント) 通知メッセージ整形
 */
export function formatFillEventMessage(req: SendFillEventAlertRequest): string {
  const nowJst = getJstNowString();
  const rawSide = String(req?.side || "BUY").trim().toUpperCase();
  const isBuy = rawSide === "B" || rawSide === "BUY";
  const sideStr = isBuy ? "BUY (LONG)" : "SELL (SHORT)";
  const px = Number(req?.px || 0);
  const sz = Number(req?.sz || 0);
  const notional = req?.notionalUsd ?? px * sz;
  const dirLabel = req?.dir ? ` (${req.dir})` : "";
  const cloidText = req?.cloid ? `• *注文ID (CLOID)*: \`${req.cloid}\`` : "";
  const tidText = req?.tid ? `• *約定ID*: \`${req.tid}\`` : "";
  const coin = req?.coin || "UNKNOWN";

  const isClose = (req?.dir && req.dir.includes("Close")) ||
    req?.closedPnl !== undefined;

  if (isClose) {
    const closedPnl = req?.closedPnl ?? 0;
    const isProfit = closedPnl >= 0;
    const pnlEmoji = isProfit ? "🎉 💰" : "⚠️ 🔻";
    const pnlSign = closedPnl > 0 ? "+" : "";

    const lines = [
      `[${nowJst}]`,
      `${pnlEmoji} *リアルタイム約定 (ポジション決済)*`,
      `• *銘柄*: \`${coin}\`${dirLabel}`,
      `• *売買*: *${sideStr}*`,
      `• *約定価格*: \`$${formatNumber(px, 4)}\``,
      `• *約定代金*: \`$${formatNumber(notional, 2)}\` (${sz} ${coin})`,
      `• *確定損益*: *${pnlSign}$${formatNumber(closedPnl, 2)}*`,
      req?.fee !== undefined
        ? `• *手数料*: \`$${formatNumber(req.fee, 4)}\``
        : "",
      tidText,
      cloidText,
      ...buildTimestampLines(req.apiTimestamp),
    ];

    return lines.filter(Boolean).join("\n");
  }

  const actionEmoji = isBuy ? "🟢" : "🔴";
  const lines = [
    `[${nowJst}]`,
    `${actionEmoji} *全量約定 (OPEN)*`,
    `• *銘柄*: \`${coin}\`${dirLabel}`,
    `• *売買*: *${sideStr}*`,
    `• *約定価格*: \`$${formatNumber(px, 4)}\``,
    `• *約定代金*: \`$${formatNumber(notional, 2)}\` (${sz} ${coin})`,
    req?.fee !== undefined
      ? `• *手数料*: \`$${formatNumber(req.fee, 4)}\``
      : "",
    tidText,
    cloidText,
    ...buildTimestampLines(req.apiTimestamp),
  ];

  return lines.filter(Boolean).join("\n");
}
