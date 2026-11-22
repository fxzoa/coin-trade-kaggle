/**
 * dca-deno: DCA スキャン & シグナル判定 & 自動発注オーケストレーター
 * - リアルタイム価格 & メモリ内 MIN/MAX 統計からシグナル判定
 * - 重複除外チェック
 * - AUTO_ORDER_ENABLED 時の Hyperliquid 取引所への即時自動発注 (EIP-712 署名)
 * - 注文・約定記録の永続化 & Slack 通知
 */

import { logger } from '../../shared/logger.ts';
import type { DcaKvStore } from '../../shared/helpers/kv_store.ts';
import type { HyperliquidClient } from '../adapters/hyperliquid_client.ts';
import type { RedisSubscriberClient } from '../../shared/helpers/redis_subscriber.ts';
import type { OrderPublisher } from '../../../shared/order_pubsub/order_publisher.ts';
import type { SlackNotifier } from '../adapters/slack_notifier.ts';
import type { KlineService } from './kline_service.ts';
import type { DcaConfig, TradeSignal, OrderRecord } from '../../shared/types.ts';
import { evaluateDcaCandidates } from '../evaluators/dca_evaluator.ts';
import { roundPrice, roundSz, generateCloid } from '../../shared/helpers/order_helper.ts';
import { getJstIsoString } from '../../shared/helpers/time_helper.ts';
import { toError } from '../../shared/errors.ts';

export interface ScanResult {
  timestamp: string;
  evaluatedCoinsCount: number;
  detectedCount: number;
  skippedCount: number;
  insertedCount: number;
  executedOrderCount: number;
  signals: TradeSignal[];
  durationMs: number;
}

export class DcaScannerService {
  private readonly store: DcaKvStore;
  private readonly client: HyperliquidClient;
  private readonly wsClient: RedisSubscriberClient;
  private readonly klineService: KlineService;
  private readonly notifier: SlackNotifier;
  private readonly config: DcaConfig;
  private readonly publisher?: OrderPublisher;
  private isScanning = false;

  constructor(
    store: DcaKvStore,
    client: HyperliquidClient,
    wsClient: RedisSubscriberClient,
    klineService: KlineService,
    notifier: SlackNotifier,
    config: DcaConfig,
    publisher?: OrderPublisher
  ) {
    this.store = store;
    this.client = client;
    this.wsClient = wsClient;
    this.klineService = klineService;
    this.notifier = notifier;
    this.config = config;
    this.publisher = publisher;
  }

