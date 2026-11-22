/**
 * btc-grid-deno: グリッドボット メインサービスクラス
 * 節目グリッド指値評価・発注およびTP判定・決済を統括
 */

import { HyperliquidClient, validateOrderPlacement, type GridBuyOrderSpec } from '../../shared/helpers/hyperliquid_client.ts';
import { AppKvStore } from '../../shared/helpers/kv_store.ts';
import { SlackNotifier } from '../adapters/slack_notifier.ts';
import { TraceLogger, generateTraceId, formatShortTraceId } from '../../shared/helpers/trace_logger.ts';
import { getJstIsoString } from '../../shared/helpers/time_helper.ts';
import { computeGridBuyLevel, evaluateGridDecision } from '../evaluators/grid_evaluator.ts';
import type { OrderPublisher } from '../../../shared/order_pubsub/order_publisher.ts';
import type { RedisSubscriberClient } from '../../shared/helpers/redis_subscriber.ts';
import type { GridConfig, GridCheckResult, GridOrderRecord, ActiveGridOrder } from '../../shared/types.ts';
import { logger } from '../../shared/logger.ts';
import { toError } from '../../shared/errors.ts';

/** 未約定注文取得失敗時の Slack 通知間隔 (連続失敗の回数単位。5分間隔なら約1時間) */
const OPEN_ORDERS_NOTIFY_INTERVAL = 12;

export class GridBotService {
  private readonly client: HyperliquidClient;
  private readonly store: AppKvStore;
  private readonly notifier: SlackNotifier;
  private readonly traceLogger: TraceLogger;
  private readonly config: GridConfig;
  private readonly subscriber?: RedisSubscriberClient;
  private readonly publisher?: OrderPublisher;
  /** 未約定注文の取得が連続で失敗した回数 (成功でリセット) */
  private openOrdersFailStreak = 0;

  constructor(
    client: HyperliquidClient,
    store: AppKvStore,
    notifier: SlackNotifier,
    config: GridConfig,
    traceLogger?: TraceLogger,
    subscriber?: RedisSubscriberClient,
    publisher?: OrderPublisher
  ) {
    this.client = client;
    this.store = store;
    this.notifier = notifier;
    this.config = config;
    this.traceLogger = traceLogger || new TraceLogger();
    this.subscriber = subscriber;
    this.publisher = publisher;
  }

  async runCheck(): Promise<GridCheckResult> {
    const traceId = generateTraceId();
    const startTime = performance.now();

    // 1. ボット有効フラグの確認
    const isBotEnabled = await this.store.isBotEnabled();
    if (!isBotEnabled) {
      logger.info(`[GridBotService] ⏸️ BTC Grid Bot が OFF に設定されているためスキップ`);
      return {
        traceId,
        timestamp: getJstIsoString(),
        durationMs: 0,
        markPrice: 0,
        gridAction: 'NONE',
        tpFiredTimeframes: [],
        tpClosedUsd: 0,
      };
    }

    // 2. 証拠金不足 (Insufficient margin) クールダウン中か確認
    if (this.subscriber && await this.subscriber.isInsufficientActive()) {
      logger.info(`[GridBotService] ⏳ 証拠金不足クールダウン中 (1時間停止フラグ有効) のためスキップ`);
      return {
        traceId,
        timestamp: getJstIsoString(),
        durationMs: 0,
        markPrice: 0,
        gridAction: 'NONE',
        tpFiredTimeframes: [],
        tpClosedUsd: 0,
      };
    }

    const lockTtlMs = this.config.lockTtlSec * 1000;
    const lockAcquired = await this.store.acquireLock('grid_run', lockTtlMs);
    if (!lockAcquired) {
      logger.info(`[GridBotService] [traceId=${formatShortTraceId(traceId, this.config.traceIdDisplayLength)}] スキップ: ロック取得競合`);
      return {
        traceId,
        timestamp: getJstIsoString(),
        durationMs: Math.round(performance.now() - startTime),
        markPrice: 0,
        gridAction: 'NONE',
        tpFiredTimeframes: [],
        tpClosedUsd: 0,
      };
    }

    try {
      return await this.executeCheck(traceId, startTime);
    } finally {
      await this.store.releaseLock('grid_run');
    }
  }

