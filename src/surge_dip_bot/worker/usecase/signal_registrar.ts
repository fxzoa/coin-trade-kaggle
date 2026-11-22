import { ERROR_KIND_POLICY, type ErrorKind } from "../../shared/errors.ts";
import { type ErrorLogSinks, logAtLevel, logFailure } from "../../shared/domain/error_log.ts";
import { formatSignal } from "../../shared/formatting/signal_log.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import { toOpenQueueMessage } from "../../shared/domain/open_queue_message.ts";
import type { D1SignalRepository } from "../infrastructure/d1_signal_repository.ts";
import type { OpenQueuePublisher } from "../infrastructure/open_queue_publisher.ts";
import type { SignalCheck } from "./signal_check.ts";

/** 同一 (銘柄・方向) を再判定しない間隔の既定値 (ms)。ティックごとの API 呼び出しを防ぐ */
export const DEFAULT_RECHECK_MS = 60 * 1000;

/** SignalRegistrar の依存 */
export interface SignalRegistrarOptions {
  /** 登録先。null の場合はドライラン (ログ出力のみ) */
  repository: Pick<D1SignalRepository, "insert"> | null;
  /**
   * 挿入した行の open-queue 通知先。null / 省略の場合は通知しない
   * (有効にすると open-worker が即座に発注する)
   */
  publisher?: Pick<OpenQueuePublisher, "publish"> | null;
  /** publisher が null のとき、通知を見送る理由 (挿入ごとにログへ出す) */
  publishSkipReason?: string;
  /** 登録前チェック。この順に実行し、最初に通過しなかった時点で打ち切る */
  checks?: readonly SignalCheck[];
  /** 実施できないチェックの名前 (認証情報が無いなど)。ドライランのログに明記する */
  skippedChecks?: readonly string[];
  /** 全チェックを通過し処理した直後の通知 (クールダウンの開始など) */
  onAccepted?: (signal: TradeSignal) => void;
  /** 警告ログ (検出・登録・失敗・検証不能) */
  onLog: (msg: string) => void;
  /** エラーログ (人の対応が要る失敗: 認証エラー・不正な応答など)。省略時は onLog */
  onError?: (msg: string) => void;
  /** 通常のスキップの理由を出力する。省略時は onLog */
  onSkip?: (msg: string) => void;
  /** 同一 (銘柄・方向) を再判定しない間隔 (ms) */
  recheckMs?: number;
  /** 現在時刻 (エポックミリ秒) */
  now?: () => number;
  /**
   * 再判定を間引く単位のキー。省略時は (銘柄・方向) で、種別違いは先頭の 1 件のみ処理する。
   * 種別を並行して処理したい場合 (DCA_40 / DCA_80 の同時発火) は種別を含むキーを渡す
   */
  recheckKeyOf?: (signal: TradeSignal) => string;
}

/**
 * 成立したシグナルを、登録前チェックを通したうえで登録する。
 * チェックを通らない場合は理由をログに出して何もしない。検証不能 (KV/D1 の取得失敗など)
 * の場合も登録しない。同一キー (既定は銘柄・方向。種別に関わらない) は recheckMs の間は 1 回だけ処理する
 * (結果がスキップでも再判定しない。既定では同一ティックに種別違いが来ても先頭の 1 件のみ)。登録の失敗は警告のみで、例外は投げない。
 * 実際に挿入された行 (meta.changes > 0) だけを open-queue へ通知する。通知の失敗は警告のみで、
 * NEW 行は open-worker の定期実行が拾う
 */
export class SignalRegistrar {
  readonly #repository: SignalRegistrarOptions["repository"];
  readonly #publisher: SignalRegistrarOptions["publisher"];
  readonly #publishSkipReason: string;
  readonly #checks: readonly SignalCheck[];
  readonly #skippedChecks: readonly string[];
  readonly #onAccepted: (signal: TradeSignal) => void;
  readonly #onLog: (msg: string) => void;
  readonly #sinks: ErrorLogSinks;
  readonly #onSkip: (msg: string) => void;
  readonly #recheckMs: number;
  readonly #now: () => number;
  readonly #recheckKeyOf: (signal: TradeSignal) => string;
  /** 判定キー → 判定時刻 (ms) */
  readonly #attemptedAt = new Map<string, number>();

  constructor(options: SignalRegistrarOptions) {
    this.#repository = options.repository;
    this.#publisher = options.publisher ?? null;
    this.#publishSkipReason = options.publishSkipReason ?? "通知先が未設定";
    this.#checks = options.checks ?? [];
    this.#skippedChecks = options.skippedChecks ?? [];
    this.#onAccepted = options.onAccepted ?? (() => {});
    this.#onLog = options.onLog;
    this.#sinks = { onLog: options.onLog, onError: options.onError };
    this.#onSkip = options.onSkip ?? options.onLog;
    this.#recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
    this.#now = options.now ?? Date.now;
    this.#recheckKeyOf = options.recheckKeyOf ?? keyOf;
  }

