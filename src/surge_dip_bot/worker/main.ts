import type { PriceTick } from "../shared/domain/types.ts";
import { formatError } from "../shared/errors.ts";
import { DEFAULT_DB_PATH } from "../shared/constants/db_path.ts";
import { ALL_SYMBOLS } from "../shared/constants/edge_symbols.ts";
import type { TradeSignal } from "../shared/domain/trade_signal.ts";
import { Redis } from "ioredis";
import {
  createRedisDcaPipeline,
  createRedisSignalRegistrar,
} from "./composition/create_redis_pipeline.ts";
import { RedisSignalRepository } from "./infrastructure/redis_signal_repository.ts";
import { createPriceRangeSyncer } from "./composition/create_price_range_syncer.ts";
import { findInvalidFlagValues, findUnknownSymbols, loadConfig } from "../shared/config.ts";
import { collectHighlights, formatActiveExtremes } from "../shared/formatting/breakout_log.ts";
import { formatEnvSummary } from "../shared/formatting/env_summary.ts";
import { parseAllMids } from "../shared/domain/message_parser.ts";
import { isOutcomeSymbol } from "../shared/domain/symbol_kind.ts";
import { RedisPriceSubscriber } from "./infrastructure/redis_price_subscriber.ts";
import {
  createDependencyBreakers,
  createDependencyResilience,
} from "./composition/dependency_resilience.ts";
import type { ResilienceOptions } from "./infrastructure/resilience.ts";
import { PerpVolumeClient } from "./infrastructure/perp_volume_client.ts";
import { fetchSymbolNameResolver } from "./infrastructure/symbol_name_resolver.ts";
import { openCandleRepository } from "../shared/repository/candle_repository.ts";
import { RANGE_WINDOWS } from "../shared/domain/price_range.ts";
import { RedisCandleRepository } from "../shared/repository/redis_candle_repository.ts";
import { KvCandleRepository } from "../shared/repository/kv_candle_repository.ts";
import { fetchCandles } from "./infrastructure/candle_fetcher.ts";
import { backfillCandles } from "./usecase/backfill_candles.ts";
import { floorToH4, H4_MS } from "../shared/domain/h4_time.ts";
import {
  DEFAULT_SHUTDOWN_SIGNALS,
  installSignalHandlers,
} from "./infrastructure/signal_handlers.ts";
import { scheduleAtH4Boundaries } from "./usecase/h4_scheduler.ts";
import { InsufficientGate } from "./usecase/insufficient_gate.ts";
import { DEFAULT_VOLUME_REFRESH_MS, PerpVolumeCache } from "./usecase/perp_volume_cache.ts";
import { PriceRangeCache } from "./usecase/price_range_cache.ts";
import { refreshUntilFresh, refreshWithRetry } from "./usecase/price_range_refresher.ts";
import { RangeBreakoutDetector } from "./usecase/range_breakout_detector.ts";
import { SignalEvaluator } from "./usecase/signal_evaluator.ts";
import { formatShutdownSummary, ShutdownCoordinator } from "./usecase/shutdown.ts";
import { HyperliquidClient } from "../shared/hyperliquid_client.ts";
import { SignalExecutionStore } from "../shared/signal_execution_store.ts";
import { SignalExecutionEngine } from "../shared/signal_execution_engine.ts";
import { SlackNotifier } from "../shared/slack_notifier.ts";

/** H4 境界後、確定足を取得して KV へ登録するまでの待機時間 (ms) */
const RANGE_REFRESH_DELAY_MS = 5 * 60 * 1000;
/** API 取得時に重複取得して取りこぼしを補う確定足数 */
const CLOSED_CANDLES_TO_REFRESH = 3;
/** 通貨ごとの candleSnapshot 呼び出し間隔 (ms) */
const CANDLE_FETCH_INTERVAL_MS = 300;
/** 最新足が未登録の銘柄がある場合の再集計の間隔 (ms) と最大回数 */
const RANGE_RETRY_DELAY_MS = 60 * 1000;
const RANGE_MAX_RETRIES = 5;

