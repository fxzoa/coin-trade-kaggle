/**
 * dca-deno: WebUI Service Main Entrypoint
 * Standalone HTTP server daemon responsible for serving the Web UI dashboard
 * and providing REST API endpoints to read DCA signals, stats, and orders from Deno KV.
 */

import "@std/dotenv/load";
import { APP_NAME, loadDcaConfig } from "../shared/constants.ts";
import { logger } from "../shared/logger.ts";
import { DcaKvStore } from "../shared/helpers/kv_store.ts";
import { createApp } from "./server/app.ts";
import { toError } from "../shared/errors.ts";

async function main(): Promise<void> {
  const config = loadDcaConfig();

  logger.info("========================================================");
  logger.info(`   ${APP_NAME} [WebUI Service] - Starting`);
  logger.info(`   Port: ${config.port}`);
  logger.info("========================================================");

  // 1. Initialize KV Database
  const store = new DcaKvStore();
  await store.init();

  // 2. Initialize Hono App
  const app = createApp({ store, config });

  // 3. Start HTTP Server
  const server = Deno.serve(
    {
      port: config.port,
      onListen({ port, hostname }) {
        logger.info(
          `[WebUI] 🌐 WebUI server running at: http://${hostname || "localhost"}:${port}/`,
        );
      },
    },
    app.fetch,
  );

  // 4. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info(`[WebUI] Received ${signal}. Shutting down WebUI server gracefully...`);
    await server.shutdown();
    await store.close();
    logger.info("[WebUI] WebUI shutdown complete.");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  installSlackErrorReporter("multi-dca-trader-webui");
  main().catch(async (err: unknown) => {
    logger.warn("Fatal error during WebUI server startup:", toError(err));
    await reportSlackError(err, "WebUI startup");
    Deno.exit(1);
  });
}
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
