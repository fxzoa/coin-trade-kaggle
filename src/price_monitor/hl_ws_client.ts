import type { WsSubscription } from "../shared/price_monitor/types.ts";
import { toError } from "../shared/price_monitor/errors.ts";

export interface HlWsClientOptions {
  url: string;
  subscriptions: WsSubscription[];
  onMessage: (raw: string) => void;
  onLog?: (msg: string) => void;
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class HlWsClient {
  private url: string;
  private subscriptions: WsSubscription[];
  private onMessage: (raw: string) => void;
  private onLog: (msg: string) => void;
  private pingIntervalMs: number;
  private reconnectBaseMs: number;
  private reconnectMaxMs: number;

  private socket: WebSocket | null = null;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private closed = false;

  constructor(opts: HlWsClientOptions) {
    this.url = opts.url;
    this.subscriptions = opts.subscriptions;
    this.onMessage = opts.onMessage;
    this.onLog = opts.onLog ?? console.log;
    this.pingIntervalMs = opts.pingIntervalMs ?? 50_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e: unknown) {
        const error = toError(e);
        this.onLog(`[HL-WS] クローズエラー: ${error.message}`);
      }
      this.socket = null;
    }
    this.onLog("[HL-WS] 接続を終了しました");
  }

  private open(): void {
    this.onLog(`[HL-WS] 接続中: ${this.url}`);
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (e: unknown) {
      const error = toError(e);
      this.onLog(`[HL-WS] WebSocket初期化エラー: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.onLog("[HL-WS] WebSocket接続完了。購読を開始します");

      for (const sub of this.subscriptions) {
        this.send(socket, { method: "subscribe", subscription: sub });
      }

      this.startPing(socket);
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") {
        try {
          this.onMessage(event.data);
        } catch (e: unknown) {
          const error = toError(e);
          this.onLog(`[HL-WS] メッセージハンドラエラー: ${error.message}`);
        }
      }
    };

    socket.onerror = (event: Event) => {
      const err = (event as ErrorEvent).message || "WebSocketエラー";
      this.onLog(`[HL-WS] エラー検出: ${err}`);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      if (!this.closed) {
        this.onLog("[HL-WS] 切断されました。再接続をスケジュールします");
        this.scheduleReconnect();
      }
    };
  }

  private send(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (e: unknown) {
      const error = toError(e);
      this.onLog(`[HL-WS] 送信エラー: ${error.message}`);
    }
  }

  private startPing(socket: WebSocket): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send(socket, { method: "ping" });
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempt, this.reconnectMaxMs);
    this.attempt++;
    this.onLog(`[HL-WS] ${delay}ms 後に再接続します (試行回数: ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) this.open();
    }, delay);
  }
}
