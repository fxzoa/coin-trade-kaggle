import { INSUFFICIENT_COOLDOWN_KEY } from "../../shared/constants/kv_keys.ts";
import {
  type InsufficientCooldownState,
  parseInsufficientCooldown,
} from "../../shared/domain/kv_flags.ts";
import type { KvReader } from "../../shared/domain/ports.ts";
import { formatJst } from "../../shared/formatting/breakout_log.ts";

/** InsufficientGate の初期化オプション */
export interface InsufficientGateOptions {
  /** KV 読み取り口 (null の場合は常に非停止) */
  kv: KvReader | null;
  /** 現在時刻 (エポックミリ秒) を取得する関数 */
  now?: () => number;
  /** 停止状態への突入時の警告ログ */
  onLog?: (msg: string) => void;
  /** 停止解除時の情報ログ */
  onInfo?: (msg: string) => void;
}

/**
 * Insufficient (証拠金・残高不足等) による自動停止を最上位ゲートとして管理する。
 *
 * open-worker が Hyperliquid から Insufficient エラーを受け取ると KV (system:insufficient_cooldown)
 * に 1 時間の停止フラグがセットされる。本クラスはこれを定期的に読み取ってキャッシュし、
 * メインループ (handleMessage) のティック処理直下で 0 レイテンシ (同期) でシグナル評価をスキップできるようにする。
 * 停止の突入時および復旧時に 1 行サマリーをログ出力し、停止中の個別シグナル見送りログの氾濫を防ぐ。
 */
export class InsufficientGate {
  readonly #kv: KvReader | null;
  readonly #now: () => number;
  readonly #onLog: (msg: string) => void;
  readonly #onInfo: (msg: string) => void;

  #state: InsufficientCooldownState = { active: false };
  #untilMs: number | null = null;
  #wasActive = false;

  constructor(options: InsufficientGateOptions) {
    this.#kv = options.kv;
    this.#now = options.now ?? Date.now;
    this.#onLog = options.onLog ?? console.warn;
    this.#onInfo = options.onInfo ?? console.info;
  }

  /**
   * 同期的に現在 Insufficient 停止中かどうかを判定する。
   * メインループのティック処理で毎ティック即座に評価可能。
   */
  isActive(): boolean {
    if (!this.#state.active) return false;
    const now = this.#now();
    if (this.#untilMs !== null && now >= this.#untilMs) {
      return false;
    }
    return true;
  }

  /** 現在の停止状態オブジェクトを取得する */
  getState(): InsufficientCooldownState {
    return this.#state;
  }

  /**
   * KV から Insufficient 停止フラグを読み込み、状態を更新する。
   * 停止への遷移時 (初回/再突入) および復帰時に 1 行ログを出力する。
   */
  async refresh(): Promise<void> {
    if (!this.#kv) return;
    try {
      const nowMs = this.#now();
      const raw = await this.#kv.get(INSUFFICIENT_COOLDOWN_KEY);
      const state = parseInsufficientCooldown(raw, nowMs);
      this.#state = state;
      this.#untilMs = state.untilIso ? new Date(state.untilIso).getTime() : null;

      const currentlyActive = this.isActive();
      if (currentlyActive && !this.#wasActive) {
        this.#wasActive = true;
        const resumeText = this.#formatResume(state.untilIso);
        this.#onLog(
          `[Insufficient 停止] 証拠金不足等のエラーによる保護停止中のため、シグナル判定・発火を1時間停止します ` +
            `(再開予定: ${resumeText}, 理由: ${state.reason ?? "不明"})`,
        );
      } else if (!currentlyActive && this.#wasActive) {
        this.#wasActive = false;
        const resumeText = this.#formatResume(state.untilIso);
        this.#onInfo(
          `[Insufficient 停止] クールダウン期限 (${resumeText}) を経過したため、シグナル判定・発火を再開します`,
        );
      }
    } catch {
      // KV 取得失敗時は前回の状態を維持し、例外は外に伝播させない
    }
  }

  #formatResume(untilIso?: string): string {
    if (!untilIso) return "1時間以内";
    try {
      const ms = new Date(untilIso).getTime();
      if (!isNaN(ms)) return formatJst(ms);
    } catch {
      // パース失敗時は文字列をそのまま返す
    }
    return untilIso;
  }
}