/** 指定時間だけ待つ (setTimeout) */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 期間別レンジのキャッシュを作り、起動時と H4 切り替わりごとに DB から集計し直す。
 * 切り替わり後の集計では、最新足が揃うまで一定回数再集計する。
 * DB が読めない場合は警告のみで、価格監視は継続する (集計に失敗した場合は前回のキャッシュを維持する)。
 * 集計のたびに DB を開いて閉じるため、終了時に保持している接続はない。
 * 終了時は定期集計を止める (待機中の再集計は破棄して構わないため、完了待ちの対象にしない)
 */
async function startPriceRangeCache(
  dbPath: string,
  coordinator: ShutdownCoordinator,
  hooks?: {
    onRefreshed?: () => Promise<void>;
    refreshCandles?: (repo: KvCandleRepository) => Promise<void>;
  },
): Promise<PriceRangeCache> {
  const storeType = Deno.env.get("CANDLE_STORE") ||
    (dbPath.endsWith(".sqlite") ? "sqlite" : "redis");
  const isKv = storeType === "kv" || Deno.env.get("KV_PATH") !== undefined;
  const isRedis = !isKv &&
    (storeType === "redis" || dbPath === "redis" || !dbPath.endsWith(".sqlite"));

  const redisRepo = isRedis ? new RedisCandleRepository() : null;
  if (redisRepo) {
    coordinator.register("Redis Candle Repository の切断", () => redisRepo.close());
  }

  const kvPath = Deno.env.get("KV_PATH") || "./data/kv.sqlite";
  const kvRepo = isKv ? new KvCandleRepository(kvPath) : null;
  if (kvRepo) {
    coordinator.register("Deno KV Candle Repository の切断", () => kvRepo.close());
  }

  const cache = new PriceRangeCache((since) => {
    if (isRedis || isKv) {
      return {
        ranges: new Map(),
        latestOpenTimes: new Map(),
        openPrices: new Map(),
      };
    }
    const repo = openCandleRepository(dbPath, { readOnly: true });
    try {
      return {
        ranges: repo.aggregateRanges(since),
        latestOpenTimes: repo.latestOpenTimes(),
        openPrices: repo.aggregateOpenPrices(since),
      };
    } finally {
      repo.close();
    }
  });

  // 初回集計
  try {
    if (kvRepo) {
      const now = Date.now();
      const since = Object.fromEntries(RANGE_WINDOWS.map((w) => [w.label, now - w.ms]));
      const [ranges, latestOpenTimes, openPrices] = await Promise.all([
        kvRepo.aggregateRangesAsync(since),
        kvRepo.latestOpenTimesAsync(),
        kvRepo.aggregateOpenPricesAsync(since),
      ]);
      cache.setSnapshot({ ranges, latestOpenTimes, openPrices }, now);
      console.info(`[Deno KV] 期間別レンジを集計しました: ${cache.size} 銘柄 (${kvPath})`);
    } else if (redisRepo) {
      const now = Date.now();
      const since = Object.fromEntries(RANGE_WINDOWS.map((w) => [w.label, now - w.ms]));
      const [ranges, latestOpenTimes, openPrices] = await Promise.all([
        redisRepo.aggregateRangesAsync(since),
        redisRepo.latestOpenTimesAsync(),
        redisRepo.aggregateOpenPricesAsync(since),
      ]);
      cache.setSnapshot({ ranges, latestOpenTimes, openPrices }, now);
      console.info(`[Redis] 期間別レンジを集計しました: ${cache.size} 銘柄`);
    } else {
      await refreshWithRetry(cache, Date.now, { sleep, onLog: (msg) => console.warn(msg) });
      console.info(`期間別レンジを集計しました: ${cache.size} 銘柄 (${dbPath})`);
    }

    const stale = cache.staleSymbols(Date.now());
    if (stale.length > 0) {
      console.warn(
        `最新の確定足が未登録の銘柄が ${stale.length} 件あります`,
      );
    }
  } catch (e) {
    console.warn(
      `期間別レンジの初回集計に失敗しました: ${formatError(e)}`,
    );
  }

  const stop = scheduleAtH4Boundaries({
    task: async () => {
      if (coordinator.shuttingDown) return;
      if (kvRepo) {
        await hooks?.refreshCandles?.(kvRepo);
        const now = Date.now();
        const since = Object.fromEntries(RANGE_WINDOWS.map((w) => [w.label, now - w.ms]));
        const [ranges, latestOpenTimes, openPrices] = await Promise.all([
          kvRepo.aggregateRangesAsync(since),
          kvRepo.latestOpenTimesAsync(),
          kvRepo.aggregateOpenPricesAsync(since),
        ]);
        cache.setSnapshot({ ranges, latestOpenTimes, openPrices }, now);
        if (hooks?.onRefreshed && !coordinator.shuttingDown) {
          await hooks.onRefreshed();
        }
      } else if (redisRepo) {
        const now = Date.now();
        const since = Object.fromEntries(RANGE_WINDOWS.map((w) => [w.label, now - w.ms]));
        const [ranges, latestOpenTimes, openPrices] = await Promise.all([
          redisRepo.aggregateRangesAsync(since),
          redisRepo.latestOpenTimesAsync(),
          redisRepo.aggregateOpenPricesAsync(since),
        ]);
        cache.setSnapshot({ ranges, latestOpenTimes, openPrices }, now);
        if (hooks?.onRefreshed && !coordinator.shuttingDown) {
          await hooks.onRefreshed();
        }
      } else {
        await refreshUntilFresh(cache, {
          now: Date.now,
          sleep,
          maxRetries: RANGE_MAX_RETRIES,
          retryDelayMs: RANGE_RETRY_DELAY_MS,
          onLog: (msg) => console.info(msg),
        });
        if (hooks?.onRefreshed && !coordinator.shuttingDown) {
          await hooks.onRefreshed();
        }
      }
    },
    delayMs: RANGE_REFRESH_DELAY_MS,
    onError: (e) =>
      console.warn(
        `期間別レンジの集計に失敗しました: ${formatError(e)}`,
      ),
    onRecover: () => console.info("期間別レンジの集計が回復しました"),
  });
  coordinator.register("期間別レンジの定期集計の停止", stop);
  return cache;
}