  async runScan(): Promise<ScanResult> {
    // 1. ボット有効フラグの確認
    const isBotEnabled = await this.store.isBotEnabled();
    if (!isBotEnabled) {
      logger.info('[DcaScannerService] ⏸️ BTC DCA Bot が OFF に設定されているためスキップ');
      return {
        timestamp: getJstIsoString(),
        evaluatedCoinsCount: 0,
        detectedCount: 0,
        skippedCount: 0,
        insertedCount: 0,
        executedOrderCount: 0,
        signals: [],
        durationMs: 0,
      };
    }

    // 2. 証拠金不足 (Insufficient margin) クールダウン中か確認
    if (this.wsClient && await this.wsClient.isInsufficientActive()) {
      logger.info('[DcaScannerService] ⏳ 証拠金不足クールダウン中 (1時間停止フラグ有効) のためスキップ');
      return {
        timestamp: getJstIsoString(),
        evaluatedCoinsCount: 0,
        detectedCount: 0,
        skippedCount: 0,
        insertedCount: 0,
        executedOrderCount: 0,
        signals: [],
        durationMs: 0,
      };
    }

    if (this.isScanning) {
      logger.warn('[DcaScannerService] ⚠️ 既にスキャン実行中のためスキップ');
      return {
        timestamp: getJstIsoString(),
        evaluatedCoinsCount: 0,
        detectedCount: 0,
        skippedCount: 0,
        insertedCount: 0,
        executedOrderCount: 0,
        signals: [],
        durationMs: 0,
      };
    }

    this.isScanning = true;
    const startTime = performance.now();
    logger.info(`[DcaScannerService] 🔍 スキャン開始: ${this.config.targetCoins.length}通貨 (自動発注: ${this.config.autoOrderEnabled ? 'ON' : 'OFF'})`);
    let detectedCount = 0;
    let skippedCount = 0;
    let insertedCount = 0;
    let executedOrderCount = 0;
    const newSignals: TradeSignal[] = [];

    try {
      // 1. 各対象通貨の最新価格を取得 (WS キャッシュ優先、フォールバックで REST)
      let mids: Record<string, number> = await this.client.getAllMids().catch(() => ({}));

      for (const coin of this.config.targetCoins) {
        const upper = coin.toUpperCase();
        let currentPx = this.wsClient.getPrice(upper);
        if (!currentPx || currentPx <= 0) {
          currentPx = mids[upper] || 0;
        }

        if (!currentPx || currentPx <= 0) {
          continue;
        }

        // 2. 期間統計 (メモリ内最新統計優先、フォールバックで KV)
        const stats = this.klineService.getLatestStats(upper) || (await this.store.getPriceStats(upper));
        if (!stats) {
          continue;
        }

        // 3. DCA 候補を評価
        const candidates = evaluateDcaCandidates(upper, currentPx, stats, this.config);

        for (const candidate of candidates) {
          detectedCount++;
          const signStr = candidate.changePct > 0 ? '+' : '';
          logger.info(
            `[DcaScannerService] 🎯 シグナル合致: ${upper} ${candidate.side} ${candidate.timeframe} (${signStr}${candidate.changePct.toFixed(1)}% / 閾値${candidate.thresholdPct}%)`
          );

          // 4. 重複防止チェック (過去 windowMs 内のシグナル または アクティブな NEW/OPEN 注文があるか)
          const isDuplicate = await this.store.hasRecentSignal(upper, candidate.side, candidate.windowMs);
          const hasActive = await this.store.hasActiveOrder(upper, candidate.side === 'LONG' ? 'BUY' : 'SELL');
          if (isDuplicate || hasActive) {
            skippedCount++;
            logger.info(`[DcaScannerService] ⏳ 重複スキップ (シグナル重複: ${isDuplicate}, アクティブ注文既存: ${hasActive}): ${upper} ${candidate.side} ${candidate.timeframe}`);
            continue;
          }

          // 5. 新規オーダー依頼を Redis トピックへ PUBLISH (発注は coin-trade-bot が実行)
          if (this.config.autoOrderEnabled && this.publisher) {
            try {
              logger.info(`[DcaScannerService] 📮 新規オーダー依頼を PUBLISH: ${upper} ${candidate.side} (指値=$${currentPx})`);
              const pub = await this.publishOrderRequest({
                coin: upper,
                isBuy: candidate.side === 'LONG',
                price: currentPx,
                signalId: candidate.signal.id,
                timeframe: candidate.timeframe,
              });
              if (pub.ok) {
                candidate.signal.status = 'EXECUTED';
                candidate.signal.executedAt = getJstIsoString();
                candidate.signal.cloid = pub.cloid;
                candidate.signal.unexecutedReason = undefined;
                executedOrderCount++;
              } else {
                candidate.signal.error = pub.error;
                candidate.signal.unexecutedReason = `発注依頼失敗: ${pub.error}`;
                logger.warn(`[DcaScannerService] ⚠️ 発注依頼失敗: ${upper} ${pub.error}`);
              }
            } catch (orderErr: unknown) {
              const error = toError(orderErr);
              candidate.signal.error = error.message;
              candidate.signal.unexecutedReason = `発注依頼エラー: ${error.message}`;
              logger.error(`[DcaScannerService] ❌ 発注依頼エラー: ${upper}`, error);
            }
          } else {
            candidate.signal.unexecutedReason = this.config.autoOrderEnabled
              ? '注文トピック発行機能が未初期化'
              : '自動発注OFF (手動待機)';
          }

          // 6. 新規シグナル登録 (発注結果ステータスを反映)
          await this.store.saveSignal(candidate.signal);
          insertedCount++;
          newSignals.push(candidate.signal);

          logger.info(`[DcaScannerService] 🚀 シグナル登録: ${upper} ${candidate.side} ${candidate.timeframe} [${candidate.signal.status}]`);

          // 7. Slack 通知
          await this.notifier.notifySignal(candidate.signal);
        }

      }

      const durationMs = Math.round(performance.now() - startTime);
      logger.info(
        `[DcaScannerService] 🏁 スキャン完了 (${durationMs}ms): 検知=${detectedCount}, 重複=${skippedCount}, 新規=${insertedCount}, 発注=${executedOrderCount}`
      );

      return {
        timestamp: getJstIsoString(),
        evaluatedCoinsCount: this.config.targetCoins.length,
        detectedCount,
        skippedCount,
        insertedCount,
        executedOrderCount,
        signals: newSignals,
        durationMs,
      };
    } catch (err: unknown) {
      const error = toError(err);
      logger.error('[DcaScannerService] スキャン例外:', error);
      await this.notifier.notifyError('runScan', error);
      throw error;
    } finally {
      this.isScanning = false;
    }
  }


