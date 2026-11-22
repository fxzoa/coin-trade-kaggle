import { AppError, formatError, HyperliquidError } from "../../shared/errors.ts";

/** エラー分類・ログに表示する発生元 */
const SERVICE = "HyperliquidWS";

/** WebSocket クライアントの設定 */
export interface WsClientOptions {
  /** 接続先 URL */
  url: string;
  /** メッセージ受信時のコールバック */
  onMessage: (raw: string) => void;
  /** ログ出力コールバック */
  onLog?: (msg: string) => void;
  /** ping 送信間隔 (ms, 既定 50000) */
  pingIntervalMs?: number;
  /** 再接続の初期待機時間 (ms, 既定 1000) */
  reconnectBaseMs?: number;
  /** 再接続の最大待機時間 (ms, 既定 30000) */
  reconnectMaxMs?: number;
  /** この時間以上つながっていた接続を「安定」とみなし、再接続の試行回数を戻す (ms, 既定 30000) */
  stableConnectionMs?: number;
  /** 接続の失敗がこの回数だけ連続したらアラートを 1 回出す (既定 10) */
  alertAfterFailures?: number;
  /** アラート (error レベル) の出力先。省略時は onLog に出す */
  onAlert?: (msg: string) => void;
  /** 0 以上 1 未満の乱数 (再接続待機のジッタ用, テスト用注入, 既定 Math.random) */
  random?: () => number;
  /** 無受信とみなして強制再接続するまでの時間 (ms, 既定 120000 = ping 間隔の約 2 倍) */
  staleTimeoutMs?: number;
  /** 無受信の監視間隔 (ms, 既定 10000) */
  staleCheckIntervalMs?: number;
  /** 現在時刻 (エポックミリ秒, テスト用注入, 既定 Date.now) */
  now?: () => number;
  /** WebSocket 生成関数 (テスト用注入, 既定 new WebSocket) */
  webSocketFactory?: (url: string) => WebSocket;
}

/** 接続の状態 (ログは状態が変わったときにだけ詳細を出す) */
type ConnectionState = "idle" | "connected" | "reconnecting";

/**
 * Hyperliquid の allMids を購読し、切断時に指数バックオフ (ジッタ付き・上限あり) で再接続するクライアント。
 * 接続の失敗が続く間は、切断の詳細を最初の 1 回だけ出し、以降は再接続の試行 (回数と待機時間) のみ出す
 */
export class HyperliquidWsClient {
  private readonly pingIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly stableConnectionMs: number;
  private readonly alertAfterFailures: number;
  private readonly random: () => number;
  private readonly staleTimeoutMs: number;
  private readonly staleCheckIntervalMs: number;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => WebSocket;

  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;
  private state: ConnectionState = "idle";
  /** 現在の接続が確立した時刻 (未接続なら null) */
  private connectedAt: number | null = null;
  /** 安定した接続を挟まずに失敗した連続回数 */
  private consecutiveFailures = 0;
  private alerted = false;
  /** 切断の原因として直前に観測したエラー (切断ログに添える) */
  private lastError: AppError | null = null;

  constructor(private readonly opts: WsClientOptions) {
    this.pingIntervalMs = opts.pingIntervalMs ?? 50_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
    this.stableConnectionMs = opts.stableConnectionMs ?? 30_000;
    this.alertAfterFailures = opts.alertAfterFailures ?? 10;
    this.random = opts.random ?? Math.random;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 120_000;
    this.staleCheckIntervalMs = opts.staleCheckIntervalMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.createSocket = opts.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  /** 接続を開始する */
  connect(): void {
    this.closed = false;
    this.open();
  }

  /** 接続を閉じ、以降は再接続しない */
  close(): void {
    this.closed = true;
    this.stopTimers();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch (e) {
        this.log(`WebSocket のクローズに失敗しました: ${formatError(e, SERVICE)}`);
      }
    }
    this.log("接続を終了しました");
  }

