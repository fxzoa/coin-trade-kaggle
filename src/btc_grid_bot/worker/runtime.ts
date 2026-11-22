/**
 * btc-grid-deno: ワーカーランタイム (統合起動 / ワーカー単体起動で共通)
 * KV 初期化・WebSocket 監視・グリッドボットの定期実行をまとめて起動する
 */

import { loadGridConfig } from '../shared/constants.ts';
import { logger } from '../shared/logger.ts';
import { AppKvStore } from '../shared/helpers/kv_store.ts';
import { HyperliquidClient } from '../shared/helpers/hyperliquid_client.ts';
import { RedisSubscriberClient } from '../shared/helpers/redis_subscriber.ts';
import { TraceLogger } from '../shared/helpers/trace_logger.ts';
import type { GridConfig } from '../shared/types.ts';
import { SlackNotifier } from './adapters/slack_notifier.ts';
import { GridBotService } from './services/grid_bot_service.ts';
import { toError } from '../shared/errors.ts';
import { OrderPublisher } from '../../shared/order_pubsub/order_publisher.ts';

/** 起動直後の初回チェックまでの待機時間 (ms) */
const INITIAL_CHECK_DELAY_MS = 3000;

/** 起動済みワーカーの操作ハンドル */
export interface WorkerRuntime {
  /** 定期スキャンと WebSocket 監視を停止する (KV ストアは閉じない) */
  stop(): void;
}

/**
 * 設定を読み込み、KV ストアを初期化してボット設定を永続化する (WebUI から参照可能にするため)
 */
export async function initConfigAndStore(): Promise<{ config: GridConfig; store: AppKvStore }> {
  const config = loadGridConfig();
  const store = new AppKvStore();
  await store.init();
  await store.saveBotConfig(config);
  return { config, store };
}

/**
 * WebSocket 監視を開始し、認証情報があればグリッドボットの初回実行と定期スキャンを登録する
 * 認証情報が無い場合は参照専用となり、定期スキャンは警告ログのみ出力する
 */
export function startWorkerRuntime(params: {
  config: GridConfig;
  store: AppKvStore;
  walletAddress?: string;
  notifier?: SlackNotifier;
}): WorkerRuntime {
  const { config, store, walletAddress } = params;
  const notifier = params.notifier ?? new SlackNotifier();
  store.setNotifier(notifier);
  const traceLogger = new TraceLogger();

  let botService: GridBotService | undefined;
  let subscriber: RedisSubscriberClient;

  // Redis リアルタイム監視クライアントの起動 (完全イベント駆動: 価格更新・約定連動)
  subscriber = new RedisSubscriberClient({
    coin: config.coin,
    walletAddress: walletAddress || undefined,
    store,
    onPriceUpdate: () => {
      if (botService) {
        botService.runCheck().catch((err: unknown) => logger.error('❌ 価格イベント時チェック例外:', toError(err)));
      }
    },
    onFill: () => {
      if (botService) {
        botService.runCheck().catch((err: unknown) => logger.error('❌ 約定イベント時チェック例外:', toError(err)));
      }
    },
    onNewOrder: async (order) => {
      const sent = await notifier.notifyNewOrder(order);
      if (!sent) {
        logger.warn(`[WorkerRuntime] NEW ORDER Slack通知を送信できませんでした: ${order.id}`);
      }
    },
  });
  subscriber.connect().catch((err: unknown) => {
    logger.error('Redis 接続開始エラー:', toError(err));
  });

  // 新規オーダーは Redis トピックへ PUBLISH し、coin-trade-bot が Hyperliquid へ発注する
  const publisher = OrderPublisher.fromEnv('btc-grid-bot', {
    error: (m, e) => logger.error(m, toError(e)),
    warn: (m, e) => logger.warn(m, toError(e)),
  });
  publisher.subscribeResults((r) => {
    if (r.status === 'resting' || r.status === 'filled') {
      logger.info(`✅ coin-trade-bot 発注結果: ${r.coin} ${r.side} [${r.status}] OID=${r.oid}`);
      return;
    }
    logger.warn(`⚠️ coin-trade-bot 発注結果: ${r.coin} ${r.side} [${r.status}] ${r.error ?? ''}`);
    if (r.error?.toLowerCase().includes('insufficient margin')) {
      subscriber.setInsufficientCooldown(r.error).catch(() => {});
    }
  }).catch((err: unknown) => logger.error('発注結果トピック購読エラー:', toError(err)));

  if (walletAddress) {
    const client = new HyperliquidClient(walletAddress, {
      apiUrl: config.apiUrl,
      coin: config.coin,
    });
    botService = new GridBotService(client, store, notifier, config, traceLogger, subscriber, publisher);
  }

  // 初回即時実行 (3秒ディレイ)
  if (botService) {
    setTimeout(() => {
      botService?.runCheck().catch((err: unknown) => logger.error('❌ 初回チェック例外:', toError(err)));
    }, INITIAL_CHECK_DELAY_MS);
  }

  return {
    stop() {
      subscriber.stop().catch((e: unknown) => logger.error('Redis 切断エラー:', toError(e)));
      publisher.close().catch((e: unknown) => logger.error('注文トピック切断エラー:', toError(e)));
    },
  };
}