/** 端末の桁数 (100% 幅で表示するため)。端末に出力していない場合は undefined */
function consoleWidth(): number | undefined {
  if (!Deno.stderr.isTerminal()) return undefined;
  try {
    return Deno.consoleSize().columns;
  } catch {
    return undefined;
  }
}

/**
 * 更新処理を一定間隔で実行する。実行中の更新は終了時の完了待ちの対象にし、
 * 終了処理が始まったら新たに開始しない。停止は終了フックとして登録する
 */
function startPeriodicRefresh(
  coordinator: ShutdownCoordinator,
  name: string,
  intervalMs: number,
  refresh: () => Promise<unknown>,
): void {
  const timer = setInterval(() => {
    if (coordinator.shuttingDown) return;
    coordinator.track(refresh()).catch((e) =>
      console.warn(`${name}の更新が失敗しました (前回の値を維持します): ${formatError(e)}`)
    );
  }, intervalMs);
  coordinator.register(`${name}の定期更新の停止`, () => clearInterval(timer));
}

/**
 * 銘柄別の 24H 取引高を取得し、定期的に更新する (最小取引高チェック用)。
 * 取得に失敗しても警告のみで継続する
 */
async function startVolumeCache(
  infoUrl: string,
  resilience: ResilienceOptions,
  coordinator: ShutdownCoordinator,
  redisClient?: Redis | null,
): Promise<PerpVolumeCache> {
  const cache = new PerpVolumeCache({
    source: new PerpVolumeClient(infoUrl, undefined, resilience, redisClient),
    onLog: (msg) => console.warn(msg),
    onError: (msg) => console.error(msg),
    onInfo: (msg) => console.info(msg),
  });
  await cache.refresh();
  console.info(`24H 取引高を取得しました: ${cache.size} 銘柄`);
  startPeriodicRefresh(coordinator, "24H 取引高", DEFAULT_VOLUME_REFRESH_MS, () => cache.refresh());
  return cache;
}