  private async executeCheck(traceId: string, startTime: number): Promise<GridCheckResult> {
    const shortId = formatShortTraceId(traceId, this.config.traceIdDisplayLength);
    logger.info(`[GridBotService] [traceId=${shortId}] 🔍 スキャン開始: ${this.config.coin}`);

    // 1. 市場データ・価格統計の取得
    let stats = await this.store.getCachedPriceStats(this.config.priceCacheTtlSec * 1000);
    if (!stats) {
      stats = await this.client.fetchPriceStats();
      if (stats) {
        await this.store.setCachedPriceStats(stats, this.config.priceCacheTtlSec * 2 * 1000);
      }
    }

    if (!stats || stats.markPrice <= 0) {
      const errMsg = '市場データ取得失敗 (markPrice<=0)';
      logger.error(`[GridBotService] [traceId=${shortId}] ❌ ${errMsg}`);
      await this.notifier.notifyError(`executeCheck:priceStats [traceId=${shortId}]`, errMsg);
      const failResult: GridCheckResult = {
        traceId,
        timestamp: getJstIsoString(),
        durationMs: Math.round(performance.now() - startTime),
        markPrice: 0,
        gridAction: 'SKIP',
        tpFiredTimeframes: [],
        tpClosedUsd: 0,
        error: errMsg,
      };
      await this.persistResult(failResult);
      return failResult;
    }

    // キャッシュは期間安値用に維持し、現在価格と24H変化率は毎スキャン最新値で上書きする (TP判定の遅延防止)
    const latest = await this.client.getMarkPriceAndChange();
    if (latest && latest.markPrice > 0) {
      stats = { ...stats, markPrice: latest.markPrice, change24h: latest.change24h };
    } else {
      logger.warn(`[GridBotService] [traceId=${shortId}] ⚠️ 最新の現在価格の取得に失敗したため、キャッシュ値で継続します`);
    }

    const markPx = stats.markPrice;
    await this.store.saveCurrentPrice(markPx, stats.change24h);
    logger.info(`[GridBotService] [traceId=${shortId}] 📊 現在価格: $${markPx.toLocaleString()} (24H: ${stats.change24h > 0 ? '+' : ''}${stats.change24h.toFixed(2)}%)`);

    // 最新ポジションを取得してKVへ保存
    const positions = await this.client.getUserPositionsState();
    await this.store.savePositions(positions);

    // 2. 節目グリッド判定 & 発注
    const gridResult = await this.runGridStep(markPx, traceId);


    const durationMs = Math.round(performance.now() - startTime);
    const result: GridCheckResult = {
      traceId,
      timestamp: getJstIsoString(),
      durationMs,
      markPrice: markPx,
      gridAction: gridResult.action,
      gridLevel: gridResult.level,
      placedOrderId: gridResult.placedOrderId,
      tpFiredTimeframes: [],
      tpClosedUsd: 0,
    };

    await this.persistResult(result);
    logger.info(`[GridBotService] [traceId=${shortId}] 🏁 スキャン完了 (${durationMs}ms): GridAction=${result.gridAction}`);
    return result;
  }

  /**
   * スキャン結果を最終実行結果・トレース履歴・トレースログへ保存する
   */
  private async persistResult(result: GridCheckResult): Promise<void> {
    await Promise.all([
      this.store.saveLastRun(result),
      this.store.saveTrace(result),
      this.traceLogger.append(result),
    ]);
  }

  /**
   * ログ用の traceId プレフィックスを生成する (traceId 未指定時は空文字)
   */
  private buildLogPrefix(traceId?: string): string {
    return traceId ? `[traceId=${formatShortTraceId(traceId, this.config.traceIdDisplayLength)}] ` : '';
  }

