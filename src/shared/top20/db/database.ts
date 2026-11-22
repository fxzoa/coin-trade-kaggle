/**
 * Top20 Volume Tracker: Database Layer (Deno KV)
 * Stores hourly snapshots of past 24-hour trading volume aggregations of top 20 cryptocurrencies.
 */

import { DEFAULT_DB_PATH } from '../constants.ts';
import { logger } from '../logger.ts';
import type { NewTrackerRecord, TrackerRecord } from '../types.ts';

export class TrackerDatabase {
  private kvPath: string;
  private kv: Deno.Kv | null = null;
  private tempFileToDelete: string | null = null;

  constructor(kvPath: string = DEFAULT_DB_PATH) {
    this.kvPath = kvPath;
  }

  /**
   * Initializes Deno KV database
   */
  public async init(): Promise<void> {
    if (this.kv) return;
    logger.info(`Initializing Deno KV database at: ${this.kvPath}`);

    // If path is :memory:, create an isolated temporary SQLite file to ensure fresh DB
    if (this.kvPath === ':memory:') {
      const tempPath = await Deno.makeTempFile({ prefix: 'deno_kv_test_', suffix: '.db' });
      this.tempFileToDelete = tempPath;
      this.kv = await Deno.openKv(tempPath);
    } else {
      this.kv = await Deno.openKv(this.kvPath);
    }
  }

  /**
   * Get safe KV instance, auto-initializing if needed
   */
  private async getKv(): Promise<Deno.Kv> {
    if (!this.kv) {
      await this.init();
    }
    return this.kv!;
  }

  /**
   * Inserts an aggregated volume record into Deno KV
   */
  public async insertRecord(record: NewTrackerRecord): Promise<TrackerRecord> {
    const kv = await this.getKv();

    // Use timestamp as sequence ID
    const insertedId = record.timestamp;
    const createdRecord: TrackerRecord = {
      id: insertedId,
      ...record,
    };

    // Store under ["records", timestamp] and update ["latest"]
    const atomic = kv.atomic();
    atomic.set(['records', record.timestamp], createdRecord);
    atomic.set(['latest'], createdRecord);

    const commitResult = await atomic.commit();
    if (!commitResult.ok) {
      throw new Error(`Failed to commit record to Deno KV for timestamp ${record.timestamp}`);
    }

    logger.debug(
      `Record saved to KV: ID=${insertedId} [${record.iso_time}] TOP20 24h Total Volume: $${record.total_volume_24h.toLocaleString()}`,
    );

    return createdRecord;
  }

  /**
   * Retrieves historical records sorted by timestamp
   * @param limit Maximum number of records to return (default: 100)
   * @param order 'asc' (oldest to newest) or 'desc' (newest to oldest)
   */
  public async getHistory(limit: number = 100, order: 'asc' | 'desc' = 'asc'): Promise<TrackerRecord[]> {
    const kv = await this.getKv();
    const reverse = order.toLowerCase() === 'desc';

    const records: TrackerRecord[] = [];
    const iter = kv.list<TrackerRecord>({ prefix: ['records'] }, { reverse, limit });

    for await (const entry of iter) {
      if (entry.value) {
        // Ensure total_volume_24h fallback if older records exist
        const rec = entry.value;
        if (rec.total_volume_24h === undefined && rec.total_volume_1h !== undefined) {
          rec.total_volume_24h = rec.total_volume_1h;
          rec.average_volume_24h = rec.average_volume_1h ?? 0;
        }
        records.push(rec);
      }
    }

    return records;
  }

  /**
   * Retrieves the most recent record
   */
  public async getLatest(): Promise<TrackerRecord | null> {
    const kv = await this.getKv();
    const latestEntry = await kv.get<TrackerRecord>(['latest']);
    if (latestEntry.value) {
      const rec = latestEntry.value;
      if (rec.total_volume_24h === undefined && rec.total_volume_1h !== undefined) {
        rec.total_volume_24h = rec.total_volume_1h;
        rec.average_volume_24h = rec.average_volume_1h ?? 0;
      }
      return rec;
    }

    // Fallback: list 1 in reverse if ["latest"] was not set
    const iter = kv.list<TrackerRecord>({ prefix: ['records'] }, { reverse: true, limit: 1 });
    for await (const entry of iter) {
      const rec = entry.value;
      if (rec.total_volume_24h === undefined && rec.total_volume_1h !== undefined) {
        rec.total_volume_24h = rec.total_volume_1h;
        rec.average_volume_24h = rec.average_volume_1h ?? 0;
      }
      return rec;
    }

    return null;
  }

  /**
   * Returns total count of stored records
   */
  public async getRecordCount(): Promise<number> {
    const kv = await this.getKv();
    let count = 0;
    const iter = kv.list({ prefix: ['records'] });
    for await (const _entry of iter) {
      count++;
    }
    return count;
  }

  /**
   * Closes database connection cleanly and removes any temporary files
   */
  public close(): void {
    if (this.kv) {
      logger.info('Closing Deno KV database connection.');
      this.kv.close();
      this.kv = null;
    }
    if (this.tempFileToDelete) {
      try {
        Deno.removeSync(this.tempFileToDelete);
      } catch {
        // ignore cleanup error
      }
      this.tempFileToDelete = null;
    }
  }
}
