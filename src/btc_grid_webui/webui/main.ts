/**
 * btc-grid-deno: WebUI Service Main Entrypoint
 * Standalone HTTP server daemon serving the dashboard and REST API endpoints.
 */

import { AppKvStore } from "../shared/helpers/kv_store.ts";
import { logger } from "../shared/logger.ts";
import { loadEnvFile, registerShutdown } from "../shared/bootstrap.ts";
import { BtcGridHttpServer } from "./server/http_server.ts";
import { toError } from "../shared/errors.ts";

// .env ファイルが存在すればロード
await loadEnvFile();

async function main(): Promise<void> {
  const port = Number(Deno.env.get("PORT")) || 8000;

  logger.info("========================================================");
  logger.info("   BTC Grid Bot [WebUI Service] - Starting Up");
  logger.info("========================================================");

  const store = new AppKvStore();
  await store.init();

  const server = new BtcGridHttpServer(port, store);
  server.start();

  logger.info(`✓ WebUI server running at: http://localhost:${port}/`);

  // グレースフルシャットダウンハンドラ
  registerShutdown(async (signal) => {
    logger.info(`🛑 [WebUI] シグナル ${signal} 受信。シャットダウン中...`);
    await server.stop();
    await store.close();
    logger.info("🛑 [WebUI] シャットダウン完了");
    Deno.exit(0);
  });
}

if (import.meta.main) {
  installSlackErrorReporter("btc-grid-trader-webui");
  main().catch(async (err: unknown) => {
    logger.warn("Fatal error during WebUI startup:", toError(err));
    await reportSlackError(err, "WebUI startup");
    Deno.exit(1);
  });
}
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