  /**
   * 新規オーダー依頼 (BUYLIMIT/SELLLIMIT) を Redis トピックへ PUBLISH し、注文レコードを NEW で保存する。
   * 発注自体は coin-trade-bot が行う。購読者が 0 の場合は依頼が失われるため失敗として返す。
   */
  private async publishOrderRequest(p: {
    coin: string;
    isBuy: boolean;
    price: number;
    signalId: string;
    timeframe: string;
  }): Promise<{ ok: true; cloid: string; receivers: number } | { ok: false; error: string }> {
    if (!this.publisher) return { ok: false, error: '注文トピック発行機能が未初期化' };

    const { szDecimals } = await this.client.getAssetMeta(p.coin);
    const price = roundPrice(p.price);
    const sz = roundSz(this.config.defaultOrderSizeUsd / price, szDecimals);
    if (sz <= 0) return { ok: false, error: `数量が0になります (想定額=${this.config.defaultOrderSizeUsd}USD)` };

    const cloid = generateCloid();
    const side = p.isBuy ? 'BUY' : 'SELL';
    const notionalUsd = Math.round(price * sz * 100) / 100;
    const nowIso = getJstIsoString();

    const receivers = await this.publisher.publish({
      id: cloid,
      source: this.publisher.source,
      botId: this.publisher.botId,
      coin: p.coin,
      side,
      price,
      size: sz,
      notionalUsd,
      orderType: 'Alo',
      reduceOnly: false,
      cloid,
      signalId: p.signalId,
      timestamp: Date.now(),
    });
    if (receivers === 0) {
      return { ok: false, error: `トピック ${this.publisher.channel} の購読者がいません (coin-trade-bot 未起動?)` };
    }

    const orderRec: OrderRecord = {
      id: cloid,
      cloid,
      signalId: p.signalId,
      coin: p.coin,
      side,
      price,
      size: sz,
      notionalUsd,
      status: 'NEW', // 約定時に OPEN へ昇格 (約定は Redis fills 経由で検知)
      source: 'btc-dca-bot',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.store.saveOrder(orderRec);
    logger.info(`[DcaScannerService] 📮 発注依頼送信: ${p.coin} ${side} 価格=$${price} 数量=${sz} cloid=${cloid}`);

    try {
      await this.notifier.notifyNewOrder({ coin: p.coin, side, price, size: sz, notionalUsd, id: cloid, timeframe: p.timeframe });
    } catch (notifyErr: unknown) {
      logger.error('[DcaScannerService] notifyNewOrder 送信エラー:', toError(notifyErr));
    }
    return { ok: true, cloid, receivers };
  }

  /**
   * WebUI または 手動 API から特定シグナルを即時発注
   */
  async executeSignalManually(signalId: string): Promise<{ success: boolean; message: string; orderId?: number }> {
    const signalResult = await this.store.findSignal(signalId);
    let signal: TradeSignal | null = null;
    if (signalResult.ok) {
      signal = signalResult.value;
    } else {
      const signals: TradeSignal[] = await this.store.getRecentSignals(100);
      signal = signals.find((s: TradeSignal) => s.id === signalId) || null;
    }

    if (!signal) {
      return { success: false, message: `シグナルが見つかりません: ${signalId}` };
    }

    if (signal.status === 'EXECUTED') {
      return { success: false, message: '既に発注済みのシグナルです' };
    }

    if (!this.publisher) {
      return { success: false, message: '注文トピック発行機能が未初期化のため発注依頼できません' };
    }

    const upper = signal.coin.toUpperCase();
    let currentPx = this.wsClient.getPrice(upper);
    if (!currentPx || currentPx <= 0) {
      const mids: Record<string, number> = await this.client.getAllMids().catch(() => ({}));
      currentPx = mids[upper] || signal.currentPx;
    }

    try {
      const pub = await this.publishOrderRequest({
        coin: upper,
        isBuy: signal.side === 'LONG',
        price: currentPx,
        signalId: signal.id,
        timeframe: signal.timeframe,
      });
      if (pub.ok) {
        signal.status = 'EXECUTED';
        signal.executedAt = getJstIsoString();
        signal.cloid = pub.cloid;
        signal.error = undefined;
        signal.unexecutedReason = undefined;
        await this.store.saveSignal(signal);
        return { success: true, message: `発注依頼を送信しました (cloid ${pub.cloid}, 購読者${pub.receivers})` };
      }
      signal.error = pub.error;
      signal.unexecutedReason = `手動発注依頼失敗: ${pub.error}`;
      await this.store.saveSignal(signal);
      return { success: false, message: `発注依頼失敗: ${pub.error}` };
    } catch (err: unknown) {
      const error = toError(err);
      signal.error = error.message;
      signal.unexecutedReason = `手動発注依頼エラー: ${error.message}`;
      await this.store.saveSignal(signal);
      logger.error(`[DcaScannerService] ❌ 手動発注依頼例外: ${upper}`, error);
      return { success: false, message: `発注依頼エラー: ${error.message}` };
    }
  }
}