  /**
   * 節目グリッドBuyLimit判定・発注
   */
  private async runGridStep(markPx: number, traceId?: string): Promise<{ action: 'PLACE' | 'KEEP' | 'SKIP'; level?: number; placedOrderId?: string }> {
    const logPrefix = this.buildLogPrefix(traceId);
    // 現在の未約定オープン指値を取得
    // 取得失敗を「注文なし」と誤認して重複発注しないよう、失敗時はこのステップをスキップする
    let openOrders: ActiveGridOrder[];
    try {
      openOrders = await this.client.getUserOpenOrders();
    } catch (err: unknown) {
      const error = toError(err);
      const errMsg = `未約定注文の取得に失敗したため節目指値判定をスキップします: ${error.message}`;
      // ログは毎回出すが、Slack通知は連続失敗の初回と以降一定回数ごとに間引く
      this.openOrdersFailStreak++;
      logger.error(`[GridBotService] ${logPrefix}❌ ${errMsg} (連続失敗: ${this.openOrdersFailStreak}回)`);
      if ((this.openOrdersFailStreak - 1) % OPEN_ORDERS_NOTIFY_INTERVAL === 0) {
        await this.notifier.notifyError(`getUserOpenOrders ${logPrefix}`, `${errMsg} (連続失敗: ${this.openOrdersFailStreak}回)`);
      }
      return { action: 'SKIP' };
    }
    this.openOrdersFailStreak = 0;
    await this.store.saveActiveOrders(openOrders);
    // 1. 取引所上の未約定オープン指値レベル
    const activeLevels = openOrders.map((o) => o.limitPrice);

    // 2. Deno KV 側の登録済みオーダーも照会し、すでに同一レベルで未処理(NEW)またはOPENの注文が存在する場合はSKIP
    try {
      const storedOrders = await this.store.getGridOrders(50);
      for (const so of storedOrders) {
        if ((so.status === 'NEW' || so.status === 'OPEN') && so.level) {
          if (!activeLevels.includes(so.level)) {
            activeLevels.push(so.level);
          }
        }
      }
    } catch (err: unknown) {
      logger.warn(`[GridBotService] ${logPrefix}Deno KV 注文履歴照会警告 (処理は継続):`, toError(err));
    }

    const decisionResult = evaluateGridDecision(markPx, activeLevels, this.config.gridStepUsd, this.config.gridOffsetUsd);

    if (!decisionResult.ok) {
      logger.warn(`[GridBotService] ${logPrefix}⚠️ 節目指値スキップ: ${decisionResult.error.message}`);
      return { action: 'SKIP', level: computeGridBuyLevel(markPx, this.config.gridStepUsd, this.config.gridOffsetUsd) };
    }

    const decision = decisionResult.value;

    if (decision.action === 'KEEP') {
      logger.debug(`[GridBotService] ${logPrefix}維持 (既に同レベルのORDER登録あり): ${decision.reason}`);
      return { action: 'KEEP', level: decision.desiredLevel };
    }

    // PLACE: 新規節目指値を発注
    const validation = validateOrderPlacement({
      price: decision.desiredLevel,
      size: this.config.gridOrderSizeUsd,
    });
    if (!validation.ok) {
      logger.warn(`[GridBotService] ${logPrefix}⚠️ 発注パラメータ検証失敗: ${validation.error.message}`);
      return { action: 'SKIP', level: decision.desiredLevel };
    }

    if (!this.publisher) {
      logger.warn(`[GridBotService] ${logPrefix}⚠️ 注文トピック発行機能が未初期化のため節目指値依頼をスキップします`);
      return { action: 'SKIP', level: decision.desiredLevel };
    }

    logger.info(`[GridBotService] ${logPrefix}📮 節目指値依頼 (Redis PUBLISH): Level=$${decision.desiredLevel}, Size=$${this.config.gridOrderSizeUsd}`);
    const failPlace = async (reason: string): Promise<{ action: 'SKIP'; level: number }> => {
      const errMsg = `節目指値依頼失敗 (Level=$${decision.desiredLevel}): ${reason}`;
      logger.error(`[GridBotService] ${logPrefix}❌ ${errMsg}`);
      await this.notifier.notifyError(`publishGridBuyOrder ${logPrefix}`, errMsg);
      return { action: 'SKIP', level: decision.desiredLevel };
    };

    let spec: GridBuyOrderSpec;
    try {
      const prepared = await this.client.prepareGridBuyOrder(decision.desiredLevel, this.config.gridOrderSizeUsd);
      if (!prepared.ok) return await failPlace(prepared.errorMessage);
      spec = prepared.spec;

      const receivers = await this.publisher.publish({
        id: spec.cloid,
        source: this.publisher.source,
        botId: this.publisher.botId,
        coin: spec.coin,
        side: 'BUY',
        price: spec.limitPrice,
        size: spec.size,
        notionalUsd: spec.notionalUsd,
        orderType: 'Alo',
        reduceOnly: false,
        cloid: spec.cloid,
        timestamp: Date.now(),
      });
      if (receivers === 0) {
        return await failPlace(`トピック ${this.publisher.channel} の購読者がいません (coin-trade-bot 未起動?)`);
      }
    } catch (err: unknown) {
      return await failPlace(toError(err).message);
    }

    logger.info(`[GridBotService] ${logPrefix}✅ 節目指値依頼送信: Level=$${decision.desiredLevel}, Size=${spec.size} [cloid: ${spec.cloid}]`);
    await this.notifier.notifyGridPlaced(decision.desiredLevel, this.config.gridOrderSizeUsd, markPx);

    // grid_orders テーブルへ新規登録 (初期ステータス: NEW。約定は Redis fills 経由で検知)
    const gridRecord: GridOrderRecord = {
      id: spec.cloid,
      cloid: spec.cloid,
      coin: this.config.coin,
      level: decision.desiredLevel,
      price: spec.limitPrice,
      size: spec.size,
      notionalUsd: spec.notionalUsd,
      status: 'NEW',
      source: 'btc-grid-bot', // 自身が依頼した注文
      createdAt: getJstIsoString(),
      updatedAt: getJstIsoString(),
    };
    await this.store.saveGridOrder(gridRecord);

    return { action: 'PLACE', level: decision.desiredLevel, placedOrderId: spec.cloid };
  }
}
