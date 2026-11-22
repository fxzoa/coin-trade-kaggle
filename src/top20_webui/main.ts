/**
 * Top20 Volume Tracker: WebUI Service Main Entrypoint
 * Standalone HTTP server daemon responsible for serving the Web UI dashboard
 * and providing REST API endpoints to read volume history from Deno KV.
 */

import '@std/dotenv/load';
import {
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
} from '../shared/top20/constants.ts';
import { TrackerDatabase } from '../shared/top20/db/database.ts';
import { type LogLevel, logger, setLogLevel } from '../shared/top20/logger.ts';
import { TrackerHttpServer } from './server/http_server.ts';

async function main(): Promise<void> {
  const logLevelEnv = Deno.env.get('LOG_LEVEL')?.toUpperCase() as LogLevel | undefined;
  if (logLevelEnv) {
    setLogLevel(logLevelEnv);
  }

  logger.info('========================================================');
  logger.info('   Top20 Volume Tracker [WebUI Service] - Starting');
  logger.info('========================================================');

  const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);
  const dbPath = Deno.env.get('DB_PATH') ?? DEFAULT_DB_PATH;

  logger.info(`WebUI Config: Port=${port}, Deno KV DB=${dbPath}`);

  // 1. Initialize Deno KV Database
  const db = new TrackerDatabase(dbPath);
  await db.init();

  // 2. Start HTTP Server in standalone WebUI mode
  const server = new TrackerHttpServer(port, db);
  server.start();

  logger.info(`✓ WebUI server running at: http://localhost:${port}/`);

  // 3. Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down WebUI server gracefully...`);
    await server.stop();
    db.close();
    logger.info('WebUI shutdown complete.');
    Deno.exit(0);
  };

  Deno.addSignalListener('SIGINT', () => shutdown('SIGINT'));
  Deno.addSignalListener('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error('Fatal error during WebUI server startup:', err);
    Deno.exit(1);
  });
}
