import { loadConfig } from "./config.ts";
import { HlWsClient } from "./hl_ws_client.ts";
import { loadTargetCoins } from "./kv_symbols.ts";
import { FillsStore } from "../shared/price_monitor/kv_store.ts";
import { isOutcomeSymbol, parseAllMidsResult } from "./parser.ts";
import { RedisSyncer } from "./redis_syncer.ts";
import { OrderSlackNotifier } from "./services/order_slack_notifier.ts";
import { toError } from "../shared/price_monitor/errors.ts";
import type {
  HlBasicOrder,
  HlOrderUpdate,
  HlPosition,
  HlUserFill,
  WsSubscription,
} from "../shared/price_monitor/types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function main() {
  const config = loadConfig();

  // 対象銘柄の特定:
  // HL_TARGET_COINS が明示的に指定されている場合はそれを使用し、
  // 未指定の場合は固定178銘柄を読み込み、Redis (hl:target_coins) へ同期する
  let targetCoins = config.targetCoins;
  if (!targetCoins) {
    targetCoins = await loadTargetCoins({
      infoUrl: config.infoUrl,
      redisUrl: config.redisUrl,
      redisKeyPrefix: config.redisKeyPrefix,
    });
    console.log(
      `[Target Coins] ${targetCoins.size} fixed coins loaded and synced to Redis.`,
    );
  }

  console.log("=============================================");
  console.log("  Hyperliquid Realtime Redis Syncer Starting");
  console.log("=============================================");
  console.log(`HL WS URL        : ${config.wsUrl}`);
  console.log(`Redis URL        : ${config.redisUrl}`);
  console.log(`Redis Key Prefix : ${config.redisKeyPrefix}`);
  if (config.userAddress) {
    console.log(`User Address     : ${config.userAddress}`);
  } else {
    console.log("User Address     : Not specified (Order/Position tracking disabled)");
  }
  if (targetCoins) {
    console.log(`Target Coins     : ${targetCoins.size} coins configured`);
  } else {
    console.log("Target Coins     : ALL");
  }

  const redisSyncer = new RedisSyncer({
    redisUrl: config.redisUrl,
    prefix: config.redisKeyPrefix,
    onLog: (msg) => console.log(msg),
    onError: (err: unknown) => console.error(toError(err)),
  });

  const recordBotError = (err: unknown, context: string) => {
    const error = toError(err);
    console.error(`[${context}]`, error);
    redisSyncer.recordError(error, context).catch(() => {});
  };

  // Slack order notifier (orderUpdates / userFills → channel routing)
  const orderSlackNotifier = new OrderSlackNotifier({
    redisUrl: config.redisUrl,
    queueKey: config.slackQueueKey,
    channels: config.slackChannels,
    onLog: (msg) => console.log(msg),
  });

  const fillsStore = new FillsStore({
    redisClient: redisSyncer.getClient(),
    prefix: config.redisKeyPrefix,
  });
  await fillsStore.init();

  // 対象外の古い価格データをクリーンアップ
  if (targetCoins && targetCoins.size > 0) {
    const removedCount = await redisSyncer.cleanStalePrices(targetCoins);
    if (removedCount > 0) {
      console.log(`[Redis] Cleaned up ${removedCount} stale coin prices.`);
    }
  }

  const subscriptions: WsSubscription[] = [
    { type: "allMids" },
  ];

  if (config.userAddress) {
    subscriptions.push({ type: "orderUpdates", user: config.userAddress });
    subscriptions.push({ type: "userFills", user: config.userAddress });
    subscriptions.push({ type: "webData2", user: config.userAddress });
  }

  const handleMessage = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isRecord(parsed)) return;

    const channel = parsed.channel;

    // 1. 価格変動 (allMids)
    if (channel === "allMids") {
      const midsResult = parseAllMidsResult(raw);
      if (!midsResult.ok) return;

      const allTicks = midsResult.value;
      const filteredTicks = allTicks.filter((tick) => {
        if (!config.includeOutcomes && isOutcomeSymbol(tick.symbol)) return false;
        if (targetCoins && !targetCoins.has(tick.symbol)) return false;
        return true;
      });

      if (filteredTicks.length > 0) {
        redisSyncer.savePrices(filteredTicks).catch((err: unknown) => {
          recordBotError(err, "savePrices");
        });
      }
      return;
    }

    // 2. 注文更新 (orderUpdates)
    if (channel === "orderUpdates" && config.userAddress) {
      const data = parsed.data;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (isRecord(item) && isRecord(item.order)) {
            const update = item as unknown as HlOrderUpdate;
            // 1. Deno KV (SQLite) へ永続化保存
            fillsStore.saveOrderUpdate(config.userAddress, update).catch((err: unknown) => {
              recordBotError(err, "saveOrderUpdate (Deno KV)");
            });
            // 2. Redis へアクティブ注文キャッシュ & Pub/Sub 配信
            redisSyncer.saveOrderUpdate(config.userAddress, update).catch((err: unknown) => {
              recordBotError(err, "saveOrderUpdate (Redis)");
            });
            // 3. Slack チャンネルへ通知（status 別振り分け）
            orderSlackNotifier.notifyOrderUpdate(update).catch((err: unknown) => {
              recordBotError(err, "notifyOrderUpdate (Slack)");
            });
          }
        }
      }
      return;
    }

    // 2.1 約定更新 (userFills)
    if (channel === "userFills" && config.userAddress) {
      const data = parsed.data;
      if (isRecord(data) && Array.isArray(data.fills)) {
        const fills = data.fills as HlUserFill[];
        // 1. Deno KV (およびRedis) へ保存
        fillsStore.saveUserFills(config.userAddress, fills).catch((err: unknown) => {
          recordBotError(err, "saveUserFills");
        });
        // 2. 他Bot向けに Redis Pub/Sub 配信
        redisSyncer.publishUserFills(config.userAddress, fills).catch((err: unknown) => {
          recordBotError(err, "publishUserFills");
        });
        // 3. Slack チャンネルへ通知（closedPnl 正負でチャンネル振り分け）
        for (const fill of fills) {
          orderSlackNotifier.notifyUserFill(fill).catch((err: unknown) => {
            recordBotError(err, "notifyUserFill (Slack)");
          });
        }
      }
      return;
    }

    // 3. アカウント状態 & ポジション同期 (webData2)
    if (channel === "webData2" && config.userAddress) {
      const data = parsed.data;
      if (isRecord(data) && isRecord(data.clearinghouseState)) {
        const state = data.clearinghouseState as Record<string, unknown>;
        if (Array.isArray(state.assetPositions)) {
          const positions: HlPosition[] = [];
          for (const posItem of state.assetPositions) {
            if (isRecord(posItem) && isRecord(posItem.position)) {
              positions.push(posItem.position as unknown as HlPosition);
            }
          }
          redisSyncer.savePositions(config.userAddress, positions).catch((err: unknown) => {
            recordBotError(err, "savePositions");
          });
        }
      }

      // オープン注文一覧の同期 (webData2 内の openOrders)
      if (isRecord(data) && Array.isArray(data.openOrders)) {
        const openOrders = data.openOrders as HlBasicOrder[];
        redisSyncer.syncOpenOrders(config.userAddress, openOrders).catch((err: unknown) => {
          recordBotError(err, "syncOpenOrders");
        });
      }
      return;
    }
  };

  const wsClient = new HlWsClient({
    url: config.wsUrl,
    subscriptions,
    onMessage: handleMessage,
    onLog: (msg) => console.log(msg),
  });

  // 終了シグナルハンドリング
  const shutdown = async () => {
    console.log("\nShutting down gracefully...");
    try {
      wsClient.close();
      await fillsStore.close();
      await redisSyncer.close();
      await orderSlackNotifier.close();
    } catch (e: unknown) {
      console.error("[Shutdown] Error during shutdown:", toError(e));
    } finally {
      Deno.exit(0);
    }
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  wsClient.connect();
}

if (import.meta.main) {
  installSlackErrorReporter("price-change-monitor-syncer");
  try {
    await main();
  } catch (error) {
    await reportSlackError(error, "syncer startup");
    throw error;
  }
}
import { installSlackErrorReporter, reportSlackError } from "../shared/price_monitor/slack_error_reporter.ts";
