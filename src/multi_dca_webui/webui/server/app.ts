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
import type { DcaConfig, PriceStatsRecord } from '../../shared/types.ts';

export interface IScannerService {
  runScan(): Promise<{
    detectedCount: number;
    insertedCount: number;
    executedOrderCount: number;
    [key: string]: unknown;
  }>;
  executeSignalManually(id: string): Promise<{
    success: boolean;
    message?: string;
    [key: string]: unknown;
  }>;
}

export interface IKlineService {
  getLatestStats(coin: string): PriceStatsRecord | undefined;
  [key: string]: unknown;
}

export interface AppDeps {
  store: DcaKvStore;
  scanner?: IScannerService | null;
  klineService?: IKlineService | null;
  config: DcaConfig;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { store, scanner, klineService, config } = deps;

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

  // エラーログ (/api/errors)
  app.get('/api/errors', async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10) || 50, 1), 200);
    const errors = await store.getRecentErrors(limit);
    return c.json({ success: true, count: errors.length, errors });
  });

  app.delete('/api/errors', async (c) => {
    try {
      await store.clearErrors();
      return c.json({ success: true, message: 'Errors cleared' });
    } catch (e: unknown) {
      const err = toError(e);
      return c.json({ success: false, error: err.message }, 500);
    }
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
    const fillChannel = `${prefix}events:fills`;
    const statChannel = `${prefix}events:price_stats`;

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
          channels: [priceChannel, orderChannel, fillChannel, statChannel],
        });

        subscriber.subscribe(priceChannel, orderChannel, fillChannel, statChannel).catch((err) => {
          logger.error('[WebUI/SSE] Subscribe error:', err);
        });

        subscriber.on('message', (channel: string, message: string) => {
          try {
            const parsed = JSON.parse(message);
            if (channel === priceChannel) {
              sendEvent('prices', parsed);
            } else if (channel === orderChannel) {
              sendEvent('orders', parsed);
            } else if (channel === fillChannel) {
              sendEvent('fills', parsed);
            } else if (channel === statChannel) {
              sendEvent('price_stats', parsed);
            }
          } catch {
            // パースエラー無視
          }
        });

        // 20秒ごとのキープアライブ
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

        const cleanup = () => {
          if (isClosed) return;
          isClosed = true;
          clearInterval(keepAliveTimer);
          subscriber.quit().catch(() => {});
          try {
            controller.close();
          } catch {
            // ignore
          }
        };

        c.req.raw.signal.addEventListener('abort', cleanup);
      },
      cancel() {
        if (!isClosed) {
          isClosed = true;
          subscriber.quit().catch(() => {});
        }
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
  });

  // システム状態 (証拠金不足クールダウン等)
  app.get('/api/system-status', async (c) => {
    const insufficientCooldown = await store.getInsufficientCooldown();
    return c.json({
      insufficientCooldown,
      time: getJstIsoString(),
    });
  });

  // 価格統計一覧 (現在設定されている targetCoins のみ抽出し、メモリ上の動的ブレイクアウト値も含めて返却)
  app.get('/api/stats', async (c) => {
    const targetSet = new Set(config.targetCoins.map((coin) => coin.toUpperCase()));
    const list = await store.getAllPriceStats();
    const filtered = list.filter((s) => targetSet.has(s.coin.toUpperCase()));
    const updated = filtered.map((s) => klineService?.getLatestStats(s.coin) || s);
    return c.json(updated);
  });

  // 検出シグナル一覧
  app.get('/api/signals', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const list = await store.getSignals(limit);
    return c.json(list);
  });

  // 検出シグナル削除
  app.delete('/api/signals', async (c) => {
    const id = c.req.query('id');
    if (!id) {
      return c.json({ error: 'Signal ID is required' }, 400);
    }
    const success = await store.deleteSignal(id);
    return c.json({ success, id });
  });

  // 注文履歴一覧
  app.get('/api/orders', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const list = await store.getRecentOrders(limit);
    return c.json(list);
  });

  // 注文履歴レコード削除
  app.delete('/api/orders', async (c) => {
    const id = c.req.query('id');
    if (!id) {
      return c.json({ error: 'Order ID is required' }, 400);
    }
    await store.deleteOrder(id);
    return c.json({ success: true, id });
  });

  // 約定履歴一覧
  app.get('/api/fills', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const list = await store.getRecentFills(limit);
    return c.json(list);
  });

  // 手動即時スキャン実行
  app.post('/api/scan', async (c) => {
    if (!scanner) {
      return c.json({
        error: 'Manual scan is disabled in standalone webui mode (managed by worker service)',
      }, 400);
    }
    logger.info('[Api] 🌐 手動スキャン実行リクエストを受信しました');
    try {
      const result = await scanner.runScan();
      logger.info(
        `[Api] ✅ 手動スキャン完了: 検知=${result.detectedCount}, 新規登録=${result.insertedCount}, 自動発注=${result.executedOrderCount}`
      );
      return c.json(result);
    } catch (err: unknown) {
      const error = toError(err);
      logger.error('[Api] ❌ 手動スキャン実行エラー:', error);
      return c.json({ error: error.message }, 500);
    }
  });

  // シグナルの手動即時発注
  app.post('/api/signals/:id/execute', async (c) => {
    if (!scanner) {
      return c.json({
        success: false,
        error: 'Manual signal execution is disabled in standalone webui mode (managed by worker service)',
      }, 400);
    }
    const id = c.req.param('id');
    logger.info(`[Api] 🌐 シグナル手動即時発注リクエストを受信: シグナルID=${id}`);
    try {
      const result = await scanner.executeSignalManually(id);
      if (result.success) {
        logger.info(`[Api] ✅ シグナル手動発注成功: ${id} -> ${result.message}`);
      } else {
        logger.warn(`[Api] ⚠️ シグナル手動発注拒否: ${id} -> ${result.message}`);
      }
      return c.json(result, result.success ? 200 : 400);
    } catch (err: unknown) {
      const error = toError(err);
      logger.error(`[Api] ❌ シグナル手動発注例外: ${id}`, error);
      return c.json({ success: false, error: error.message }, 500);
    }
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