/**
 * DCA 用の OPEN ポジションを D1 から取得し、定期的に更新する。
 * 取得に失敗しても警告のみで継続する (キャッシュ側で前回の値を維持)
 */
async function startDcaPositionRefresh(
  dca: { positions: { refresh: () => Promise<void>; size: number } },
  refreshSeconds: number,
  coordinator: ShutdownCoordinator,
): Promise<void> {
  await dca.positions.refresh();
  console.info(`DCA 用の OPEN ポジションを取得しました: ${dca.positions.size} 件`);
  startPeriodicRefresh(
    coordinator,
    "DCA 用ポジション",
    refreshSeconds * 1000,
    () => dca.positions.refresh(),
  );
}

/** 価格監視ループと各種サービスの初期化・実行 */
export async function runWorker(coordinator: ShutdownCoordinator): Promise<void> {
  // 設定値の検証 (loadConfig) で失敗しても読んだ値を確認できるよう、最初に出力する
  console.info(formatEnvSummary(Deno.env));
  // 打ち間違い (例: BREAKOUT_LIST_ENABLED=fals) が無言で既定値になることを防ぐため警告する
  for (const warning of findInvalidFlagValues(Deno.env)) console.warn(warning);
  const config = loadConfig(Deno.env);
  const unknownSymbols = findUnknownSymbols(config.symbols, ALL_SYMBOLS);
  if (unknownSymbols.length > 0) {
    console.warn(
      `HL_SYMBOLS に既知の銘柄一覧に無いものがあります (綴りを確認してください): ${
        unknownSymbols.join(",")
      }`,
    );
  }
  const candleSymbols = config.symbols.length > 0 ? config.symbols : ALL_SYMBOLS;
  const cacheHooks: {
    onRefreshed?: () => Promise<void>;
    refreshCandles?: (repo: KvCandleRepository) => Promise<void>;
  } = {
    refreshCandles: async (repo) => {
      const boundary = floorToH4(Date.now());
      const result = await backfillCandles({
        symbols: candleSymbols,
        startTime: boundary - CLOSED_CANDLES_TO_REFRESH * H4_MS,
        endTime: boundary - 1,
        fetchCandles: (symbol, startTime, endTime) =>
          fetchCandles(config.infoUrl, symbol, "4h", startTime, endTime),
        save: (candles) => repo.upsertManyAsync(candles),
        sleep,
        intervalMs: CANDLE_FETCH_INTERVAL_MS,
        onLog: (message) => console.info(`[H4 candle] ${message}`),
      });
      console.info(
        `H4確定足をDeno KVへ登録しました: 成功 ${result.saved} 銘柄 (${result.totalCandles} 本) / ` +
          `データなし ${result.empty.length} 銘柄 / 失敗 ${result.failed.length} 銘柄`,
      );
      if (result.failed.length > 0) {
        console.warn(`H4確定足の取得に失敗した銘柄: ${result.failed.join(", ")}`);
      }
    },
  };
  const rangeCache = await startPriceRangeCache(
    Deno.env.get("HL_DB_PATH")?.trim() || DEFAULT_DB_PATH,
    coordinator,
    cacheHooks,
  );
  const breakoutDetector = new RangeBreakoutDetector(rangeCache);
  const signalEvaluator = new SignalEvaluator(
    rangeCache,
    config.signal.thresholds,
    (msg) => console.warn(msg),
  );
  // 依存先 (D1 / KV / Queues / Hyperliquid Info) ごとの遮断器は 1 つずつ作り、全クライアントで共有する
  const logSinks = {
    onLog: (msg: string) => console.warn(msg),
    onError: (msg: string) => console.error(msg),
    onInfo: (msg: string) => console.info(msg),
  };
  const breakers = createDependencyBreakers(logSinks);
  const resilience = createDependencyResilience({ ...logSinks, breakers });
  const redisClient = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  coordinator.register("Worker Redis Client 切断", async () => {
    await redisClient.quit();
  });

  const volumeCache = await startVolumeCache(
    config.infoUrl,
    resilience.hyperliquidInfo,
    coordinator,
    redisClient,
  );

  const redisKvReader = {
    get: async (key: string) => {
      return (await redisClient.get(`hl:${key}`)) ?? (await redisClient.get(key));
    },
  };
  const insufficientGate = new InsufficientGate({
    kv: redisKvReader,
    onLog: (msg) => console.warn(msg),
    onInfo: (msg) => console.info(msg),
  });
  await insufficientGate.refresh();
  startPeriodicRefresh(
    coordinator,
    "Insufficient 状態",
    10 * 1000,
    () => insufficientGate.refresh(),
  );

  const { signalRegistrar, signalRepo, tradeModeCheck } = createRedisSignalRegistrar(
    config.signal,
    {
      redisClient,
      volumes: volumeCache,
      ...logSinks,
      onSkip: (msg) => console.info(msg),
    },
  );
  console.info("シグナル登録: 有効 (Redis hl:signals:list へ登録 & hl:events:signals へPub/Sub)");

  const dca = createRedisDcaPipeline(config.signal, {
    redisClient,
    volumes: volumeCache,
    ...logSinks,
    onSkip: (msg) => console.info(msg),
  });
  if (dca) {
    await startDcaPositionRefresh(
      dca as any,
      config.signal.dcaPositionsRefreshSeconds,
      coordinator,
    );
  }
  console.info(`DCA (ナンピン): ${dca ? "有効" : "無効"}`);
  const resolveName = await fetchSymbolNameResolver(
    config.infoUrl,
    (msg) => console.warn(msg),
    undefined,
    resilience.hyperliquidInfo,
  );
  // 端末に出力する場合のみ色で強調する (ログファイルへの出力や NO_COLOR 指定時は印 (*) にする)
  const useColor = Deno.stderr.isTerminal() && !Deno.env.get("NO_COLOR");
  const targets = config.symbols.length > 0 ? new Set(config.symbols) : null;

  console.info(
    `起動しました: network=${config.network} ` +
      `対象銘柄=${targets ? config.symbols.join(",") : "全銘柄"} ` +
      `予測市場=${config.includeOutcomes ? "含む" : "除外"}`,
  );

  /** 待たずに実行する非同期処理。終了時の完了待ちの対象にし、想定外の失敗も警告にする */
  const runInBackground = (task: Promise<void>): void => {
    coordinator.track(task).catch((e) =>
      console.warn(`非同期処理が失敗しました (監視は継続します): ${formatError(e)}`)
    );
  };

  const priceRangeSyncer = createPriceRangeSyncer(config.signal, rangeCache, {
    redisClient,
    logSinks,
    getVolume: (s) => volumeCache.get(s),
  });
  coordinator.register("Redis 価格統計同期の停止", () => priceRangeSyncer.dispose());
  console.info(
    `Redis 価格統計同期: ${
      priceRangeSyncer.enabled ? "有効 (Redis price_stats:* へ同期)" : "ドライラン (同期しない)"
    }`,
  );
  if (priceRangeSyncer.enabled) {
    cacheHooks.onRefreshed = () =>
      coordinator.shuttingDown ? Promise.resolve() : priceRangeSyncer.syncAll().then(() => {});
    // 初回起動時の一括同期 (バックグラウンドで実行)
    runInBackground(priceRangeSyncer.syncAll().then(() => {}));
  }

  // Slack 通知クライアントの初期化
  const slackNotifier = new SlackNotifier({ botName: "Surge DIP Trader" });

  // 統合 Open/Close 実行エンジンの初期化
  const execStore = new SignalExecutionStore(undefined, undefined, slackNotifier);
  await execStore.init();
  coordinator.register("Signal Execution Store の切断", () => execStore.close());

  const walletAddress = Deno.env.get("HY_WALLET_ADDRESS");
  const secretKey = Deno.env.get("HY_SECRET_KEY");
  const apiUrl = Deno.env.get("HY_API_URL") || "https://api.hyperliquid.xyz";
  const execClient = new HyperliquidClient(
    apiUrl,
    walletAddress,
    secretKey,
    true,
  );

  const defaultOrderUsd = parseFloat(Deno.env.get("DEFAULT_ORDER_SIZE_USD") || "100");
  const takeProfitGainPct = parseFloat(Deno.env.get("TAKE_PROFIT_GAIN_PCT") || "6.18");
  const autoOrderEnabled = Deno.env.get("AUTO_ORDER_ENABLED") === "true";

  const executionEngine = new SignalExecutionEngine(
    execClient,
    execStore,
    defaultOrderUsd,
    takeProfitGainPct,
    0.005,
    "Alo",
    slackNotifier,
  );

  // Redis 約定イベント購読 (90%約定昇格 & ステータス更新)
  const eventSub = new Redis(config.redisUrl);
  eventSub.subscribe("hl:events:orders", "hl:events:fills");
  eventSub.on("message", (channel, message) => {
    try {
      const parsed = JSON.parse(message);
      if (channel === "hl:events:orders" && parsed.order) {
        const o = parsed.order;
        const oid = o.oid ? String(o.oid) : "";
        const cloid = o.cloid || "";
        const status = (parsed.status || "open").toUpperCase();
        if (oid || cloid) {
          (async () => {
            const existing = await execStore.getOrderByCloidOrOid(cloid || oid);
            if (existing) {
              if (status === "FILLED") existing.status = "OPEN";
              else if (status === "CANCELED" || status === "CANCELLED") existing.status = "CANCEL";
              existing.updatedAt = new Date().toISOString();
              await execStore.saveOrder(existing);
            }
          })().catch(() => {});
        }
      } else if (channel === "hl:events:fills" && Array.isArray(parsed.fills)) {
        for (const f of parsed.fills) {
          const sz = parseFloat(f.sz || "0");
          const targetId = f.cloid || (f.oid ? String(f.oid) : "");
          if (targetId && sz > 0) {
            execStore.recordOrderFillProgress(targetId, sz).catch(() => {});
          }
        }
      }
    } catch (_) {}
  });
  coordinator.register("約定イベント購読の切断", () => {
    eventSub.disconnect();
    return Promise.resolve();
  });

  /** 受信した価格ティック配列を処理する (一覧表示・シグナル判定・登録) */
  const handleTicks = (ticks: PriceTick[]): void => {
    // 今回のメッセージで新たに更新されたセル (一覧の中で強調する)
    const highlighted = new Set<string>();
    const signals: TradeSignal[] = [];
    const dcaSignals: TradeSignal[] = [];
    const isInsufficient = insufficientGate.isActive();

    // リアルタイム価格マップを作成し利確評価を実行
    const priceMap: Record<string, number> = {};
    for (const tick of ticks) {
      priceMap[tick.symbol.toUpperCase()] = tick.price;
    }
    runInBackground(executionEngine.handlePrices(priceMap));

    for (const tick of ticks) {
      if (!config.includeOutcomes && isOutcomeSymbol(tick.symbol)) continue;
      if (targets && !targets.has(tick.symbol)) continue;
      // 一覧の「現在価格」列と KV 同期の currentPrice が、ブレイクアウト以外のティックでも最新になるよう毎回記録する
      rangeCache.recordPrice(tick.symbol, tick.price);
      const breakouts = breakoutDetector.detect(tick);
      collectHighlights(breakouts, highlighted);
      if (breakouts.length > 0 && priceRangeSyncer.enabled) {
        priceRangeSyncer.queueBreakout(tick.symbol, tick.price, breakouts);
      }
      if (!isInsufficient) {
        const detected = signalEvaluator.evaluate(tick);
        signals.push(...detected);

        // 新規シグナル検知時に即時発注実行 (BOT ON / AUTO_ORDER_ENABLED 時)
        if (detected.length > 0) {
          runInBackground((async () => {
            const botActive = await execStore.isBotEnabled();
            if (botActive) {
              for (const s of detected) {
                await executionEngine.handleSignal({
                  symbol: s.symbol,
                  side: s.side,
                  price: s.price,
                  signalType: s.signalType,
                  targetSizeUsd: defaultOrderUsd,
                });
              }
            }
          })());
        }

        if (dca) {
          const detectedDca = dca.evaluator.evaluate(tick);
          dcaSignals.push(...detectedDca);
          if (detectedDca.length > 0) {
            runInBackground((async () => {
              const botActive = await execStore.isBotEnabled();
              if (botActive) {
                for (const s of detectedDca) {
                  await executionEngine.handleSignal({
                    symbol: s.symbol,
                    side: s.side,
                    price: s.price,
                    signalType: s.signalType,
                    targetSizeUsd: defaultOrderUsd,
                  });
                }
              }
            })());
          }
        }
      }
    }
    // 登録の失敗は SignalRegistrar 内で警告にして握りつぶすため、待たずに実行する
    // (同一メッセージのシグナルは open-queue 通知を 1 回のバッチにまとめる)
    if (signals.length > 0) runInBackground(signalRegistrar.registerMany(signals));
    if (dca && dcaSignals.length > 0) runInBackground(dca.registrar.registerMany(dcaSignals));
    // 1メッセージに複数銘柄が含まれるため、一覧は処理の最後に1回だけ出力する
    // (BREAKOUT_LIST_ENABLED=false のときは出力のみ止める。最高値/最低値の更新自体は上で行われている)
    if (config.listLogEnabled && highlighted.size > 0) {
      const now = Date.now();
      const summary = formatActiveExtremes(
        rangeCache.activeExtremes(now),
        resolveName,
        {
          highlighted,
          color: useColor,
          width: consoleWidth(),
          currentPrices: rangeCache.getAllLatestPrices(),
          now,
        },
      );
      if (summary) console.warn(summary);
    }
  };

  const subscriber = new RedisPriceSubscriber({
    redisUrl: config.redisUrl,
    onLog: (msg) => console.info(msg),
    onError: (err) => console.error(err),
    onPrices: (ticks) => {
      // 終了処理中は新しいメッセージを受け付けない
      if (coordinator.shuttingDown) return;
      // どんな例外でもプロセスを落とさない (1 メッセージの失敗は警告にして次のメッセージへ進む)
      try {
        handleTicks(ticks);
      } catch (e) {
        console.warn(`価格メッセージの処理に失敗しました (監視は継続します): ${formatError(e)}`);
      }
    },
  });
  // 最後に登録 = 終了時に最初に実行される (まず受信を止めてから、タイマーなどを止める)
  coordinator.register("Redis 価格購読の切断", () => subscriber.close());

  if (coordinator.shuttingDown) return;
  await subscriber.start();
}

