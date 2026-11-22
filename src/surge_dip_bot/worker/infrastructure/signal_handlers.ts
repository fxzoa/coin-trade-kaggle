import type { ShutdownCoordinator, ShutdownSummary } from "../usecase/shutdown.ts";
import { errorMessage } from "../../shared/domain/error_message.ts";

/** 受信対象のシグナル名 */
export type ShutdownSignal = Deno.Signal;

/** 既定で受信するシグナル */
export const DEFAULT_SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];

/** シグナル処理の依存 (テストで差し替える) */
export interface SignalHandlerDeps {
  addSignalListener?: (signal: ShutdownSignal, handler: () => void) => void;
  removeSignalListener?: (signal: ShutdownSignal, handler: () => void) => void;
  /** プロセスを終了する (終了処理の結果も受け取り、サマリーのログ出力に使える) */
  exit?: (code: number, summary: ShutdownSummary) => void;
  onLog?: (message: string) => void;
}

/**
 * シグナルを受けたら ShutdownCoordinator.shutdown を呼び、結果の終了コードでプロセスを終了する。
 * 登録できないシグナル (Windows の SIGTERM など) はログを出して飛ばす。
 * 戻り値の関数で登録したリスナーをすべて外す
 */
export function installSignalHandlers(
  coordinator: ShutdownCoordinator,
  signals: readonly ShutdownSignal[] = DEFAULT_SHUTDOWN_SIGNALS,
  deps: SignalHandlerDeps = {},
): () => void {
  const {
    addSignalListener = Deno.addSignalListener,
    removeSignalListener = Deno.removeSignalListener,
    exit = Deno.exit,
    onLog = () => {},
  } = deps;

  const installed: { signal: ShutdownSignal; handler: () => void }[] = [];
  for (const signal of signals) {
    const handler = () => {
      onLog(`${signal} を受信しました`);
      void coordinator.shutdown(signal).then((summary) => exit(summary.exitCode, summary));
    };
    try {
      addSignalListener(signal, handler);
      installed.push({ signal, handler });
    } catch (e) {
      onLog(`${signal} はこの環境では監視できないため、スキップします: ${errorMessage(e)}`);
    }
  }
  return () => {
    for (const { signal, handler } of installed) removeSignalListener(signal, handler);
  };
}