  /** チェック → 登録 (またはドライランのログ出力) を行う。重複・失敗時も例外は投げない */
  async register(signal: TradeSignal): Promise<void> {
    await this.registerMany([signal]);
  }

  /**
   * 同一ティックの複数シグナルをまとめて処理する。
   * 登録は並行して行い、挿入された行の open-queue 通知は 1 回のバッチ送信にまとめる。
   * 既定では同一 (銘柄・方向) は種別が違っても先頭の 1 件だけを処理するため、二重に通知しない
   */
  async registerMany(signals: readonly TradeSignal[]): Promise<void> {
    const results = await Promise.all(signals.map((signal) => this.#process(signal)));
    const inserted = results.filter((s): s is TradeSignal => s !== null);
    if (inserted.length > 0) await this.#publish(inserted);
  }

  /** 1 件を処理し、D1 に実際に挿入できた場合だけそのシグナルを返す */
  async #process(signal: TradeSignal): Promise<TradeSignal | null> {
    const now = this.#now();
    const key = this.#recheckKeyOf(signal);
    const attempted = this.#attemptedAt.get(key);
    if (attempted !== undefined && now - attempted < this.#recheckMs) return null;
    // チェックの完了を待つ間に同じシグナルが来ても重複しないよう、先に記録する
    this.#attemptedAt.set(key, now);

    for (const check of this.#checks) {
      const result = await check.check(signal);
      if (result.ok) continue;
      if (result.kind === "unverified") {
        const msg = `シグナルを見送りました [${check.name}]: ${signal.symbol} ${signal.side} ` +
          `${signal.signalType} - ${result.reason} (検証できないため登録しません)`;
        this.#logUnverified(msg, result.errorKind);
      }
      return null;
    }

    this.#onLog(formatSignal(signal, "detected"));

    if (!this.#repository) {
      this.#onLog(formatSignal(signal, "dry-run", this.#dryRunNote()));
      this.#onAccepted(signal);
      return null;
    }
    try {
      const inserted = await this.#repository.insert(signal);
      // worker と同様、IGNORE された行でもクールダウンは開始する
      this.#onAccepted(signal);
      if (!inserted) {
        this.#onLog(
          `既存の NEW シグナルと重複するため登録しませんでした (IGNORE): ${signal.symbol} ` +
            `${signal.side} ${signal.signalType}`,
        );
        return null;
      }
      this.#onLog(formatSignal(signal, "registered"));
      return signal;
    } catch (e) {
      logFailure(
        this.#sinks,
        e,
        "D1",
        `シグナルの登録に失敗しました (監視は継続します): ${signal.symbol} ${signal.signalType}`,
      );
      return null;
    }
  }

  /** 挿入済みシグナルを open-queue へ通知する。失敗しても例外は投げない */
  async #publish(inserted: readonly TradeSignal[]): Promise<void> {
    if (!this.#publisher) {
      for (const s of inserted) {
        this.#onLog(
          `open-queue への通知を見送りました (${this.#publishSkipReason}): ${s.symbol} ` +
            `${s.side} ${s.signalType} (open-worker の定期実行が処理します)`,
        );
      }
      return;
    }
    try {
      const result = await this.#publisher.publish(inserted.map(toOpenQueueMessage));
      if (result.failed > 0) {
        this.#logAtKind(
          `${result.error ?? "[Queues/unknown] 原因不明"} - ` +
            `open-queue への通知に失敗しました (NEW 行は残るため定期実行が処理します): ` +
            `成功=${result.sent}件 失敗=${result.failed}件`,
          result.errorKind,
        );
      } else {
        this.#onLog(`open-queue へ通知しました: ${result.sent}件`);
      }
    } catch (e) {
      logFailure(
        this.#sinks,
        e,
        "Queues",
        "open-queue への通知で予期しないエラーが発生しました (監視は継続します)",
      );
    }
  }

  /**
   * 検証不能のログを出す。遮断器が開いている間 (circuit_open) は遮断器が通知済みなので静かに (onSkip)、
   * それ以外は失敗の種別に応じたレベルで出す
   */
  #logUnverified(message: string, errorKind: ErrorKind | undefined): void {
    if (errorKind === "circuit_open") this.#onSkip(message);
    else this.#logAtKind(message, errorKind);
  }

  /** 失敗の種別に応じたレベル (不明なら warn) でログを出す */
  #logAtKind(message: string, errorKind: ErrorKind | undefined): void {
    logAtLevel(this.#sinks, errorKind ? ERROR_KIND_POLICY[errorKind].logLevel : "warn", message);
  }

  /** ドライランのログに添える、チェックの実施状況 */
  #dryRunNote(): string {
    return this.#skippedChecks.length > 0
      ? `未実施チェック: ${this.#skippedChecks.join(" / ")} (worker 同等の検証は未完了)`
      : "全チェック通過";
  }
}

/** 重複排除のキー (銘柄・方向)。D1 側の NEW 重複判定と同じ粒度に揃える */
function keyOf(signal: TradeSignal): string {
  return `${signal.symbol}|${signal.side}`;
}
