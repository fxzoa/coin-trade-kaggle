/**
 * Top20 Volume Tracker: HTTP Server & REST API
 * Serves dashboard static assets from src/webui/public and provides RESTful endpoints reading from Deno KV.
 */

import { DEFAULT_PORT } from '../../shared/top20/constants.ts';
import { TrackerDatabase } from '../../shared/top20/db/database.ts';
import { getJstIsoString } from '../../shared/top20/helpers/time_helper.ts';
import { logger } from '../../shared/top20/logger.ts';
import { TrackerService } from '../../top20_worker/services/tracker_service.ts';
import type { ApiResponse } from '../../shared/top20/types.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export class TrackerHttpServer {
  private port: number;
  private service: TrackerService | null = null;
  private db: TrackerDatabase;
  private publicDir: string;
  private server: Deno.HttpServer | null = null;

  constructor(
    port: number = DEFAULT_PORT,
    serviceOrDb: TrackerService | TrackerDatabase,
    dbOrService?: TrackerDatabase | TrackerService | null,
    publicDir: string = './src/top20_webui/public',
  ) {
    this.port = port;
    this.publicDir = publicDir;

    if (serviceOrDb instanceof TrackerDatabase) {
      this.db = serviceOrDb;
      this.service = (dbOrService instanceof TrackerService ? dbOrService : null);
    } else {
      this.service = serviceOrDb;
      this.db = (dbOrService instanceof TrackerDatabase ? dbOrService : null)!;
    }
  }

  /**
   * Helper to return standard JSON API response with CORS
   */
  private jsonResponse<T>(data: ApiResponse<T>, status: number = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  /**
   * Handler for CORS preflight OPTIONS requests
   */
  private handleOptions(): Response {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  /**
   * Serve static files safely from publicDir
   */
  private async serveStatic(pathname: string): Promise<Response> {
    const sanitizedPath = pathname === '/' ? '/index.html' : pathname;

    // Prevent directory traversal attacks
    if (sanitizedPath.includes('..')) {
      return this.jsonResponse({ success: false, error: 'Forbidden' }, 403);
    }

    const localPath = `${this.publicDir}${sanitizedPath}`;

    try {
      const fileInfo = await Deno.stat(localPath);
      if (fileInfo.isDirectory) {
        return this.serveStatic(`${pathname}/index.html`);
      }

      const fileData = await Deno.readFile(localPath);
      const extIndex = sanitizedPath.lastIndexOf('.');
      const ext = extIndex !== -1 ? sanitizedPath.slice(extIndex).toLowerCase() : '';
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      return new Response(fileData, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return new Response('404 Not Found', { status: 404 });
      }
      logger.error(`Error reading static file ${localPath}:`, err);
      return new Response('500 Internal Server Error', { status: 500 });
    }
  }

  /**
   * Request handler router
   */
  private handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    if (req.method === 'OPTIONS') {
      return this.handleOptions();
    }

    // Health check endpoint
    if (pathname === '/health') {
      return this.jsonResponse({
        success: true,
        data: {
          status: 'ok',
          timestamp: Date.now(),
          iso_time: getJstIsoString(),
        },
      });
    }

    // API: /api/latest
    if (pathname === '/api/latest' && req.method === 'GET') {
      try {
        const latest = await this.db.getLatest();
        return this.jsonResponse({
          success: true,
          data: latest,
          timestamp: Date.now(),
        });
      } catch (err) {
        logger.error('Failed to retrieve latest record:', err);
        return this.jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // API: /api/history
    if (pathname === '/api/history' && req.method === 'GET') {
      try {
        const rawLimit = Number(searchParams.get('limit') ?? 100);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100;
        const rawOrder = searchParams.get('order')?.toLowerCase();
        const order: 'asc' | 'desc' = rawOrder === 'desc' ? 'desc' : 'asc';

        const history = await this.db.getHistory(limit, order);
        return this.jsonResponse({
          success: true,
          count: history.length,
          data: history,
          timestamp: Date.now(),
        });
      } catch (err) {
        logger.error('Failed to retrieve history records:', err);
        return this.jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // API: /api/collect (Triggers manual aggregation)
    if (pathname === '/api/collect' && (req.method === 'POST' || req.method === 'GET')) {
      if (!this.service) {
        return this.jsonResponse({
          success: false,
          error: 'Manual collection trigger is disabled in standalone webui mode (managed by worker service)',
        }, 400);
      }
      try {
        const record = await this.service.collectAndSave();
        return this.jsonResponse({
          success: true,
          data: record,
          timestamp: Date.now(),
        });
      } catch (err) {
        logger.error('Manual collection trigger failed:', err);
        return this.jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // Fallback: Static file server
    return await this.serveStatic(pathname);
  };

  /**
   * Starts listening for incoming HTTP connections
   */
  public start(): Deno.HttpServer {
    logger.info(`Starting HTTP server on port ${this.port}...`);
    this.server = Deno.serve(
      {
        port: this.port,
        onListen: ({ hostname, port }) => {
          logger.info(`🚀 Server running and accessible at: http://${hostname || 'localhost'}:${port}/`);
        },
      },
      this.handleRequest,
    );
    return this.server;
  }

  /**
   * Stops HTTP server
   */
  public async stop(): Promise<void> {
    if (this.server) {
      logger.info('Stopping HTTP server...');
      await this.server.shutdown();
      this.server = null;
    }
  }
}
