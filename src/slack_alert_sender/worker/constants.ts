/**
 * 定数定義 (Constants)
 */

export const C_WORKER = "[slack-alert-deno]";

// デフォルトのSlackチャンネルID定義 (Python実装・alert-workerと互換)
export const DEFAULT_CHANNELS = {
  NOTIFY: "C066VHECJ7R",
  ERROR: "C063VF2H8ES",
  BUY: "C06445Q9VA8",
  SELL: "C067GQ7SM5F",
  CLOSE_PLUS: "C0644H4P84U",
  CLOSE_MINUS: "C066PJS0QEB",
  ORD_OPEN: "C04JW4TBMU6",
  ORD_TP: "C067CQ8CJ3W",
} as const;

export const DEFAULT_REDIS_QUEUE_KEY = "slack:alert:queue";
