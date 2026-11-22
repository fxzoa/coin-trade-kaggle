import type { SignalConfig } from "../../shared/config.ts";
import type { ErrorLogSinks } from "../../shared/domain/error_log.ts";
import { CachedKvReader } from "../infrastructure/cached_kv_reader.ts";
import { D1EligibilityRepository } from "../infrastructure/d1_eligibility_repository.ts";
import {
  D1SignalRepository,
  type SignalInsertKind,
} from "../infrastructure/d1_signal_repository.ts";
import { OpenQueuePublisher } from "../infrastructure/open_queue_publisher.ts";
import type { FetchLike } from "../infrastructure/fetch_like.ts";
import {
  createDependencyResilience,
  type CreateDependencyResilienceOptions,
  type DependencyResilience,
} from "./dependency_resilience.ts";
import type { KvReader, VolumeLookup } from "../../shared/domain/ports.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import { DcaEligibilityCheck } from "../usecase/dca_eligibility_check.ts";
import { ExcludedCoinCheck } from "../usecase/excluded_coin_check.ts";
import { OtherWorkerCoinCheck } from "../usecase/other_worker_coin_check.ts";
import { InsufficientCooldownCheck } from "../usecase/insufficient_cooldown_check.ts";
import { MaintenanceCheck } from "../usecase/maintenance_check.ts";
import { MinVolumeCheck } from "../usecase/min_volume_check.ts";
import type { SignalCheck } from "../usecase/signal_check.ts";
import { SignalCooldown } from "../usecase/signal_cooldown.ts";
import { SignalEligibilityCheck } from "../usecase/signal_eligibility_check.ts";
import { SignalRegistrar, type SignalRegistrarOptions } from "../usecase/signal_registrar.ts";
import { TradeEnabledCheck } from "../usecase/trade_enabled_check.ts";

/** KV の読み取り結果をキャッシュする時間 (ms)。ティックごとに API を叩かないため */
export const KV_CACHE_TTL_MS = 10 * 1000;

/** KV 認証情報が無く、KV の 3 ゲートを実施できないことをドライランのログへ明記する文言 */
const KV_GATES_SKIPPED_NOTE = "トレード有効化/メンテナンス/Insufficient 停止 (KV 認証情報なし)";

/** KV のゲート 3 種を worker と同じ順序 (有効化 → メンテナンス → Insufficient) で返す */
function createKvGateChecks(kv: KvReader, now: () => number): SignalCheck[] {
  return [
    new TradeEnabledCheck(kv),
    new MaintenanceCheck(kv),
    new InsufficientCooldownCheck(kv, now),
  ];
}

/** D1 へ登録できる設定か (SIGNAL_WRITE_ENABLED=true かつ D1 の認証情報が揃う) */
export function canWriteSignals(config: SignalConfig): boolean {
  return config.writeEnabled && config.d1 !== null;
}

/**
 * open-queue へ通知できる設定か
 * (D1 へ登録でき、かつ OPEN_QUEUE_ENABLED=true で CF_ACCOUNT_ID / CF_TRADE_API_TOKEN / OPEN_QUEUE_ID が揃う)。
 * 通知すると open-worker が即座に発注する
 */
export function canPublishOpenQueue(config: SignalConfig): boolean {
  return canWriteSignals(config) && config.openQueueEnabled && config.openQueue !== null;
}

/** open-queue へ通知しない理由 (通知できる場合は null)。ログ用 */
export function openQueueSkipReason(config: SignalConfig): string | null {
  if (!canWriteSignals(config)) return "D1 へ登録しない設定のため";
  if (!config.openQueueEnabled) return "OPEN_QUEUE_ENABLED が true ではないため";
  if (!config.openQueue) return "CF_ACCOUNT_ID / CF_TRADE_API_TOKEN / OPEN_QUEUE_ID が未設定のため";
  return null;
}

/**
 * DCA 用を含む、シグナル登録器の共通の依存。
 * onLog は警告、onError はエラー (省略時は onLog)、onInfo は回復などの情報 (省略時は onLog)。
 * breakers を渡すと依存先ごとの遮断器を他の組み立てと共有できる (省略時は組み立てごとに新規作成)
 */
export interface CreateDcaSignalRegistrarOptions
  extends ErrorLogSinks, Pick<CreateDependencyResilienceOptions, "breakers" | "retry"> {
  /** 通常のスキップのログ */
  onSkip?: (msg: string) => void;
  /** fetch (テストで差し替える) */
  fetchFn?: FetchLike;
  /** 現在時刻 (テストで差し替える) */
  now?: () => number;
  /** 共有の KV 読み取り口 (省略時は config.kv から新規作成) */
  kvReader?: KvReader | null;
}

