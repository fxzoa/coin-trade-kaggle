/**
 * dca-deno: Bot Service Main Entrypoint
 * Standalone daemon process responsible for WebSocket real-time market monitoring,
 * periodic interval evaluation, and DCA order execution.
 */

import "@std/dotenv/load";
import { APP_NAME, loadDcaConfig } from "../shared/constants.ts";
import { logger } from "../shared/logger.ts";
import { DcaKvStore } from "../shared/helpers/kv_store.ts";
import { HyperliquidClient } from "./adapters/hyperliquid_client.ts";
import { RedisSubscriberClient } from "../shared/helpers/redis_subscriber.ts";
import { SlackNotifier } from "./adapters/slack_notifier.ts";
import { KlineService } from "./services/kline_service.ts";
import { DcaScannerService } from "./services/dca_scanner_service.ts";
import { toError } from "../shared/errors.ts";
import { OrderPublisher } from "../../shared/order_pubsub/order_publisher.ts";

async function main(): Promise<void> {
  const config = loadDcaConfig();
  const walletAddress = Deno.env.get("HY_WALLET_ADDRESS");

  logger.info("========================================================");
  logger.info(`   ${APP_NAME} [Bot Service] - Starting`);
  logger.info(`• 監視対象通貨: ${config.targetCoins.join(", ")}`);
  logger.info(
    `• 発注方式: Redis トピック経由 (coin-trade-bot が発注) / 自動発注依頼 (AUTO_ORDER_ENABLED): ${config.autoOrderEnabled ? "有効 (ON)" : "無効 (OFF)"}`,
  );
  logger.info(`• 1回あたり発注額: ${config.defaultOrderSizeUsd} USD`);
  logger.info(`• 定期スキャン周期: ${config.scanIntervalSec} 秒`);
  logger.info("========================================================");

  // 1. Initialize KV Database
  const store = new DcaKvStore();
  await store.init();

  // 2. Initialize clients and services
  const client = new HyperliquidClient(config.apiUrl, walletAddress);
  const notifier = new SlackNotifier(undefined, "BTC DCA Trader");
  store.setNotifier(notifier);
  const klineService = new KlineService(store, client);

  // 3. Build initial 4H KLINE cache
  for (const coin of config.targetCoins) {
    try {
      await klineService.initCurrencyCache(coin);
    } catch (err: unknown) {
      logger.error(`[Bot] ${coin} 初期キャッシュ構築失敗:`, toError(err));
    }
  }

  // 4. Initialize Redis Subscriber client
  let scanner: DcaScannerService;
  const subscriber = new RedisSubscriberClient({
    targetCoins: config.targetCoins,
    walletAddress,
    store,
    onCandle: async (rawCandle) => {
      try {
        const res = await klineService.handleWsCandle(rawCandle);
        if (res.isNewClosed && scanner) {
          logger.info(`[Bot] 🔔 4H確定 -> 即時スキャン実行`);
          await scanner.runScan();
        }
      } catch (err: unknown) {
        logger.error("[Bot] ❌ candle処理エラー:", toError(err));
      }
    },
    onPriceUpdate: (coin, price) => {
      const { updated } = klineService.updateWithRealtimePrice(coin, price);
      if (updated && scanner) {
        logger.info(`[Bot] ⚡ ブレイク即時スキャン: ${coin} ($${price})`);
        scanner.runScan().catch((err: unknown) => {
          logger.error("[Bot] ❌ ブレイク即時スキャンエラー:", toError(err));
        });
      }
    },
    onOrderUpdate: (order) => {
      logger.info(`[Bot] 📝 注文更新: ${order.coin} ${order.side} [${order.status}]`);
    },
    onFill: async (fill) => {
      logger.info(`[Bot] 🎉 約定: ${fill.coin} ${fill.side} $${fill.price} (${fill.size})`);
      await notifier.notifyFill(fill);
    },
  });

  await subscriber.start();

  // 5. Initialize Scanner Service & execute initial scan
  const publisher = OrderPublisher.fromEnv('btc-dca-bot', { error: (m, e) => logger.error(m, toError(e)), warn: (m, e) => logger.warn(m, toError(e)) });
  await publisher.subscribeResults((r) => {
    if (r.status === 'resting' || r.status === 'filled') {
      logger.info(`[Bot] ✅ coin-trade-bot 発注結果: ${r.coin} ${r.side} [${r.status}] OID=${r.oid}`);
      return;
    }
    logger.warn(`[Bot] ⚠️ coin-trade-bot 発注結果: ${r.coin} ${r.side} [${r.status}] ${r.error ?? ''}`);
    if (r.error?.toLowerCase().includes('insufficient margin')) {
      // deno-lint-ignore no-explicit-any
      (subscriber as any).setInsufficientCooldown(r.error).catch(() => {});
    }
  });

  scanner = new DcaScannerService(store, client, subscriber as any, klineService, notifier, config, publisher);
  scanner.runScan().catch((err: unknown) => {
    logger.error("[Worker] 初回スキャンエラー:", toError(err));
  });

  logger.info(
    "✓ Worker daemon is actively monitoring (完全イベント駆動). Press Ctrl+C to terminate.",
  );

  // 6. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info(`[Worker] Received ${signal}. Shutting down worker gracefully...`);
    await subscriber.stop();
    await publisher.close();
    await store.close();
    logger.info("[Worker] Worker shutdown complete.");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  installSlackErrorReporter("btc-dca-trader-worker");
  main().catch(async (err: unknown) => {
    logger.warn("Fatal error during worker startup:", toError(err));
    await reportSlackError(err, "worker startup");
    Deno.exit(1);
  });
}
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
