import { MIN_24H_VOLUME_USD_KEY } from "../../shared/constants/kv_keys.ts";
import { parseMinVolumeOverride } from "../../shared/domain/kv_flags.ts";
import type { KvReader, VolumeLookup } from "../../shared/domain/ports.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import {
  type CheckResult,
  PASS,
  type SignalCheck,
  skip,
  unverifiedFromError,
} from "./signal_check.ts";

/** MinVolumeCheck の依存 */
export interface MinVolumeCheckOptions {
  /** 最小取引高の KV 上書きを読む口。null なら環境変数 / 既定値のみ */
  kv: KvReader | null;
  /** KV が未設定のときの閾値 (環境変数 MIN_24H_VOLUME_USD または既定値, USD) */
  fallbackMinVolumeUsd: number;
  /** 銘柄別の 24H 取引高 */
  volumes: VolumeLookup;
}

/**
 * 24H 取引高 (dayNtlVlm) が最小値に満たない銘柄をスキップする。
 * 閾値は KV (trade:min_24h_volume_usd) → 環境変数 → 既定値 (1,000 万 USD) の順。
 * worker と同じく、取引高が閾値未満 (厳密に小さい) の場合だけスキップする。
 * 取引高が未取得の銘柄は検証できないためスキップし、KV 取得失敗は検証不能にする
 * (worker は失敗時に既定値で続行する)
 */
export class MinVolumeCheck implements SignalCheck {
  readonly name = "最小24H取引高";

  constructor(private readonly options: MinVolumeCheckOptions) {}

  /** 取引高が十分なら通過 */
  async check(signal: TradeSignal): Promise<CheckResult> {
    const { kv, fallbackMinVolumeUsd, volumes } = this.options;
    let minVolume = fallbackMinVolumeUsd;
    try {
      const override = kv ? parseMinVolumeOverride(await kv.get(MIN_24H_VOLUME_USD_KEY)) : null;
      if (override !== null) minVolume = override;
    } catch (e) {
      return unverifiedFromError("最小取引高を KV から読み取れません", e, "KV");
    }

    const volume = volumes.get(signal.symbol);
    if (volume === undefined) {
      return skip(`24H 取引高が不明です (${signal.symbol})`);
    }
    return volume < minVolume
      ? skip(`24H 取引高 ${Math.round(volume)} USD が最小値 ${formatVolumeUsd(minVolume)} 未満です`)
      : PASS;
  }
}

/**
 * 最小取引高などの金額 (USD) を短縮表記する。
 * 例: 10,000,000 → "$10M", 1,500,000 → "$1.5M", 500,000 → "$500K"
 */
export function formatVolumeUsd(val: number): string {
  if (val >= 1e6 && val < 1e9) {
    const m = (val / 1e6).toFixed(1).replace(/\.0$/, "");
    return `$${m}M`;
  }
  if (val >= 1e3 && val < 1e6) {
    const k = (val / 1e3).toFixed(1).replace(/\.0$/, "");
    return `$${k}K`;
  }
  return `${val} USD`;
}
