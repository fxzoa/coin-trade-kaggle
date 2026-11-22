import type { SignalSide, TradeSignal } from "./trade_signal.ts";

/**
 * open-queue へ送るメッセージ本文 (buyer-worker / seller-worker の TradeSignal と同形)。
 * open-worker は `coin` だけを参照し、注文は D1 の NEW 行から組み立てるため、
 * 本文は「起こすための合図」であり D1 の signals 行が正である
 */
export interface OpenQueueMessage {
  coin: string;
  action: SignalSide;
  mark_price: number;
  signal_type: string;
  target_size: number;
  source: string;
  timestamp: number;
  /** DCA シグナルでは worker と同じく省略される (JSON に含まれない) */
  changePct?: number;
}

/** 登録したシグナルから open-queue のメッセージ本文を作る */
export function toOpenQueueMessage(signal: TradeSignal): OpenQueueMessage {
  return {
    coin: signal.symbol,
    action: signal.side,
    mark_price: signal.price,
    signal_type: signal.signalType,
    target_size: signal.targetSize,
    source: signal.source,
    timestamp: signal.timestamp,
    changePct: signal.changePct,
  };
}
