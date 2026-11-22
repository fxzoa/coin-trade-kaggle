/**
 * hl-signal-evaluator-bot: 統合実行サービス (OpenOrderExecutor & ClosePositionEvaluator)
 */

import type { HyperliquidClient, MarketCloseOrderSpec } from "./hyperliquid_client.ts";
import type {
  SignalExecutionStore,
  StoredOrderRecord,
  StoredTpOrderRecord,
} from "./signal_execution_store.ts";
import { toError } from "./errors.ts";
import type { SlackNotifier } from "./slack_notifier.ts";

export interface IntegratedSignal {
  symbol: string;
  side: "LONG" | "SHORT";
  price: number;
  signalType: string;
  targetSizeUsd?: number;
}

export class SignalExecutionEngine {
  private isClosing = false;
  private inFlightCloses = new Set<string>();
  public slackNotifier?: SlackNotifier;

  constructor(
    private readonly client: HyperliquidClient,
    private readonly store: SignalExecutionStore,
    private readonly defaultOrderSizeUsd = 100,
    private readonly takeProfitGainPct = 6.18,
    private readonly slippage = 0.005,
    private readonly orderTif: "Gtc" | "Ioc" | "Alo" = "Alo",
    slackNotifier?: SlackNotifier,
  ) {
    this.slackNotifier = slackNotifier;
  }

