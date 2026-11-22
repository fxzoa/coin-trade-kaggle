/**
 * hl-price-listener: WebUI Standalone Entrypoint
 * Starts the HTTP server on port 8004 and listens for termination signals.
 */

import { DEFAULT_WEBUI_PORT, HlPriceWebuiServer } from "./server/http_server.ts";

/** Loads optional local .env if present and environment variable not already set */
async function loadEnvSafe(): Promise<void> {
  try {
    const text = await Deno.readTextFile(".env");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (!Deno.env.get(key)) {
        Deno.env.set(key, val);
      }
    }
  } catch {
    // .env is optional
  }
}

async function main(): Promise<void> {
  await loadEnvSafe();

  const port = Number(Deno.env.get("PORT")) || DEFAULT_WEBUI_PORT;

  console.info("========================================================");
  console.info("   HL Price & Breakout Monitor [WebUI Service]");
  console.info(`   Port: ${port}`);
  console.info("========================================================");

  const server = new HlPriceWebuiServer(port);
  server.start();

  console.info(`✓ WebUI dashboard accessible at: http://localhost:${port}/`);
  console.info(`✓ Health check available at:     http://localhost:${port}/health`);

  // Graceful shutdown handling
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.info(`\n🛑 [WebUI] Received ${signal}. Shutting down HTTP server gracefully...`);
    try {
      await server.stop();
      console.info("🛑 [WebUI] Shutdown complete.");
      Deno.exit(0);
    } catch (err) {
      console.error("🛑 [WebUI] Error during shutdown:", err);
      Deno.exit(1);
    }
  };

  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  installSlackErrorReporter("surge-dip-trader-webui");
  main().catch(async (err) => {
    await reportSlackError(err, "webui startup");
    console.warn("Fatal error during WebUI startup:", err);
    Deno.exit(1);
  });
}
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
