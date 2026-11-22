/**
 * Top20 Volume Tracker: Worker Service Main Entrypoint
 * Standalone daemon process responsible for periodic market data fetching,
 * ranking TOP 20 currencies by market cap, calculating 1-hour trading volume,
 * and persisting aggregations to Deno KV.
 */

import '@std/dotenv/load';
import { MarketDataAdapter } from './adapters/market_data.ts';
import { DEFAULT_DB_PATH } from '../shared/top20/constants.ts';
import { TrackerDatabase } from '../shared/top20/db/database.ts';
import { type LogLevel, logger, setLogLevel } from '../shared/top20/logger.ts';
import { TrackerService } from './services/tracker_service.ts';

async function main(): Promise<void> {
  const logLevelEnv = Deno.env.get('LOG_LEVEL')?.toUpperCase() as LogLevel | undefined;
  if (logLevelEnv) {
    setLogLevel(logLevelEnv);
  }

  logger.info('========================================================');
  logger.info('   Top20 Volume Tracker [Worker Service] - Starting');
  logger.info('========================================================');

  const dbPath = Deno.env.get('DB_PATH') ?? DEFAULT_DB_PATH;

  logger.info(`Worker Config: Deno KV DB=${dbPath}`);

  // 1. Initialize Deno KV Database
  const db = new TrackerDatabase(dbPath);
  await db.init();

  // 2. Initialize Market Data Adapter
  const adapter = new MarketDataAdapter();

  // 3. Initialize Tracker Service & start Scheduler
  const trackerService = new TrackerService(db, adapter);
  await trackerService.startScheduler();

  logger.info('✓ Worker daemon is actively monitoring. Press Ctrl+C to terminate.');

  // 4. Graceful shutdown handler
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}. Shutting down worker gracefully...`);
    trackerService.stopScheduler();
    db.close();
    logger.info('Worker shutdown complete.');
    Deno.exit(0);
  };

  Deno.addSignalListener('SIGINT', () => shutdown('SIGINT'));
  Deno.addSignalListener('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error('Fatal error during worker startup:', err);
    Deno.exit(1);
  });
}
