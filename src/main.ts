/**
 * Top20 Volume Tracker: Main Entrypoint
 * Coordinates KV database initialization, scheduler launch, and HTTP server startup.
 */

import '@std/dotenv/load';
import { MarketDataAdapter } from './top20_worker/adapters/market_data.ts';
import {
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
} from './shared/top20/constants.ts';
import { TrackerDatabase } from './shared/top20/db/database.ts';
import { type LogLevel, logger, setLogLevel } from './shared/top20/logger.ts';
import { TrackerHttpServer } from './top20_webui/server/http_server.ts';
import { TrackerService } from './top20_worker/services/tracker_service.ts';

async function main(): Promise<void> {
  const logLevelEnv = Deno.env.get('LOG_LEVEL')?.toUpperCase() as LogLevel | undefined;
  if (logLevelEnv) {
    setLogLevel(logLevelEnv);
  }

  logger.info('========================================================');
  logger.info('   Top20 Volume Tracker (Deno) - Starting Up');
  logger.info('========================================================');

  const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);
  const dbPath = Deno.env.get('DB_PATH') ?? DEFAULT_DB_PATH;

  logger.info(`Configuration: Port=${port}, Deno KV DB=${dbPath}`);

  // 1. Initialize Deno KV Database
  const db = new TrackerDatabase(dbPath);
  await db.init();

  // 2. Initialize Market Data Adapter
  const adapter = new MarketDataAdapter();

  // 3. Initialize Tracker Service & start Scheduler
  const trackerService = new TrackerService(db, adapter);
  await trackerService.startScheduler();

  // 4. Start HTTP Server
  const server = new TrackerHttpServer(port, trackerService, db);
  server.start();

  // 5. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    trackerService.stopScheduler();
    await server.stop();
    db.close();
    logger.info('Shutdown complete.');
    Deno.exit(0);
  };

  Deno.addSignalListener('SIGINT', () => shutdown('SIGINT'));
  Deno.addSignalListener('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error('Fatal error during application startup:', err);
    Deno.exit(1);
  });
}
