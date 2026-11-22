/**
 * btc-grid-deno: WebUI HTTP サーバー & REST API
 * 静的アセット配信および Deno KV からのリアルタイム状態取得 API を提供
 */

import { APP_NAME, loadGridConfig } from '../../shared/constants.ts';
import { AppKvStore } from '../../shared/helpers/kv_store.ts';
import { getJstIsoString } from '../../shared/helpers/time_helper.ts';
import { logger } from '../../shared/logger.ts';
import type { ApiResponse, LivePositionState } from '../../shared/types.ts';
import { Redis } from 'ioredis';
import { AppError, toError } from '../../shared/errors.ts';

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

/** 金額を小数2桁に丸める */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** /api/* 用 limit: 不正値・0以下は既定値、上限を超えたら上限に丸める */
const API_DEFAULT_LIMIT = 50;
const API_MAX_LIMIT = 200;
function parseApiLimit(searchParams: URLSearchParams): number {
  const rawLimit = Number(searchParams.get('limit') || API_DEFAULT_LIMIT);
  return Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, API_MAX_LIMIT) : API_DEFAULT_LIMIT;
}

/** 互換エンドポイント用 limit: 未指定・非数は既定値、1 〜 max の範囲に丸める */
function clampLimit(searchParams: URLSearchParams, defaultLimit: number, max: number): number {
  return Math.min(max, Math.max(1, Number(searchParams.get('limit')) || defaultLimit));
}

/** ロングポジションの未実現損益・損益率・名目額を算出する (算出不可の場合はすべて 0) */
function calcUnrealizedPnl(
  pos: LivePositionState | null,
  currentPrice: number
): { unrealizedPnl: number; unrealizedPnlPct: number; notionalUsd: number } {
  if (!pos || pos.size <= 0 || pos.entryPx <= 0 || currentPrice <= 0) {
    return { unrealizedPnl: 0, unrealizedPnlPct: 0, notionalUsd: 0 };
  }
  return {
    unrealizedPnl: (currentPrice - pos.entryPx) * pos.size,
    unrealizedPnlPct: ((currentPrice - pos.entryPx) / pos.entryPx) * 100,
    notionalUsd: currentPrice * pos.size,
  };
}

export class BtcGridHttpServer {
  private port: number;
  private store: AppKvStore;
  private publicDir: string;
  private server: Deno.HttpServer | null = null;

  constructor(
    port = 8000,
    store: AppKvStore,
    publicDir = './src/webui/public'
  ) {
    this.port = port;
    this.store = store;
    this.publicDir = publicDir;
  }

