/**
 * dca-deno: Hono アプリケーションルーター
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Redis } from 'ioredis';
import { renderWebUI } from './webui_template.ts';
import { getJstIsoString } from '../../shared/helpers/time_helper.ts';
import { APP_NAME } from '../../shared/constants.ts';
import { logger } from '../../shared/logger.ts';
import { AppError, toError } from '../../shared/errors.ts';
import type { DcaKvStore } from '../../shared/helpers/kv_store.ts';
import type { DcaConfig } from '../../shared/types.ts';

export interface AppDeps {
  store: DcaKvStore;
  config: DcaConfig;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { store, config } = deps;

  // グローバルエラーハンドラー (AppError および予期せぬ例外のクリーンなハンドリング)
  app.onError((err, c) => {
    const error = toError(err);
    if (err instanceof AppError) {
      logger.error(`[WebUI/App] AppError [${err.code}]: ${err.message}`, {
        code: err.code,
        statusCode: err.statusCode,
        context: err.context,
      });
      return c.json(
        {
          success: false,
          error: err.message,
          code: err.code,
          ...(err.context ? { context: err.context } : {}),
        },
        err.statusCode as any
      );
    }

    logger.error(`[WebUI/App] 予期せぬ例外: ${error.message}`, error.stack);
    return c.json(
      {
        success: false,
        error: error.message || 'Internal Server Error',
        code: 'INTERNAL_SERVER_ERROR',
      },
      500
    );
  });

  // CORS 設定
  app.use('/api/*', cors());

  // WebUI ダッシュボード (GET /)
  app.get('/', (c) => {
    return c.html(renderWebUI());
  });

  // ヘルスチェック (/health, /api/health, /api/status)
  const healthHandler = async (c: any) => {
    const redisConnected = await store.pingRedis();
    return c.json({
      status: 'ok',
      app: APP_NAME,
      time: getJstIsoString(),
      redisConnected,
      targetCoins: config.targetCoins,
      autoOrderEnabled: config.autoOrderEnabled,
    });
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);
  app.get('/api/status', healthHandler);

  // 設定情報
  app.get('/api/config', (c) => {
    return c.json(config);
  });

  // BOT利用可否フラグ (/api/flags/enabled)
  app.get('/api/flags/enabled', async (c) => {
    const enabled = await store.isBotEnabled();
    return c.json({ success: true, enabled });
  });

  app.post('/api/flags/enabled', async (c) => {
    try {
      const body = await c.req.json();
      const enabled = Boolean(body.enabled);
      await store.setBotEnabled(enabled);
      return c.json({ success: true, enabled });
    } catch (e: unknown) {
      const err = toError(e);
      return c.json({ success: false, error: err.message }, 400);
    }
  });

  // SSE イベントストリーム (/api/events)
  app.get('/api/events', (c) => {
    const redisUrl = Deno.env.get('REDIS_URL') || 'redis://localhost:6379';
    const prefix = Deno.env.get('REDIS_KEY_PREFIX') || 'hl:';
    const priceChannel = `${prefix}events:prices`;
    const orderChannel = `${prefix}events:orders`;

    const subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 500, 3000),
    });

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
            // クライアント切断時等
          }
        };

        // 初期接続通知
        sendEvent('connected', {
          time: Date.now(),
          channels: [priceChannel, orderChannel],
        });

        subscriber.subscribe(priceChannel, orderChannel).catch((err) => {
          logger.error('[WebUI/SSE] Subscribe error:', err);
        });

        subscriber.on('message', (channel: string, message: string) => {
          try {
            const parsed = JSON.parse(message);
            if (channel === priceChannel) {
              sendEvent('prices', parsed);
            } else if (channel === orderChannel) {
              sendEvent('orders', parsed);
            }
          } catch {
            // パースエラー無視
          }
        });

        c.req.raw.signal.addEventListener('abort', () => {
          isClosed = true;
          subscriber.quit().catch(() => {});
        });
      },
      cancel() {
        isClosed = true;
        subscriber.quit().catch(() => {});
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  // システム状態 (証拠金不足クールダウン等)
  app.get('/api/system-status', async (c) => {
    const insufficientCooldown = await store.getInsufficientCooldown();
    return c.json({
      insufficientCooldown,
      time: getJstIsoString(),
    });
  });

  // 価格統計一覧 (現在設定されている targetCoins のみ抽出、欠落分は個別フォールバック取得)
  app.get('/api/stats', async (c) => {
    const targetCoins = config.targetCoins.map((coin) => coin.toUpperCase());
    const targetSet = new Set(targetCoins);
    const list = await store.getAllPriceStats();
    const filtered = list.filter((s) => targetSet.has(s.coin.toUpperCase()));
    const foundSet = new Set(filtered.map((s) => s.coin.toUpperCase()));
    const missing = targetCoins.filter((coin) => !foundSet.has(coin));
    if (missing.length > 0) {
      const fallbacks = await Promise.all(missing.map((coin) => store.getPriceStats(coin)));
      for (const rec of fallbacks) {
        if (rec) filtered.push(rec);
      }
    }
    return c.json(filtered);
  });

  // 検出シグナル一覧 (targetCoins でフィルタリング可能)
  app.get('/api/signals', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const all = c.req.query('all') === 'true';
    const list = await store.getSignals(limit * 3);
    if (all) {
      return c.json(list.slice(0, limit));
    }
    const targetSet = new Set(config.targetCoins.map((coin) => coin.toUpperCase()));
    const filtered = list.filter((s) => targetSet.has(s.coin.toUpperCase())).slice(0, limit);
    return c.json(filtered);
  });

  // 注文履歴一覧 (targetCoins でフィルタリング可能)
  app.get('/api/orders', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const all = c.req.query('all') === 'true';
    const list = await store.getRecentOrders(limit * 3);
    if (all) {
      return c.json(list.slice(0, limit));
    }
    const targetSet = new Set(config.targetCoins.map((coin) => coin.toUpperCase()));
    const filtered = list.filter((o) => targetSet.has(o.coin.toUpperCase())).slice(0, limit);
    return c.json(filtered);
  });

  // 約定履歴一覧 (targetCoins でフィルタリング可能)
  app.get('/api/fills', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const all = c.req.query('all') === 'true';
    const list = await store.getRecentFills(limit * 3);
    if (all) {
      return c.json(list.slice(0, limit));
    }
    const targetSet = new Set(config.targetCoins.map((coin) => coin.toUpperCase()));
    const filtered = list.filter((f) => targetSet.has(f.coin.toUpperCase())).slice(0, limit);
    return c.json(filtered);
  });

  // 手動即時スキャン実行 (worker側で管理されるため、WebUI単体起動時は案内を返却)
  app.post('/api/scan', (c) => {
    return c.json({
      error: 'Manual scan is handled in bot service mode or via Redis command',
    }, 400);
  });

  // シグナルの手動即時発注
  app.post('/api/signals/:id/execute', (c) => {
    return c.json({
      success: false,
      error: 'Manual signal execution is handled in bot service mode or via Redis command',
    }, 400);
  });

  // 通貨別 キャッシュ済み 4H KLINE 取得
  app.get('/api/klines/:coin', async (c) => {
    const coin = c.req.param('coin');
    const count = Math.min(2160, Math.max(1, Number(c.req.query('count')) || 100));
    const klines = await store.getRecentKlines(coin, count);
    return c.json({
      coin: coin.toUpperCase(),
      count: klines.length,
      klines,
    });
  });

  return app;
}