/** createSignalRegistrar の依存 */
export interface CreateSignalRegistrarOptions extends CreateDcaSignalRegistrarOptions {
  /** 銘柄別の 24H 取引高 */
  volumes: VolumeLookup;
}

/** DCA のクールダウンのキー (銘柄・方向・種別)。DCA_40 / DCA_80 は別々に管理する */
function dcaKeyOf(signal: TradeSignal): string {
  return `${signal.symbol}|${signal.side}|${signal.signalType}`;
}

/** 登録先 (D1) と通知先 (open-queue) の設定警告を出す。書き込み・通知の可否は canWriteSignals / canPublishOpenQueue */
function warnSinkMisconfiguration(config: SignalConfig, onLog: (msg: string) => void): void {
  if (config.writeEnabled && !canWriteSignals(config)) {
    onLog(
      "SIGNAL_WRITE_ENABLED=true ですが CF_ACCOUNT_ID / CF_TRADE_API_TOKEN / D1_DATABASE_ID / " +
        "CF_KV_NAMESPACE_ID のいずれかが未設定のため、ドライランで動作します",
    );
  }
  if (canWriteSignals(config) && config.openQueueEnabled && !config.openQueue) {
    onLog(
      "OPEN_QUEUE_ENABLED=true ですが CF_ACCOUNT_ID / CF_TRADE_API_TOKEN / OPEN_QUEUE_ID の" +
        "いずれかが未設定のため、open-queue へは通知しません",
    );
  }
}

/** KV の読み取り口 (Cloudflare KV 廃止に伴い常に null を返却) */
export function createKvReader(
  _config: SignalConfig,
  _options: CreateDcaSignalRegistrarOptions,
  _resilience: DependencyResilience,
  _now: () => number = Date.now,
): CachedKvReader | null {
  return null;
}

/** 登録器へ渡す、チェック列と登録・通知先以外の部品 */
type RegistrarParts =
  & Pick<
    SignalRegistrarOptions,
    "checks" | "skippedChecks" | "onAccepted" | "recheckKeyOf"
  >
  & { insertKind: SignalInsertKind };

/** 登録先 (D1 / open-queue) の設定とチェック列などから SignalRegistrar を組み立てる */
function assembleRegistrar(
  config: SignalConfig,
  options: CreateDcaSignalRegistrarOptions,
  resilience: DependencyResilience,
  parts: RegistrarParts,
): SignalRegistrar {
  const { insertKind, ...registrarParts } = parts;
  return new SignalRegistrar({
    ...registrarParts,
    repository: canWriteSignals(config) && config.d1
      ? new D1SignalRepository(config.d1, options.fetchFn, insertKind, resilience.d1)
      : null,
    publisher: canPublishOpenQueue(config) && config.openQueue
      ? new OpenQueuePublisher(config.openQueue, options.fetchFn, undefined, resilience.queues)
      : null,
    publishSkipReason: openQueueSkipReason(config) ?? undefined,
    onLog: options.onLog,
    onError: options.onError,
    onSkip: options.onSkip,
    recheckMs: config.recheckSeconds * 1000,
    now: options.now,
  });
}

/**
 * 設定からシグナル登録器を組み立てる。
 *
 * チェックの順序は worker に合わせる:
 * トレード有効化 → メンテナンス → Insufficient 停止 (KV) → 除外銘柄 → クールダウン → 最小取引高 → D1 適格性。
 * 認証情報が無いチェックは実施せず、その名前をドライランのログに明記する。
 * D1 へ登録するのは、SIGNAL_WRITE_ENABLED=true かつ D1 と KV の認証情報が揃うときだけ
 * (KV が無いとゲートを確認できないため、登録しない)。
 * open-queue へ通知するのは、さらに OPEN_QUEUE_ENABLED=true かつ OPEN_QUEUE_ID が揃うときだけ
 * (挿入された行ごとに通知し、open-worker が即座に発注する)。
 *
 * 依存先 (D1 / KV / Queues) ごとに遮断器を 1 つ置く。読み取り (KV GET・D1 SELECT) は 遮断器(再試行) の順、
 * 書き込み (D1 INSERT・open-queue publish) は再試行せず遮断器だけを通す。
 * 遮断器が開くと読み取りが即座に失敗してチェックが検証不能になり、登録も通知もしない。
 * Queues の遮断は D1 の登録を妨げない (別の遮断器)
 */
