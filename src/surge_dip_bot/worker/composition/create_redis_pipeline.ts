import { Redis } from "ioredis";
import type { SignalConfig } from "../../shared/config.ts";
import type { VolumeLookup } from "../../shared/domain/ports.ts";
import type { ErrorLogSinks } from "../../shared/domain/error_log.ts";
import type { SignalCheck } from "../usecase/signal_check.ts";
import { SignalCooldown } from "../usecase/signal_cooldown.ts";
import { ExcludedCoinCheck } from "../usecase/excluded_coin_check.ts";
import { OtherWorkerCoinCheck } from "../usecase/other_worker_coin_check.ts";
import { MinVolumeCheck } from "../usecase/min_volume_check.ts";
import { TradeModeCheck } from "../usecase/trade_mode_check.ts";
import { SignalEligibilityCheck } from "../usecase/signal_eligibility_check.ts";
import { SignalRegistrar } from "../usecase/signal_registrar.ts";
import { RedisSignalRepository } from "../infrastructure/redis_signal_repository.ts";
import { RedisEligibilityRepository } from "../infrastructure/redis_eligibility_repository.ts";
import { RedisPositionRepository } from "../infrastructure/redis_position_repository.ts";
import { DcaPositionCache } from "../usecase/dca_position_cache.ts";
import { DcaEvaluator } from "../usecase/dca_evaluator.ts";
import { DcaEligibilityCheck } from "../usecase/dca_eligibility_check.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";

export interface CreateRedisPipelineOptions extends ErrorLogSinks {
  redisClient: InstanceType<typeof Redis>;
  volumes: VolumeLookup;
  onSkip?: (msg: string) => void;
  now?: () => number;
}

export function createRedisSignalRegistrar(
  config: SignalConfig,
  options: CreateRedisPipelineOptions,
): {
  signalRegistrar: SignalRegistrar;
  signalRepo: RedisSignalRepository;
  tradeModeCheck: TradeModeCheck;
} {
  const now = options.now ?? Date.now;
  const signalRepo = new RedisSignalRepository({
    client: options.redisClient,
    onLog: options.onLog,
    onError: options.onError,
  });

  const tradeModeCheck = new TradeModeCheck(options.redisClient);
  const eligibilityRepo = new RedisEligibilityRepository(options.redisClient);
  const cooldown = new SignalCooldown(config.cooldownSeconds * 1000, now);

  const checks: SignalCheck[] = [
    tradeModeCheck,
    new ExcludedCoinCheck(null),
    new OtherWorkerCoinCheck(null),
    cooldown,
    new MinVolumeCheck({ kv: null, fallbackMinVolumeUsd: config.minVolumeUsd, volumes: options.volumes }),
    new SignalEligibilityCheck(eligibilityRepo, now),
  ];

  const signalRegistrar = new SignalRegistrar({
    repository: signalRepo,
    publisher: null,
    checks,
    onAccepted: (s) => cooldown.mark(s),
    onLog: options.onLog,
    onError: options.onError,
    onSkip: options.onSkip,
    recheckMs: config.recheckSeconds * 1000,
    now: options.now,
  });

  return { signalRegistrar, signalRepo, tradeModeCheck };
}

export function createRedisDcaPipeline(
  config: SignalConfig,
  options: CreateRedisPipelineOptions,
): {
  positions: DcaPositionCache;
  evaluator: DcaEvaluator;
  registrar: SignalRegistrar;
} | null {
  if (!config.dcaEnabled) return null;
  const now = options.now ?? Date.now;
  const positionSource = new RedisPositionRepository(options.redisClient);
  const positions = new DcaPositionCache({
    source: positionSource,
    onLog: options.onLog,
    onError: options.onError,
    onInfo: options.onLog,
  });

  const signalRepo = new RedisSignalRepository({
    client: options.redisClient,
    onLog: options.onLog,
    onError: options.onError,
  });

  const tradeModeCheck = new TradeModeCheck(options.redisClient);
  const eligibilityRepo = new RedisEligibilityRepository(options.redisClient);
  const cooldownSeconds = Math.max(config.dcaPositionsRefreshSeconds, config.cooldownSeconds);
  const cooldown = new SignalCooldown(cooldownSeconds * 1000, now, {
    keyOf: (s: TradeSignal) => `${s.symbol}|${s.side}|${s.signalType}`,
    name: "DCA クールダウン",
  });

  const checks: SignalCheck[] = [
    tradeModeCheck,
    new ExcludedCoinCheck(null),
    cooldown,
    new DcaEligibilityCheck(eligibilityRepo),
  ];

  const registrar = new SignalRegistrar({
    repository: signalRepo,
    publisher: null,
    checks,
    onAccepted: (s) => cooldown.mark(s),
    onLog: options.onLog,
    onError: options.onError,
    onSkip: options.onSkip,
    recheckMs: config.recheckSeconds * 1000,
    now: options.now,
    recheckKeyOf: (s) => `${s.symbol}|${s.side}|${s.signalType}`,
  });

  return {
    positions,
    evaluator: new DcaEvaluator(positions, options.now),
    registrar,
  };
}
