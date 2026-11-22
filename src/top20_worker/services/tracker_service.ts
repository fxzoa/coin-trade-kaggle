/**
 * Top20 Volume Tracker: Aggregator Service & Scheduler
 * Manages periodic hourly volume data collection, persistence into Deno KV, and coordination.
 */

import type { MarketDataAdapter } from '../adapters/market_data.ts';
import type { TrackerDatabase } from '../../shared/top20/db/database.ts';
import { getJstIsoString, getMsUntilNextHour } from '../../shared/top20/helpers/time_helper.ts';
import { logger } from '../../shared/top20/logger.ts';
import type { TrackerRecord } from '../../shared/top20/types.ts';

export class TrackerService {
  private db: TrackerDatabase;
  private adapter: MarketDataAdapter;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private isCollecting = false;
  private isRunning = false;

  constructor(db: TrackerDatabase, adapter: MarketDataAdapter) {
    this.db = db;
    this.adapter = adapter;
  }

  /**
   * Fetches latest market data for TOP20 coins, aggregates past 24-hour volume, and saves to Deno KV.
   */
  public async collectAndSave(): Promise<TrackerRecord> {
    if (this.isCollecting) {
      logger.warn('Collection already in progress, skipping duplicate invocation.');
      const latest = await this.db.getLatest();
      if (latest) return latest;
      throw new Error('Collection already in progress and no previous records exist');
    }

    this.isCollecting = true;
    const now = new Date();
    const timestamp = now.getTime();
    const isoTime = getJstIsoString(now);

    try {
      logger.info(`Starting TOP20 24h volume collection at [${isoTime}]...`);

      const aggregation = await this.adapter.fetchTop20HourlyAggregation(20);

      const record = await this.db.insertRecord({
        timestamp,
        iso_time: isoTime,
        total_volume_24h: aggregation.totalVolume24h,
        average_volume_24h: aggregation.averageVolume24h,
        total_volume_1h: aggregation.totalVolume24h, // Alias for backward compatibility
        average_volume_1h: aggregation.averageVolume24h,
        top_count: aggregation.topCount,
        up_count: aggregation.upCount,
        down_count: aggregation.downCount,
        coins: aggregation.coins,
      });

      logger.info(
        `✓ Collection completed: [${record.iso_time}] TOP20 24h Total=$${Math.round(record.total_volume_24h).toLocaleString()}, Avg=$${Math.round(record.average_volume_24h).toLocaleString()}, TopCount=${record.top_count}`,
      );

      return record;
    } catch (err) {
      logger.error(`Collection failed at [${isoTime}]:`, err);
      throw err;
    } finally {
      this.isCollecting = false;
    }
  }

  /**
   * Starts the hourly scheduler.
   * If the KV database has 0 records, triggers an immediate initial collection.
   */
  public async startScheduler(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scheduler is already active.');
      return;
    }

    this.isRunning = true;
    logger.info('Starting Top20 volume tracker hourly scheduler...');

    // If database is empty, trigger an immediate initial collection
    const count = await this.db.getRecordCount();
    if (count === 0) {
      logger.info('Deno KV database has 0 records. Triggering initial collection immediately...');
      this.collectAndSave().catch((err) => {
        logger.error('Initial immediate collection encountered an error:', err);
      });
    } else {
      logger.info(`Deno KV currently contains ${count} records. Next run will be at top of the hour.`);
    }

    this.scheduleNextRun();
  }

  /**
   * Schedules the next collection at the next top of the hour (:00:00)
   */
  private scheduleNextRun(): void {
    if (!this.isRunning) return;

    const msUntilNext = getMsUntilNextHour();
    const nextExecutionDate = new Date(Date.now() + msUntilNext);
    const nextJstStr = getJstIsoString(nextExecutionDate);

    logger.info(
      `Next hourly collection scheduled at: ${nextJstStr} (in ${Math.round(msUntilNext / 1000)} seconds)`,
    );

    this.timerId = setTimeout(async () => {
      try {
        await this.collectAndSave();
      } catch (err) {
        logger.error('Scheduled collection run failed:', err);
      } finally {
        if (this.isRunning) {
          this.scheduleNextRun();
        }
      }
    }, msUntilNext);
  }

  /**
   * Stops the scheduler and cancels pending timers.
   */
  public stopScheduler(): void {
    logger.info('Stopping volume tracker scheduler...');
    this.isRunning = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
