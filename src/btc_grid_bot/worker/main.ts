/**
 * btc-grid-deno: Bot Service Main Entrypoint
 * Standalone daemon process running WebSocket real-time feeds,
 * grid order evaluation, and take-profit execution.
 */

import { logger } from "../shared/logger.ts";
import { loadEnvFile, registerShutdown } from "../shared/bootstrap.ts";
import { initConfigAndStore, startWorkerRuntime } from "./runtime.ts";
import { SlackNotifier } from "./adapters/slack_notifier.ts";
import { toError } from "../shared/errors.ts";

// .env ファイルが存在すればロード
await loadEnvFile();

async function main(): Promise<void> {
  const walletAddress = Deno.env.get("HY_WALLET_ADDRESS");

  logger.info("========================================================");
  logger.info("   BTC Grid Bot [Bot Service] - Starting Up");
  logger.info("========================================================");

  if (!walletAddress) {
    logger.warn("⚠️ HY_WALLET_ADDRESS 未設定 (口座情報の参照不可)");
  }

  // 設定読み込み & KV 初期化 (ボット設定を保存し WebUI から参照可能にする)
  const { config, store } = await initConfigAndStore();

  const notifier = new SlackNotifier(undefined, "BTC Grid Trader");
  store.setNotifier(notifier);

  const worker = startWorkerRuntime({ config, store, walletAddress, notifier });

  logger.info(
    `🚀 Bot稼働中: ${config.coin} (${
      config.isMainnet ? "Mainnet" : "Testnet"
    }, チェック間隔=${config.checkIntervalSec}s)`,
  );

  // グレースフルシャットダウンハンドラ
  registerShutdown(async (signal) => {
    logger.info(`🛑 [Bot] シグナル ${signal} 受信。シャットダウン中...`);
    worker.stop();
    await store.close();
    logger.info("🛑 [Bot] シャットダウン完了");
    Deno.exit(0);
  });
}

if (import.meta.main) {
  installSlackErrorReporter("btc-grid-trader-worker");
  main().catch(async (err: unknown) => {
    logger.warn("Fatal error during worker startup:", toError(err));
    await reportSlackError(err, "worker startup");
    Deno.exit(1);
  });
}
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