  /**
   * CORS対応 JSON レスポンス生成ヘルパー
   */
  private jsonResponse<T>(data: ApiResponse<T> | Record<string, unknown>, status = 200): Response {
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
   * CORS プリフライトハンドラ
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
   * 静的ファイル配信 (パストラバーサル防止)
   */
  private async serveStatic(pathname: string): Promise<Response> {
    const sanitizedPath = pathname === '/' ? '/index.html' : pathname;

    if (sanitizedPath.includes('..')) {
      return this.jsonResponse({ success: false, error: 'Forbidden' }, 403);
    }

    const localPath = `${this.publicDir}${sanitizedPath}`;

    try {
      const fileInfo = await Deno.stat(localPath);
      if (fileInfo.isDirectory) {
        return await this.serveStatic(`${pathname}/index.html`);
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
    } catch (err: unknown) {
      const error = toError(err);
      if (err instanceof Deno.errors.NotFound) {
        return new Response('404 Not Found', { status: 404 });
      }
      logger.error(`[HttpServer] 静的ファイル読み込みエラー (${localPath}):`, error);
      return new Response('500 Internal Server Error', { status: 500 });
    }
  }

  /**
   * エラーハンドラ: AppError および予期しないエラーを適切に HTTP レスポンスへ変換する
   */
  public onError(err: unknown): Response {
    const error = toError(err);
    if (error instanceof AppError) {
      logger.warn(`[HttpServer] AppError (${error.code}) [${error.statusCode}]: ${error.message}`, error.context);
      return this.jsonResponse(
        {
          success: false,
          error: error.message,
          code: error.code,
          ...(error.context ? { context: error.context } : {}),
        },
        error.statusCode
      );
    }

    logger.error('[HttpServer] Unexpected server error:', error);
    return this.jsonResponse(
      {
        success: false,
        error: error.message || 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      },
      500
    );
  }

  /**
   * /api/* 用: ハンドラの例外を捕捉し、ログ出力のうえエラー応答へ変換する
   */
  private async withApiError(label: string, handler: () => Promise<Response>): Promise<Response> {
    try {
      return await handler();
    } catch (err: unknown) {
      const error = toError(err);
      logger.error(`[HttpServer] ${label} 取得エラー:`, error);
      return this.onError(err);
    }
  }

  /**
   * 互換エンドポイント用: 一覧系レスポンス ({status, app, count, limit, <key>, time}) を生成する
   */
  private async listResponse<T>(
    searchParams: URLSearchParams,
    key: string,
    fetchItems: (limit: number) => Promise<T[]>
  ): Promise<Response> {
    const limit = clampLimit(searchParams, 50, 200);
    const items = await fetchItems(limit);
    return this.jsonResponse({
      status: 'ok',
      app: APP_NAME,
      count: items.length,
      limit,
      [key]: items,
      time: getJstIsoString(),
    });
  }

  /** ボット設定を取得する (未保存なら環境変数から読み込む) */
  private async resolveConfig() {
    return (await this.store.getBotConfig()) || loadGridConfig();
  }

  /** GET /api/status (ボット設定, 現在価格, アクティブ注文数, ポジション量) */
  private async handleApiStatus(): Promise<Response> {
    const config = await this.resolveConfig();
    const priceData = await this.store.getCurrentPriceData();
    const positions = await this.store.getPositions();
    const btcPos = positions[`${config.coin}_LONG`];
    const activeOrders = await this.store.getActiveGridOrders(200);
    const lastRun = await this.store.getLastRun();
    const insufficientCooldown = await this.store.getInsufficientCooldown();

    return this.jsonResponse({
      success: true,
      data: {
        app: APP_NAME,
        coin: config.coin,
        config,
        currentPrice: priceData.price,
        priceChange24h: priceData.change24h,
        positionSize: btcPos?.size || 0,
        entryPrice: btcPos?.entryPx || 0,
        activeOrdersCount: activeOrders.length,
        lastRun,
        insufficientCooldown,
        time: getJstIsoString(),
      },
      timestamp: Date.now(),
    });
  }

  /** GET /api/positions (現在BTCポジション, エントリー価格, 未実現損益) */
  private async handleApiPositions(): Promise<Response> {
    const config = await this.resolveConfig();
    const priceData = await this.store.getCurrentPriceData();
    const currentPrice = priceData.price;
    const positions = await this.store.getPositions();
    const btcPos = positions[`${config.coin}_LONG`] || null;
    const pnl = calcUnrealizedPnl(btcPos, currentPrice);

    return this.jsonResponse({
      success: true,
      data: {
        coin: config.coin,
        currentPrice,
        priceChange24h: priceData.change24h,
        position: btcPos
          ? {
              coin: btcPos.coin,
              side: btcPos.side,
              size: btcPos.size,
              entryPrice: btcPos.entryPx,
              markPrice: currentPrice,
              notionalUsd: round2(pnl.notionalUsd),
              unrealizedPnl: round2(pnl.unrealizedPnl),
              unrealizedPnlPct: round2(pnl.unrealizedPnlPct),
            }
          : null,
        allPositions: positions,
        updatedAt: getJstIsoString(),
      },
      timestamp: Date.now(),
    });
  }

  /** GET /api/orders (アクティブ節目BuyLimit注文一覧) */
  private async handleApiOrders(searchParams: URLSearchParams): Promise<Response> {
    const limit = parseApiLimit(searchParams);
    const activeOrders = await this.store.getActiveGridOrders(limit);
    const recentGridOrders = await this.store.getGridOrders(limit);
    const exchangeActive = await this.store.getActiveOrders();

    return this.jsonResponse({
      success: true,
      count: activeOrders.length,
      data: {
        activeOrders,
        recentGridOrders,
        exchangeActiveOrders: exchangeActive,
      },
      timestamp: Date.now(),
    });
  }

  /** GET /api/history (約定履歴 & 利確TPイベント) */
  private async handleApiHistory(searchParams: URLSearchParams): Promise<Response> {
    const limit = parseApiLimit(searchParams);
    const fills = await this.store.getFills(limit);
    const tpOrders = await this.store.getTpOrders(limit);

    let totalRealizedPnl = 0;
    let totalClosedUsd = 0;
    for (const f of fills) {
      totalRealizedPnl += f.closedPnl || 0;
      totalClosedUsd += f.notionalUsd || 0;
    }

    return this.jsonResponse({
      success: true,
      count: fills.length,
      data: {
        fills,
        tpOrders,
        summary: {
          totalRealizedPnl: round2(totalRealizedPnl),
          totalClosedUsd: round2(totalClosedUsd),
          fillsCount: fills.length,
          tpOrdersCount: tpOrders.length,
        },
      },
      timestamp: Date.now(),
    });
  }

  /** GET /health (KV へ実際に読み取りを行い、失敗時は 503 を返す) */
  private async handleHealth(): Promise<Response> {
    try {
      const currentPrice = await this.store.getCurrentPrice();
      return this.jsonResponse({
        status: 'ok',
        app: APP_NAME,
        time: getJstIsoString(),
        currentPrice,
        database: 'connected',
      });
    } catch (err: unknown) {
      const error = toError(err);
      logger.error('[HttpServer] /health DB確認エラー:', error);
      return this.jsonResponse(
        { status: 'error', app: APP_NAME, time: getJstIsoString(), database: 'disconnected', error: error.message },
        503
      );
    }
  }

  /** 互換: /status */
  private async handleLegacyStatus(): Promise<Response> {
    const config = await this.resolveConfig();
    const lastRun = await this.store.getLastRun();
    const priceData = await this.store.getCurrentPriceData();
    return this.jsonResponse({
      status: 'ok',
      app: APP_NAME,
      config,
      lastRun,
      currentPrice: priceData.price,
      priceChange24h: priceData.change24h,
      time: getJstIsoString(),
    });
  }

  /** 互換: /logs (limit は 1〜100、既定 20) */
  private async handleLegacyLogs(searchParams: URLSearchParams): Promise<Response> {
    const limit = clampLimit(searchParams, 20, 100);
    const traces = await this.store.getRecentTraces(limit);
    return this.jsonResponse({
      status: 'ok',
      app: APP_NAME,
      count: traces.length,
      limit,
      traces,
      time: getJstIsoString(),
    });
  }

  /**
   * SSE (/api/events) ハンドラ
   * Redis Pub/Sub のイベントチャンネル (hl:events:prices, hl:events:orders, hl:events:fills, hl:events:positions) を購読し
   * クライアントへリアルタイム配信する
   */
  private handleSSE(req: Request): Response {
    const redisUrl = Deno.env.get('REDIS_URL') || 'redis://localhost:6379';
    const prefix = Deno.env.get('REDIS_KEY_PREFIX') || 'hl:';

    const subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 3000),
    });