  /** ソケットを生成してイベントを登録する */
  private open(): void {
    this.log(`接続を開始します: ${this.opts.url}`);
    let socket: WebSocket;
    try {
      socket = this.createSocket(this.opts.url);
    } catch (e) {
      this.noteDisconnected(`WebSocket の生成に失敗しました: ${formatError(e, SERVICE)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.onConnected();
      this.send(socket, { method: "subscribe", subscription: { type: "allMids" } });
      this.startPing(socket);
      this.startWatchdog(socket);
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = this.now();
      if (typeof ev.data !== "string") return;
      // 受信側の処理が失敗しても接続と購読は止めない
      try {
        this.opts.onMessage(ev.data);
      } catch (e) {
        this.log(
          `メッセージの処理に失敗しました (接続は継続します): ${formatError(e, SERVICE)}`,
        );
      }
    };
    socket.onerror = (ev: Event) => {
      // 詳細は切断時にまとめて 1 回だけ出す (エラーの直後に必ず close が来る)
      const detail = (ev as ErrorEvent).message || "WebSocket でエラーが発生しました";
      this.lastError = new AppError({ kind: "network", service: SERVICE, message: detail });
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopTimers();
      if (this.closed) return;
      this.noteDisconnected("切断されました");
      this.scheduleReconnect();
    };
  }

  /** JSON を送信する */
  private send(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (e) {
      this.log(`送信に失敗しました: ${formatError(e, SERVICE)}`);
    }
  }

  private startPing(socket: WebSocket): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send(socket, { method: "ping" }), this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  /** 無受信の監視を開始する (接続確立時点を最後の受信とみなす) */
  private startWatchdog(socket: WebSocket): void {
    this.stopWatchdog();
    this.lastMessageAt = this.now();
    this.watchdogTimer = setInterval(() => {
      const silentMs = this.now() - this.lastMessageAt;
      if (silentMs >= this.staleTimeoutMs) this.reconnectStale(socket, silentMs);
    }, this.staleCheckIntervalMs);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /** ping と無受信の監視を止める */
  private stopTimers(): void {
    this.stopPing();
    this.stopWatchdog();
  }

  /**
   * 無受信の接続を破棄して再接続する。半開き接続では close ハンドシェイクが完了しないため、
   * close の完了を待たず、このソケットのイベントを無視する状態にして直ちに再接続を予約する
   */
  private reconnectStale(socket: WebSocket, silentMs: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopTimers();
    try {
      socket.close();
    } catch (e) {
      this.log(`WebSocket のクローズに失敗しました: ${formatError(e, SERVICE)}`);
    }
    this.lastError = new HyperliquidError(`${Math.round(silentMs / 1000)}秒間メッセージを受信していません`, {
      kind: "timeout",
      service: SERVICE,
      code: "WS_STALE_TIMEOUT",
    });
    this.noteDisconnected("無受信のため接続を破棄します");
    this.scheduleReconnect();
  }

  /** 接続が確立したときの処理。復旧した場合は 1 回だけ知らせ、購読と監視を開始する */
  private onConnected(): void {
    const recovered = this.state === "reconnecting";
    this.state = "connected";
    this.connectedAt = this.now();
    this.alerted = false;
    this.log(
      recovered
        ? `再接続しました (試行 ${this.attempt} 回目)。allMids を購読します`
        : "接続しました。allMids を購読します",
    );
  }

  /**
   * 切断・接続失敗を記録する。状態が変わったとき (接続中 → 再接続中、または初回の失敗) にだけ
   * 原因付きで 1 回ログに出し、再接続が続く間の同じ失敗は繰り返さない。
   * 安定した接続だった場合は試行回数と連続失敗を戻す
   */
  private noteDisconnected(reason: string): void {
    if (this.connectedAt !== null && this.now() - this.connectedAt >= this.stableConnectionMs) {
      this.attempt = 0;
      this.consecutiveFailures = 0;
    }
    this.connectedAt = null;
    this.consecutiveFailures++;
    if (this.state !== "reconnecting") {
      const cause = this.lastError ? ` (原因: ${formatError(this.lastError, SERVICE)})` : "";
      this.log(`${reason}${cause}`);
    }
    this.lastError = null;
    this.state = "reconnecting";
    this.alertIfFailuresPersist();
  }

  /** 連続失敗が上限に達したら、アラートを 1 回だけ出す (復旧後に再び数える) */
  private alertIfFailuresPersist(): void {
    if (this.alerted || this.consecutiveFailures < this.alertAfterFailures) return;
    this.alerted = true;
    const message =
      `[${SERVICE}/network] 接続の失敗が ${this.consecutiveFailures} 回連続しています ` +
      `(対処: ネットワークと Hyperliquid の稼働状況を確認してください。自動で再接続を続けます)`;
    (this.opts.onAlert ?? this.opts.onLog)?.(message);
  }

  /** 再接続までの待機時間: 指数的に増やして上限で頭打ちにし、上限の半分〜全量でばらつかせる */
  private reconnectDelay(): number {
    const ceiling = Math.min(this.reconnectBaseMs * 2 ** this.attempt, this.reconnectMaxMs);
    return Math.floor(ceiling / 2 + (this.random() * ceiling) / 2);
  }

  /** 指数バックオフ (ジッタ付き) で再接続を予約する */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelay();
    this.attempt++;
    this.log(`${delay}ms 後に再接続します (試行 ${this.attempt} 回目)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) this.open();
    }, delay);
  }

  private log(msg: string): void {
    this.opts.onLog?.(msg);
  }
}