  /**
   * 1. OPEN 処理: シグナル検知時に即時発注
   */
  async handleSignal(signal: IntegratedSignal): Promise<void> {
    const symbol = signal.symbol.toUpperCase();
    const isBuy = signal.side === "LONG";
    const targetUsd = signal.targetSizeUsd || this.defaultOrderSizeUsd;
    const price = signal.price;

    if (price <= 0) return;

    // 二重発注防止: 既に NEW または OPEN の注文が存在する場合はスキップ
    const hasActive = await this.store.hasActiveOrder(symbol, signal.side);
    if (hasActive) {
      console.info(
        `[ExecutionEngine] ⏳ 二重発注スキップ: ${symbol} ${signal.side} (アクティブ注文既存)`,
      );
      return;
    }

    // 証拠金不足クールダウン中か確認
    if (await this.store.isInsufficientActive()) {
      console.warn(`[ExecutionEngine] ⏳ 証拠金不足クールダウン中のため注文スキップ: ${symbol}`);
      return;
    }

    if (!this.client.canSign) {
      return;
    }

    const sz = targetUsd / price;
    const cloid = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");

    console.info(
      `[ExecutionEngine] 🚀 新規発注送信: ${symbol} ${signal.side} 数量=${sz} @ $${price}`,
    );

    const res = await this.client.placeOrder({
      coin: symbol,
      isBuy,
      sz,
      limitPrice: price,
      orderType: { limit: { tif: this.orderTif } },
      cloid,
    });

    const now = Date.now();
    const record: StoredOrderRecord = {
      id: cloid,
      orderId: res.orderId,
      cloid,
      symbol,
      side: signal.side,
      price,
      sz,
      filledSz: res.filledSz || 0,
      avgPx: res.avgPx || 0,
      targetSizeUsd: targetUsd,
      status: "NEW", // 新規登録時はステータスを NEW にする (約定イベントで OPEN)
      signalType: signal.signalType,
      error: res.error,
      timestamp: now,
      source: 'surge-dip-bot', // 自身が発注した注文
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    await this.store.saveOrder(record);

    if (record.status === "NEW" && this.slackNotifier) {
      await this.slackNotifier.notifyNewOrder({
        coin: symbol,
        side: isBuy ? "BUY" : "SELL",
        price,
        size: sz,
        notionalUsd: targetUsd,
        orderType: this.orderTif,
        id: cloid,
      }).catch((err) => console.warn(`[ExecutionEngine] Slack notifyNewOrder error:`, err));
    }

    if (res.success) {
      console.info(
        `✅ [ExecutionEngine] 発注成功: ${symbol} [OID: ${res.orderId || "N/A"}] (status: NEW)`,
      );
    } else {
      console.error(`❌ [ExecutionEngine] 発注拒否: ${symbol} エラー: ${res.error}`);
      if (res.error?.toLowerCase().includes("insufficient margin")) {
        await this.store.setInsufficientCooldown(`残高不足 (${symbol})`);
      }
    }
  }

  /**
   * 2. CLOSE 処理: リアルタイム価格受信時に利確判定・決済実行
   */
  async handlePrices(prices: Record<string, number>): Promise<void> {
    if (this.isClosing || !this.client.canSign) return;

    // 全期間共通クールダウン (最低24H以上) 判定
    if (await this.store.isGlobalTpCooldownActive()) {
      return;
    }

    this.isClosing = true;
    try {
      // ユーザーの保有ポジションを取得
      const userState = await this.client.getUserState();
      const positions = userState.positions;
      if (!positions || positions.length === 0) return;

      const candidates: Array<{
        coin: string;
        side: "LONG" | "SHORT";
        size: number;
        entryPx: number;
        markPrice: number;
        profitPct: number;
      }> = [];

      for (const p of positions) {
        const coin = p.coin?.toUpperCase();
        if (!coin || this.inFlightCloses.has(coin)) continue;
        const szi = Number(p.szi || "0");
        const entryPx = Number(p.entryPx || "0");
        const markPrice = prices[coin];

        if (szi === 0 || entryPx <= 0 || !markPrice || markPrice <= 0) continue;

        const isLong = szi > 0;
        const size = Math.abs(szi);
        const profitPct = isLong
          ? ((markPrice - entryPx) / entryPx) * 100
          : ((entryPx - markPrice) / entryPx) * 100;

        if (profitPct >= this.takeProfitGainPct) {
          candidates.push({
            coin,
            side: isLong ? "LONG" : "SHORT",
            size,
            entryPx,
            markPrice,
            profitPct,
          });
        }
      }

      if (candidates.length === 0) return;

      const specs: MarketCloseOrderSpec[] = [];
      for (const cand of candidates) {
        this.inFlightCloses.add(cand.coin);
        specs.push({
          coin: cand.coin,
          isBuy: cand.side === "SHORT",
          sz: cand.size,
          expectedPrice: cand.markPrice,
          slippage: this.slippage,
        });
      }

      console.info(
        `[ExecutionEngine] 🎯 利確対象検知 (${specs.length}件): ` +
          candidates.map((c) =>
            `${c.coin} ${c.side} (+${c.profitPct.toFixed(2)}% >= ${this.takeProfitGainPct}%)`
          ).join(", "),
      );

      const orderResults = await this.client.closePositionsBatch(specs);

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const res = orderResults[i];
        if (res && res.success) {
          const filledSize = res.filledSz && res.filledSz > 0 ? res.filledSz : cand.size;
          const exitPrice = res.avgPx && res.avgPx > 0 ? res.avgPx : cand.markPrice;
          const notionalUsd = Math.round(filledSize * exitPrice * 100) / 100;

          // 24H クールダウンを設定
          await this.store.setGlobalTpCooldown(24 * 60 * 60 * 1000);

          // TP注文レコード保存
          const tpRecordId = `tp_${cand.coin}_${Date.now()}`;
          const tpRecord: StoredTpOrderRecord = {
            id: tpRecordId,
            cloid: tpRecordId,
            symbol: cand.coin,
            timeframe: "PROFIT_PCT",
            profitPct: cand.profitPct,
            threshold: this.takeProfitGainPct,
            price: exitPrice,
            size: filledSize,
            notionalUsd,
            status: "FILLED",
            source: 'surge-dip-bot', // 自身が発注した注文
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await this.store.saveTpOrder(tpRecord);

          // 決済数量分、OPEN建玉を低建値優先で CLOSED に更新 (TP注文記録 & Slack通知連動)
          const closeResult = await this.store.recordTpOrderFilled(tpRecord);
          console.info(
            `✅ [ExecutionEngine] 利確決済完了: ${cand.coin} [OID: ${res.oid}] 約定=${filledSize}, ${closeResult.closedCount}件のOPEN建玉をCLOSEDに更新`,
          );
        } else {
          console.error(`❌ [ExecutionEngine] 利確決済失敗: ${cand.coin} エラー: ${res?.error}`);
        }

        setTimeout(() => {
          this.inFlightCloses.delete(cand.coin);
        }, 3000);
      }
    } catch (e) {
      console.error("[ExecutionEngine] 利確評価処理エラー:", toError(e).message);
    } finally {
      this.isClosing = false;
    }
  }
}