    const channels = [
      `${prefix}events:prices`,
      `${prefix}events:orders`,
      `${prefix}events:positions`,
      `${prefix}events:fills`,
    ];

    let isClosed = false;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const sendEvent = (event: string, data: unknown) => {
          if (isClosed) return;
          try {
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            // クライアント切断等の例外
          }
        };

        // 初期接続イベント
        sendEvent('connected', {
          time: Date.now(),
          channels,
        });

        subscriber.subscribe(...channels).catch((err) => {
          logger.error('[HttpServer/SSE] Redis subscribe error:', err);
        });

        subscriber.on('message', (channel: string, message: string) => {
          try {
            const parsed = JSON.parse(message);
            if (channel === `${prefix}events:prices`) {
              sendEvent('prices', parsed);
            } else if (channel === `${prefix}events:orders`) {
              sendEvent('orders', parsed);
            } else if (channel === `${prefix}events:positions`) {
              sendEvent('positions', parsed);
            } else if (channel === `${prefix}events:fills`) {
              sendEvent('fills', parsed);
            }
          } catch {
            // パースエラー
          }
        });

        // 20秒ごとに keepalive コメント送信
        const keepAliveTimer = setInterval(() => {
          if (isClosed) {
            clearInterval(keepAliveTimer);
            return;
          }
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } catch {
            clearInterval(keepAliveTimer);
          }
        }, 20000);

        req.signal.addEventListener('abort', () => {
          isClosed = true;
          clearInterval(keepAliveTimer);
          subscriber.quit().catch(() => {});
          try {
            controller.close();
          } catch {
            // ignore
          }
        });
      },
      cancel() {
        isClosed = true;
        subscriber.quit().catch(() => {});
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  /**
   * HTTP リクエストルーティング
   * - /api/* は GET のみ受け付ける
   * - 互換エンドポイントはメソッド非依存
   * - /api/* と互換エンドポイントの例外は 500 JSON に変換する (/health は 503)
   * - 上記以外は静的ファイル配信へフォールバックする
   */
  private handleRequest = async (req: Request): Promise<Response> => {
    try {
      const { pathname, searchParams } = new URL(req.url);

      if (req.method === 'OPTIONS') {
        return this.handleOptions();
      }

      // API: ボット利用可否フラグ (/api/flags/enabled)
      if (pathname === '/api/flags/enabled') {
        if (req.method === 'GET') {
          const enabled = await this.store.isBotEnabled();
          return this.jsonResponse({ success: true, enabled });
        }
        if (req.method === 'POST') {
          try {
            const body = await req.json();
            const enabled = Boolean(body.enabled);
            await this.store.setBotEnabled(enabled);
            return this.jsonResponse({ success: true, enabled });
          } catch (e: unknown) {
            const error = toError(e);
            return this.jsonResponse({ success: false, error: error.message }, 400);
          }
        }
      }

      // API: エラーログ (/api/errors)
      if (pathname === '/api/errors') {
        if (req.method === 'GET') {
          const limit = clampLimit(searchParams, 100, 200);
          const errors = await this.store.getRecentErrors(limit);
          return this.jsonResponse({ success: true, count: errors.length, errors });
        }
        if (req.method === 'DELETE') {
          await this.store.clearErrors();
          return this.jsonResponse({ success: true, message: 'Errors cleared' });
        }
      }

      if (req.method === 'DELETE') {
        switch (pathname) {
          case '/api/orders': {
            const id = searchParams.get('id');
            if (!id) {
              return this.jsonResponse({ success: false, error: 'Order ID or CLOID is required' }, 400);
            }
            await this.store.deleteGridOrder(id);
            return this.jsonResponse({ success: true, id });
          }
        }
      }

      if (req.method === 'GET') {
        switch (pathname) {
          case '/api/status':
            return this.withApiError('/api/status', () => this.handleApiStatus());
          case '/api/positions':
            return this.withApiError('/api/positions', () => this.handleApiPositions());
          case '/api/orders':
            return this.withApiError('/api/orders', () => this.handleApiOrders(searchParams));
          case '/api/history':
            return this.withApiError('/api/history', () => this.handleApiHistory(searchParams));
          case '/api/errors':
            return this.jsonResponse({ success: true, errors: await this.store.getRecentErrors() });
          case '/api/events':
            return this.handleSSE(req);
        }
      }

      switch (pathname) {
        case '/health':
          return this.handleHealth();
        case '/status':
          return this.withApiError('/status', () => this.handleLegacyStatus());
        case '/logs':
          return this.withApiError('/logs', () => this.handleLegacyLogs(searchParams));
        case '/orders/grid':
          return this.withApiError('/orders/grid', () => this.listResponse(searchParams, 'orders', (n) => this.store.getGridOrders(n)));
        case '/orders/tp':
          return this.withApiError('/orders/tp', () => this.listResponse(searchParams, 'orders', (n) => this.store.getTpOrders(n)));
        case '/fills':
          return this.withApiError('/fills', () => this.listResponse(searchParams, 'fills', (n) => this.store.getFills(n)));
      }

      return await this.serveStatic(pathname);
    } catch (err: unknown) {
      return this.onError(err);
    }
  };

  /**
   * HTTP サーバーの起動
   */
  public start(): Deno.HttpServer {
    logger.info(`Starting WebUI HTTP server on port ${this.port}...`);
    this.server = Deno.serve(
      {
        port: this.port,
        onListen: ({ hostname, port }) => {
          logger.info(`🚀 WebUI Dashboard: http://${hostname || 'localhost'}:${port}/`);
        },
      },
      this.handleRequest
    );
    return this.server;
  }

  /**
   * HTTP サーバーの停止
   */
  public async stop(): Promise<void> {
    if (this.server) {
      logger.info('Stopping WebUI HTTP server...');
      await this.server.shutdown();
      this.server = null;
    }
  }
}
