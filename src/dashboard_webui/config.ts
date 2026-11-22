/**
 * 統合ダッシュボード 設定ファイル
 */

import { ConfigError } from "../shared/price_monitor/errors.ts";
import { err, ok, type Result } from "../shared/price_monitor/result.ts";

export interface BotServiceConfig {
  key: string;
  name: string;
  category: "Trading" | "Infrastructure";
  description: string;
  targetUrl: string;
  healthEndpoint: string;
  directPort: number;
}

export interface AppConfig {
  port: number;
  host: string;
  bots: BotServiceConfig[];
}

export function parseConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Result<AppConfig, ConfigError> {
  const portStr = env.PORT || "8080";
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    return err(
      new ConfigError(
        `Invalid PORT: '${portStr}'. Must be an integer between 1 and 65535.`,
        { context: { port: portStr } },
      ),
    );
  }

  const host = env.HOST || "0.0.0.0";
  if (!host.trim()) {
    return err(new ConfigError("HOST cannot be empty.", { context: { host } }));
  }

  const bots: BotServiceConfig[] = [
    // === 取引用BOT ===
    {
      key: "grid",
      name: "BTC Grid Trader",
      category: "Trading",
      description: "BTC節目グリッド注文管理・自動リバランス",
      targetUrl: env.URL_BTC_GRID || "http://localhost:8000",
      healthEndpoint: "/health",
      directPort: 8000,
    },
    {
      key: "btc_dca",
      name: "BTC DCA Trader",
      category: "Trading",
      description: "BTC特化型ナンピン・ポジション管理",
      targetUrl: env.URL_BTC_DCA || "http://localhost:8007",
      healthEndpoint: "/api/health",
      directPort: 8007,
    },
    {
      key: "multi_dca",
      name: "Multi DCA Trader",
      category: "Trading",
      description: "複数アルトコイン自動DCAナンピン売買",
      targetUrl: env.URL_MULTI_DCA || "http://localhost:8008",
      healthEndpoint: "/api/health",
      directPort: 8008,
    },
    {
      key: "surge_dip",
      name: "Surge DIP Trader",
      category: "Trading",
      description: "価格急騰・急落(騰落)シグナル連動 取引・利確決済",
      targetUrl: env.URL_SURGE_DIP_TRADE || env.URL_SIGNAL_EVALUATOR || "http://localhost:8004",
      healthEndpoint: "/health",
      directPort: 8004,
    },
    {
      key: "close_trader",
      name: "Close Trader",
      category: "Trading",
      description: "Hyperliquidポジション利確・成行決済 & 履歴",
      targetUrl: env.URL_CLOSE_TRADER || "http://localhost:8013",
      healthEndpoint: "/api/health",
      directPort: 8013,
    },

    // === 基盤用BOT ===
    {
      key: "syncer",
      name: "Price Change Monitor",
      category: "Infrastructure",
      description: "リアルタイム価格同期 & Redis配信基盤",
      targetUrl: env.URL_PRICE_SYNCER || "http://localhost:8005",
      healthEndpoint: "/api/status",
      directPort: 8005,
    },
    {
      key: "volume_alert",
      name: "Volume Change Monitor",
      category: "Infrastructure",
      description: "1H/2H出来高急増 (6.18x) 監視・Slack通知 & WebUI",
      targetUrl: env.URL_CANDLE_VOLUME_ALERT || "http://localhost:8009",
      healthEndpoint: "/api/health",
      directPort: 8009,
    },
    {
      key: "slack_alert",
      name: "Slack Alert Sender",
      category: "Infrastructure",
      description: "Slack通知キュー処理 送信履歴 WebUI",
      targetUrl: env.URL_SLACK_ALERT || "http://localhost:8010",
      healthEndpoint: "/api/health",
      directPort: 8010,
    },
  ];

  return ok({ port, host, bots });
}

export function loadConfig(env?: Record<string, string | undefined>): AppConfig {
  const result = parseConfig(env);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