/** startWorker のオプション */
export interface StartWorkerOptions {
  coordinator?: ShutdownCoordinator;
  exitOnShutdown?: boolean;
}

/**
 * Worker プロセスを起動する。
 * プログラムから呼び出すことも、CLI エントリーポイントとして実行することも可能。
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<ShutdownCoordinator> {
  const coordinator = options.coordinator ??
    new ShutdownCoordinator({ onLog: (msg) => console.info(msg) });
  const exitOnShutdown = options.exitOnShutdown ?? true;

  if (exitOnShutdown) {
    installSignalHandlers(coordinator, DEFAULT_SHUTDOWN_SIGNALS, {
      onLog: (msg) => console.info(msg),
      exit: (code, summary) => {
        console.info(formatShutdownSummary(summary));
        Deno.exit(code);
      },
    });
  }

  try {
    await runWorker(coordinator);
    return coordinator;
  } catch (e) {
    // 起動に失敗しても、確保済みのタイマーなどを片付けてから終了する
    await reportSlackError(e, "worker startup");
    console.warn(`起動に失敗しました: ${formatError(e)}`);
    await coordinator.shutdown("起動失敗");
    if (exitOnShutdown) {
      console.warn("起動に失敗したため、終了コード 1 で終了します");
      Deno.exit(1);
    }
    throw e;
  }
}

if (import.meta.main) {
  installSlackErrorReporter("surge-dip-trader");
  await startWorker();
}
import { installSlackErrorReporter, reportSlackError } from "../shared/slack_error_reporter.ts";