export function createSignalRegistrar(
  config: SignalConfig,
  options: CreateSignalRegistrarOptions,
): SignalRegistrar {
  const now = options.now ?? Date.now;
  const resilience = createDependencyResilience(options);
  const skippedChecks: string[] = [];
  const kv = options.kvReader !== undefined
    ? options.kvReader
    : createKvReader(config, options, resilience, now);
  const cooldown = new SignalCooldown(config.cooldownSeconds * 1000, now);

  const checks: SignalCheck[] = [];
  if (kv) {
    checks.push(...createKvGateChecks(kv, now));
  } else {
    skippedChecks.push(KV_GATES_SKIPPED_NOTE);
    skippedChecks.push("除外銘柄/最小取引高の KV 上書き (KV 認証情報なし)");
  }
  checks.push(new ExcludedCoinCheck(kv), new OtherWorkerCoinCheck(kv), cooldown);
  checks.push(
    new MinVolumeCheck({ kv, fallbackMinVolumeUsd: config.minVolumeUsd, volumes: options.volumes }),
  );
  if (config.d1) {
    checks.push(
      new SignalEligibilityCheck(
        new D1EligibilityRepository(config.d1, options.fetchFn, resilience.d1),
        now,
      ),
    );
  } else {
    skippedChecks.push("D1 適格性 (D1 認証情報なし)");
  }

  warnSinkMisconfiguration(config, options.onLog);
  return assembleRegistrar(config, options, resilience, {
    insertKind: "ENTRY",
    checks,
    skippedChecks,
    onAccepted: (signal) => cooldown.mark(signal),
  });
}

/**
 * 設定から DCA (ナンピン) 用のシグナル登録器を組み立てる。
 *
 * チェックは トレード有効化 → メンテナンス → Insufficient 停止 (KV) → 除外銘柄 → DCA クールダウン → D1 適格性 (DCA) で、
 * 最小取引高は適用しない (worker の runDcaCheck と同じ)。
 * DCA クールダウンは worker に無い listener 独自の保護で、受理した (登録 / ドライラン / IGNORE) 直後から
 * (銘柄・方向・種別) 単位で max(DCA_POSITIONS_REFRESH_SECONDS, COOLDOWN_SECONDS) 秒、同じ種別を再発火させない。
 * worker の DCA は cron で毎回最新データから判定するためこの窓を持たないが、listener は
 * OPEN ポジションを一定間隔でしか更新しないため、登録直後の古い D1 状態での重複発火を防ぐ。
 * 登録は DCA 用の INSERT (coin・side・signal_type 単位の重複判定) を使い、
 * 再判定の間引きは DCA_40 / DCA_80 が並行して処理できるよう種別を含むキーで行う。
 * 書き込み・通知の可否は通常の登録器と同じ (SIGNAL_WRITE_ENABLED / OPEN_QUEUE_ENABLED)。
 * 設定の警告は createSignalRegistrar が出すため、ここでは出さない
 */
export function createDcaSignalRegistrar(
  config: SignalConfig,
  options: CreateDcaSignalRegistrarOptions,
): SignalRegistrar {
  const now = options.now ?? Date.now;
  const resilience = createDependencyResilience(options);
  const skippedChecks: string[] = [];
  const kv = options.kvReader !== undefined
    ? options.kvReader
    : createKvReader(config, options, resilience, now);
  const cooldownSeconds = Math.max(config.dcaPositionsRefreshSeconds, config.cooldownSeconds);
  const cooldown = new SignalCooldown(cooldownSeconds * 1000, now, {
    keyOf: dcaKeyOf,
    name: "DCA クールダウン",
  });

  const checks: SignalCheck[] = [];
  if (kv) {
    checks.push(...createKvGateChecks(kv, now));
  } else {
    skippedChecks.push(KV_GATES_SKIPPED_NOTE);
    skippedChecks.push("除外銘柄の KV 上書き (KV 認証情報なし)");
  }
  checks.push(new ExcludedCoinCheck(kv), new OtherWorkerCoinCheck(kv), cooldown);
  if (config.d1) {
    checks.push(
      new DcaEligibilityCheck(
        new D1EligibilityRepository(config.d1, options.fetchFn, resilience.d1),
      ),
    );
  } else {
    skippedChecks.push("D1 適格性 (D1 認証情報なし)");
  }

  return assembleRegistrar(config, options, resilience, {
    insertKind: "DCA",
    checks,
    skippedChecks,
    onAccepted: (signal) => cooldown.mark(signal),
    recheckKeyOf: dcaKeyOf,
  });
}
