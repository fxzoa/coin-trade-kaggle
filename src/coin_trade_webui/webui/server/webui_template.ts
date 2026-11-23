/**
 * close-trader-webui: フロントエンド HTML/CSS/JS テンプレート
 * Obsidian Telemetry デザインシステム (Tailwind CSS CDN + Alpine.js)
 */

export function renderCloseWebUI(): string {
  return `<!DOCTYPE html>
<html lang="ja" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Close Trader Dashboard | Hyperliquid DEX</title>
  <meta name="description" content="Hyperliquid DEX 上で稼働するポジション利確・決済履歴ダッシュボード">

  <!-- PWA & Mobile 対応 -->
  <meta name="theme-color" content="#0B0F17">
  <meta name="color-scheme" content="dark">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">

  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <script>
    tailwind.config = {
      darkMode: "class",
      theme: {
        extend: {
          colors: {
            "obsidian": "#0B0F17",
            "surface-1": "#131926",
            "surface-2": "#1A2234",
            "border-base": "#1E293B",
            "border-elevated": "#334155",
            "telemetry": "#38BDF8",
            "emerald-ok": "#10B981",
            "crimson-err": "#F43F5E",
            "amber-warn": "#F59E0B",
          },
          fontFamily: {
            sans: ["Inter", "sans-serif"],
            mono: ["JetBrains Mono", "monospace"],
          },
        },
      },
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js"></script>
  <style>
    [x-cloak] { display: none !important; }
    :root { color-scheme: dark; }
    body {
      background-color: #0B0F17;
      color: #f1f5f9;
      -webkit-tap-highlight-color: transparent;
    }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0B0F17; }
    ::-webkit-scrollbar-thumb { background: #1E293B; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #334155; }
  </style>
</head>
<body class="min-h-screen bg-obsidian text-slate-100 font-sans flex flex-col antialiased selection:bg-telemetry/30 selection:text-telemetry p-1 gap-[4px]" x-data="closeApp()" x-init="init()">

  <!-- ヘッダー -->
  <header class="w-full bg-surface-1 border border-border-base rounded-lg px-2.5 py-1.5 sm:px-4 flex items-center justify-between gap-2">
    <!-- 左側: アイコン + タイトル + ネットワークタグ -->
    <div class="flex items-center gap-2.5 flex-wrap">
      <div class="w-7 h-7 rounded bg-telemetry/10 border border-telemetry/30 flex items-center justify-center text-telemetry shadow-[0_0_12px_-2px_rgba(56,189,248,0.3)]">
        <span class="material-symbols-outlined text-[18px]">close</span>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <h1 class="text-sm font-bold tracking-tight text-white leading-tight">Coin Trade</h1>
        <span class="text-[10px] bg-surface-2 text-telemetry border border-border-elevated px-1.5 py-0.5 rounded font-mono font-semibold tracking-wider">REDIS PUB/SUB</span>
      </div>
    </div>

    <!-- 右側: 更新ボタン & LIVE ステータスバッジ -->
    <div class="flex items-center gap-2 text-xs">
      <!-- 手動更新ボタン -->
      <button
        @click="loadData()"
        class="text-[11px] px-2.5 py-1 rounded font-medium cursor-pointer border border-border-elevated bg-surface-2 text-slate-300 hover:text-white hover:border-telemetry/50 flex items-center gap-1.5 transition-colors"
        title="データを手動再取得"
      >
        <span class="material-symbols-outlined text-[15px]" :class="loading ? 'animate-spin text-telemetry' : ''">refresh</span>
        <span>更新</span>
      </button>

      <!-- LIVE 接続ステータスバッジ -->
      <div
        class="flex items-center gap-1.5 bg-obsidian border border-border-base px-2.5 py-1 rounded text-xs font-medium"
        title="リアルタイムKV同期">
        <span class="w-1.5 h-1.5 rounded-full bg-telemetry shadow-[0_0_8px_rgba(56,189,248,0.7)] animate-pulse"></span>
        <span class="text-telemetry font-mono font-semibold text-[11px]">LIVE</span>
      </div>
    </div>
  </header>

  <!-- メインコンテンツ -->
  <main class="w-full space-y-[4px] flex-1">

    <!-- 統計サマリーカード グリッド (クローズ履歴: 4カラム) -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-[4px]" aria-label="Key Performance Indicators">
      <!-- Card 1: Total Trades -->
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-telemetry/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">総決済回数</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-telemetry/10 text-telemetry border border-telemetry/30">TRADES</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div class="text-lg sm:text-xl font-bold font-mono text-white leading-tight">
            <span x-text="stats.totalTrades ? stats.totalTrades.toLocaleString() : '0'">0</span>
            <span class="text-xs text-slate-400 font-sans font-medium ml-0.5">件</span>
          </div>
          <div class="text-[11px] text-slate-400 flex items-center gap-1 font-mono">
            勝 <strong class="text-emerald-ok" x-text="stats.winTrades || 0">0</strong> / 負 <strong class="text-crimson-err" x-text="stats.lossTrades || 0">0</strong>
          </div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>実行: <strong class="text-slate-300 font-mono">IOC成行</strong></span>
          <span class="text-slate-600">|</span>
          <span>即時決済</span>
        </div>
      </div>

      <!-- Card 2: Win Rate -->
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-emerald-ok/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">決済勝率</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-emerald-ok/10 text-emerald-ok border border-emerald-ok/30">WIN RATE</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div class="text-lg sm:text-xl font-bold font-mono text-white leading-tight">
            <span x-text="(stats.winRatePct || 0).toFixed(1) + '%'">0.0%</span>
          </div>
          <div class="text-[11px] text-slate-400">
            損益プラス比率
          </div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>閾値判定: <strong class="text-slate-300 font-mono">10.0% / 12.36%</strong></span>
        </div>
      </div>

      <!-- Card 3: Total Realized PnL -->
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-purple-400/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">累計確定損益 (PnL)</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-purple-500/10 text-purple-300 border border-purple-500/30">REALIZED</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div
            class="text-lg sm:text-xl font-bold font-mono leading-tight"
            :class="(stats.totalPnlUsd || 0) >= 0 ? 'text-emerald-ok' : 'text-crimson-err'"
            x-text="((stats.totalPnlUsd || 0) >= 0 ? '+$' : '-$') + Math.abs(stats.totalPnlUsd || 0).toFixed(2)"
          >$0.00</div>
          <div class="text-[11px] text-slate-400 font-mono">
            平均 <strong :class="(stats.avgPnlUsd || 0) >= 0 ? 'text-emerald-ok' : 'text-crimson-err'" x-text="((stats.avgPnlUsd || 0) >= 0 ? '+$' : '-$') + Math.abs(stats.avgPnlUsd || 0).toFixed(2)">$0.00</strong>/回
          </div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>Deno KV: <strong class="text-slate-300 font-mono">SQLite WAL</strong></span>
        </div>
      </div>

      <!-- Card 4: Avg Profit % -->
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-amber-warn/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">平均利益率</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-amber-warn/10 text-amber-warn border border-amber-warn/30">AVG GAIN</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div
            class="text-lg sm:text-xl font-bold font-mono leading-tight"
            :class="(stats.avgProfitPct || 0) >= 0 ? 'text-emerald-ok' : 'text-crimson-err'"
            x-text="((stats.avgProfitPct || 0) >= 0 ? '+' : '') + (stats.avgProfitPct || 0).toFixed(2) + '%'"
          >0.00%</div>
          <div class="text-[11px] text-slate-400 font-mono">
            最終: <span class="text-slate-300" x-text="formatLastTime(stats.lastCloseTime)">--:--</span>
          </div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>同期: <span class="text-slate-400 font-mono" x-text="lastRefreshed">--:--:--</span></span>
        </div>
      </div>
    </section>

    <!-- 統計サマリーカード グリッド (注文履歴: 4カラム) -->
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-2" aria-label="Order Statistics">
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-telemetry/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">総注文回数</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-telemetry/10 text-telemetry border border-telemetry/30">ORDERS</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div class="text-lg sm:text-xl font-bold font-mono text-white leading-tight">
            <span x-text="orderStats.totalOrders ? orderStats.totalOrders.toLocaleString() : '0'">0</span>
            <span class="text-xs text-slate-400 font-sans font-medium ml-0.5">件</span>
          </div>
          <div class="text-[11px] text-slate-400 font-mono">
            DRY <strong class="text-amber-warn" x-text="orderStats.dryRunOrders || 0">0</strong>
          </div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>経路: <strong class="text-slate-300 font-mono">Redis Pub/Sub</strong></span>
        </div>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-emerald-ok/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">約定 / 板乗せ</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-emerald-ok/10 text-emerald-ok border border-emerald-ok/30">ACTIVE</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div class="text-lg sm:text-xl font-bold font-mono text-emerald-ok leading-tight">
            <span x-text="((orderStats.filledOrders || 0) + (orderStats.restingOrders || 0)).toLocaleString()">0</span>
            <span class="text-xs text-slate-400 font-sans font-medium ml-0.5">件</span>
          </div>
          <div class="text-[11px] text-slate-400 font-mono">
            約定 <strong class="text-emerald-ok" x-text="orderStats.filledOrders || 0">0</strong> / 指値 <strong class="text-telemetry" x-text="orderStats.restingOrders || 0">0</strong>
          </div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>ステータス: <strong class="text-slate-300 font-mono">filled / resting</strong></span>
        </div>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-purple-400/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">累計注文想定額</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-purple-500/10 text-purple-300 border border-purple-500/30">NOTIONAL</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div class="text-lg sm:text-xl font-bold font-mono text-white leading-tight" x-text="'$' + (orderStats.totalNotionalUsd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })">$0.00</div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>Deno KV: <strong class="text-slate-300 font-mono">order_history</strong></span>
        </div>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2.5 relative overflow-hidden flex flex-col justify-between">
        <div class="absolute top-0 left-0 right-0 h-[2px] bg-crimson-err/90"></div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400 font-medium">失敗 / 拒否</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold bg-crimson-err/10 text-crimson-err border border-crimson-err/30">FAILED</span>
        </div>
        <div class="flex items-baseline justify-between mt-1">
          <div class="text-lg sm:text-xl font-bold font-mono leading-tight" :class="(orderStats.failedOrders || 0) > 0 ? 'text-crimson-err' : 'text-white'">
            <span x-text="orderStats.failedOrders || 0">0</span>
            <span class="text-xs text-slate-400 font-sans font-medium ml-0.5">件</span>
          </div>
          <div class="text-[11px] text-slate-400 font-mono">
            最終: <span class="text-slate-300" x-text="formatLastTime(orderStats.lastOrderTime)">--:--</span>
          </div>
        </div>
        <div class="border-t border-border-base mt-2 pt-1.5 text-[10px] text-slate-500 flex items-center justify-between">
          <span>同期: <span class="text-slate-400 font-mono" x-text="lastRefreshed">--:--:--</span></span>
        </div>
      </div>
    </section>

    <!-- ポジション決済履歴テーブルセクション -->
    <section class="space-y-2">
      <!-- フィルタ・コントロールバー -->
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[18px] text-telemetry">receipt_long</span>
            <span>ポジション決済履歴</span>
          </h2>
          <span class="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-surface-2 text-telemetry border border-border-elevated" x-text="filteredRecords.length + ' 件'">0 件</span>
        </div>

        <div class="flex items-center gap-2 flex-wrap text-xs">
          <!-- 銘柄フィルタ入力 -->
          <div class="relative">
            <input
              type="text"
              x-model="coinFilter"
              placeholder="銘柄検索 (BTC, ETH)"
              class="bg-obsidian border border-border-base rounded px-2.5 py-1 text-xs text-slate-100 placeholder-slate-500 font-mono w-40 sm:w-48 focus:outline-none focus:border-telemetry focus:ring-1 focus:ring-telemetry/30 transition"
            >
          </div>

          <!-- 取得件数セレクタ -->
          <select
            x-model="limit"
            @change="loadData()"
            class="bg-obsidian border border-border-base rounded px-2.5 py-1 text-xs text-slate-200 font-medium focus:outline-none focus:border-telemetry focus:ring-1 focus:ring-telemetry/30 transition cursor-pointer"
          >
            <option value="50">最新 50件</option>
            <option value="100">最新 100件</option>
            <option value="200">最新 200件</option>
            <option value="500">最新 500件</option>
          </select>
        </div>
      </div>

      <!-- テーブルカード -->
      <div class="bg-surface-1 border border-border-base rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead class="bg-obsidian text-slate-400 font-semibold border-b border-border-base text-[11px]">
              <tr>
                <th class="px-3 py-2.5">決済日時 (JST)</th>
                <th class="px-3 py-2.5">銘柄</th>
                <th class="px-3 py-2.5">ポジション</th>
                <th class="px-3 py-2.5">数量</th>
                <th class="px-3 py-2.5">建値 (Entry)</th>
                <th class="px-3 py-2.5">約定決済値 (Exit)</th>
                <th class="px-3 py-2.5">確定利益率</th>
                <th class="px-3 py-2.5">確定損益 (USD)</th>
                <th class="px-3 py-2.5">契機</th>
                <th class="px-3 py-2.5">決済理由</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border-base/70 font-mono text-xs">
              <template x-if="filteredRecords.length === 0">
                <tr>
                  <td colspan="10" class="px-4 py-8 text-center text-slate-500 font-sans">
                    <span x-text="loading ? 'データを読み込み中...' : '決済履歴データがまだありません'"></span>
                  </td>
                </tr>
              </template>
              <template x-for="rec in filteredRecords" :key="rec.id || (rec.timestamp + rec.coin)">
                <tr class="hover:bg-surface-2/60 transition-colors">
                  <!-- 決済日時 -->
                  <td class="px-3 py-2 text-slate-400 text-[11px]" x-text="formatDate(rec.timestamp)"></td>

                  <!-- 銘柄 -->
                  <td class="px-3 py-2 font-bold text-slate-100" x-text="rec.coin"></td>

                  <!-- ポジション (LONG/SHORT) -->
                  <td class="px-3 py-2 font-bold">
                    <span
                      class="px-2 py-0.5 rounded text-[10px] font-bold border"
                      :class="rec.side === 'LONG' ? 'bg-emerald-ok/10 text-emerald-ok border-emerald-ok/30' : 'bg-crimson-err/10 text-crimson-err border-crimson-err/30'"
                      x-text="rec.side"
                    ></span>
                  </td>

                  <!-- 数量 -->
                  <td class="px-3 py-2 text-slate-200" x-text="Number(rec.size).toLocaleString(undefined, { maximumFractionDigits: 6 })"></td>

                  <!-- 建値 -->
                  <td class="px-3 py-2 text-slate-400" x-text="'$' + Number(rec.entryPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })"></td>

                  <!-- 約定決済値 -->
                  <td class="px-3 py-2 font-bold text-slate-100" x-text="'$' + Number(rec.exitPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })"></td>

                  <!-- 確定利益率 -->
                  <td
                    class="px-3 py-2 font-bold"
                    :class="rec.profitPct >= 0 ? 'text-emerald-ok' : 'text-crimson-err'"
                    x-text="(rec.profitPct >= 0 ? '+' : '') + Number(rec.profitPct).toFixed(2) + '%'"
                  ></td>

                  <!-- 確定損益 (USD) -->
                  <td
                    class="px-3 py-2 font-bold"
                    :class="rec.pnlUsd >= 0 ? 'text-emerald-ok' : 'text-crimson-err'"
                    x-text="(rec.pnlUsd >= 0 ? '+$' : '-$') + Math.abs(Number(rec.pnlUsd)).toFixed(2)"
                  ></td>

                  <!-- 契機 (EVENT/POLL) -->
                  <td class="px-3 py-2">
                    <span
                      class="px-1.5 py-0.5 rounded text-[9px] font-bold border"
                      :class="rec.source === 'EVENT' ? 'bg-telemetry/10 text-telemetry border-telemetry/30' : 'bg-purple-500/10 text-purple-300 border-purple-500/30'"
                      x-text="rec.source || 'EVENT'"
                    ></span>
                  </td>

                  <!-- 決済理由 -->
                  <td class="px-3 py-2 text-slate-400 font-sans text-[11px]" x-text="rec.reason || '-'"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 注文履歴テーブルセクション -->
    <section class="space-y-2">
      <!-- フィルタ・コントロールバー -->
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[18px] text-emerald-ok">list_alt</span>
            <span>注文履歴</span>
          </h2>
          <span class="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-surface-2 text-emerald-ok border border-border-elevated" x-text="filteredOrderRecords.length + ' 件'">0 件</span>
        </div>

        <div class="flex items-center gap-2 flex-wrap text-xs">
          <div class="relative">
            <input
              type="text"
              x-model="coinFilter"
              placeholder="銘柄検索 (BTC, ETH)"
              class="bg-obsidian border border-border-base rounded px-2.5 py-1 text-xs text-slate-100 placeholder-slate-500 font-mono w-40 sm:w-48 focus:outline-none focus:border-telemetry focus:ring-1 focus:ring-telemetry/30 transition"
            >
          </div>
          <select
            x-model="limit"
            @change="loadData()"
            class="bg-obsidian border border-border-base rounded px-2.5 py-1 text-xs text-slate-200 font-medium focus:outline-none focus:border-telemetry focus:ring-1 focus:ring-telemetry/30 transition cursor-pointer"
          >
            <option value="50">最新 50件</option>
            <option value="100">最新 100件</option>
            <option value="200">最新 200件</option>
            <option value="500">最新 500件</option>
          </select>
        </div>
      </div>

      <!-- テーブルカード -->
      <div class="bg-surface-1 border border-border-base rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead class="bg-obsidian text-slate-400 font-semibold border-b border-border-base text-[11px]">
              <tr>
                <th class="px-3 py-2.5">注文日時 (JST)</th>
                <th class="px-3 py-2.5">銘柄</th>
                <th class="px-3 py-2.5">売買</th>
                <th class="px-3 py-2.5">ステータス</th>
                <th class="px-3 py-2.5">指値価格</th>
                <th class="px-3 py-2.5">数量</th>
                <th class="px-3 py-2.5">想定額 (USD)</th>
                <th class="px-3 py-2.5">発行元 BOT</th>
                <th class="px-3 py-2.5">OID / 詳細</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border-base/70 font-mono text-xs">
              <template x-if="filteredOrderRecords.length === 0">
                <tr>
                  <td colspan="9" class="px-4 py-8 text-center text-slate-500 font-sans">
                    <span x-text="loading ? 'データを読み込み中...' : '注文履歴データがまだありません'"></span>
                  </td>
                </tr>
              </template>
              <template x-for="ord in filteredOrderRecords" :key="ord.id || (ord.timestamp + ord.requestId)">
                <tr class="hover:bg-surface-2/60 transition-colors">
                  <td class="px-3 py-2 text-slate-400 text-[11px]" x-text="formatDate(ord.timestamp)"></td>
                  <td class="px-3 py-2 font-bold text-slate-100" x-text="ord.coin"></td>
                  <td class="px-3 py-2 font-bold">
                    <span
                      class="px-2 py-0.5 rounded text-[10px] font-bold border"
                      :class="ord.side === 'BUY' ? 'bg-emerald-ok/10 text-emerald-ok border-emerald-ok/30' : 'bg-crimson-err/10 text-crimson-err border-crimson-err/30'"
                      x-text="ord.side"
                    ></span>
                  </td>
                  <td class="px-3 py-2">
                    <span
                      class="px-1.5 py-0.5 rounded text-[10px] font-bold border uppercase"
                      :class="orderStatusClass(ord.status)"
                      x-text="ord.status"
                    ></span>
                  </td>
                  <td class="px-3 py-2 text-slate-100" x-text="'$' + Number(ord.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })"></td>
                  <td class="px-3 py-2 text-slate-200" x-text="Number(ord.size).toLocaleString(undefined, { maximumFractionDigits: 6 })"></td>
                  <td class="px-3 py-2 text-slate-200" x-text="'$' + Number(ord.notionalUsd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })"></td>
                  <td class="px-3 py-2 text-slate-300 text-[11px]" x-text="ord.botId || ord.source || '-'"></td>
                  <td class="px-3 py-2 text-[11px]" :class="ord.error ? 'text-crimson-err font-sans' : 'text-slate-400'" x-text="ord.error ? ord.error : (ord.oid ? 'OID:' + ord.oid : (ord.cloid || '-'))"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>

  </main>

  <!-- フッター -->
  <footer class="w-full bg-surface-1 border border-border-base rounded-lg px-3 py-1.5 flex items-center justify-between text-[11px] text-slate-400">
    <div class="flex items-center gap-2">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-ok shadow-[0_0_6px_rgba(16,185,129,0.7)]"></span>
      <span class="font-mono text-slate-300">close-trader-webui (Port 8013)</span>
      <span class="text-slate-600">•</span>
      <span class="text-slate-400">Zero-Secret Architecture</span>
    </div>
    <div class="text-slate-500 font-mono text-[10px]">
      Hyperliquid L1 Network
    </div>
  </footer>

  <!-- エラー通知ポップアップ (非ブロッキング Toast) -->
  <div
    x-cloak
    x-show="errorPopup.visible"
    x-transition:enter="transition ease-out duration-200"
    x-transition:enter-start="opacity-0 translate-y-2"
    x-transition:enter-end="opacity-100 translate-y-0"
    x-transition:leave="transition ease-in duration-150"
    x-transition:leave-start="opacity-100 translate-y-0"
    x-transition:leave-end="opacity-0 translate-y-2"
    role="alert"
    class="fixed top-4 right-4 z-50 w-[min(92vw,420px)] bg-surface-1 border border-crimson-err/60 rounded-lg shadow-[0_8px_30px_rgba(244,63,94,0.28)] p-3.5 text-xs text-slate-100"
  >
    <div class="flex items-start gap-2.5">
      <span class="material-symbols-outlined text-crimson-err text-[20px] shrink-0 mt-0.5">error</span>
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-bold text-crimson-err tracking-tight truncate" x-text="errorPopup.title"></h3>
          <span class="text-[10px] font-mono text-slate-400 shrink-0" x-text="errorPopup.time"></span>
        </div>
        <p class="mt-1 text-slate-200 leading-relaxed break-words" x-text="errorPopup.message"></p>
        <div class="mt-2.5 flex items-center justify-end gap-2">
          <button
            @click="loadData()"
            class="px-2.5 py-1 rounded bg-surface-2 hover:bg-border-elevated border border-border-base text-[11px] font-mono text-slate-200 cursor-pointer transition-colors"
          >再取得</button>
          <button
            @click="dismissErrorPopup()"
            class="px-2.5 py-1 rounded bg-crimson-err/15 hover:bg-crimson-err/25 border border-crimson-err/40 text-[11px] font-mono text-crimson-err cursor-pointer transition-colors"
          >閉じる</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Alpine.js アプリケーションステート & ロジック -->
  <script>
    function closeApp() {
      return {
        activeTab: 'close',
        records: [],
        stats: {},
        orderRecords: [],
        orderStats: {},
        coinFilter: '',
        limit: 100,
        loading: false,
        lastRefreshed: '--:--:--',
        errorPopup: {
          visible: false,
          title: '',
          message: '',
          time: '',
        },

        showErrorPopup(title, message) {
          const now = new Date();
          const hh = String(now.getHours()).padStart(2, '0');
          const mm = String(now.getMinutes()).padStart(2, '0');
          const ss = String(now.getSeconds()).padStart(2, '0');
          this.errorPopup = {
            visible: true,
            title: title || 'データ取得エラー',
            message: message || 'データの取得に失敗しました。',
            time: hh + ':' + mm + ':' + ss,
          };
        },

        dismissErrorPopup() {
          this.errorPopup.visible = false;
        },

        get filteredRecords() {
          const q = (this.coinFilter || '').trim().toUpperCase();
          if (!q) return this.records;
          return this.records.filter(r => (r.coin || '').toUpperCase().includes(q));
        },

        get filteredOrderRecords() {
          const q = (this.coinFilter || '').trim().toUpperCase();
          if (!q) return this.orderRecords;
          return this.orderRecords.filter(r => (r.coin || '').toUpperCase().includes(q));
        },

        orderStatusClass(status) {
          switch (status) {
            case 'filled':
              return 'bg-emerald-ok/15 text-emerald-ok border-emerald-ok/40';
            case 'resting':
              return 'bg-telemetry/15 text-telemetry border-telemetry/40';
            case 'dry_run':
              return 'bg-amber-warn/15 text-amber-warn border-amber-warn/40';
            case 'skipped':
              return 'bg-slate-500/15 text-slate-400 border-slate-500/40';
            default:
              return 'bg-crimson-err/15 text-crimson-err border-crimson-err/40';
          }
        },

        async init() {
          await this.loadData();
          this.connectStream();
          setInterval(() => this.loadData(), 30000);
        },

        connectStream() {
          try {
            const es = new EventSource('api/stream');
            es.addEventListener('order', (ev) => {
              try {
                const rec = JSON.parse(ev.data);
                this.orderRecords = [rec, ...this.orderRecords.filter((r) => r.id !== rec.id)].slice(0, Number(this.limit) || 100);
                this.lastRefreshed = new Date().toLocaleTimeString('ja-JP');
                this.refreshStatsOnly();
              } catch (e) {
                console.warn('SSE order parse error:', e);
              }
            });
            es.addEventListener('close', (ev) => {
              try {
                const rec = JSON.parse(ev.data);
                this.records = [rec, ...this.records.filter((r) => r.id !== rec.id)].slice(0, Number(this.limit) || 100);
                this.lastRefreshed = new Date().toLocaleTimeString('ja-JP');
                this.refreshStatsOnly();
              } catch (e) {
                console.warn('SSE close parse error:', e);
              }
            });
          } catch (e) {
            console.warn('SSE connection failed:', e);
          }
        },

        async refreshStatsOnly() {
          try {
            const [statsRes, orderStatsRes] = await Promise.all([
              fetch('api/stats'),
              fetch('api/order-stats'),
            ]);
            if (statsRes.ok) {
              const d = await statsRes.json();
              this.stats = d.stats || {};
            }
            if (orderStatsRes.ok) {
              const d = await orderStatsRes.json();
              this.orderStats = d.stats || {};
            }
          } catch {
            // ignore
          }
        },

        async loadData() {
          this.loading = true;
          try {
            const coinParam = this.coinFilter.trim()
              ? '&coin=' + encodeURIComponent(this.coinFilter.trim())
              : '';
            const histUrl = 'api/history?limit=' + this.limit + coinParam;
            const ordersUrl = 'api/orders?limit=' + this.limit + coinParam;

            const [histRes, statsRes, ordersRes, orderStatsRes] = await Promise.all([
              fetch(histUrl),
              fetch('api/stats'),
              fetch(ordersUrl),
              fetch('api/order-stats')
            ]);

            const failedEndpoints = [];
            const invalidResponses = [];

            if (histRes.ok) {
              const histData = await histRes.json();
              if (histData && Array.isArray(histData.records)) {
                this.records = histData.records;
              } else {
                invalidResponses.push('api/history');
              }
            } else {
              failedEndpoints.push('api/history (' + histRes.status + ')');
            }

            if (statsRes.ok) {
              const statsData = await statsRes.json();
              if (statsData && typeof statsData.stats === 'object' && statsData.stats !== null) {
                this.stats = statsData.stats;
              } else {
                invalidResponses.push('api/stats');
              }
            } else {
              failedEndpoints.push('api/stats (' + statsRes.status + ')');
            }

            if (ordersRes.ok) {
              const ordersData = await ordersRes.json();
              if (ordersData && Array.isArray(ordersData.records)) {
                this.orderRecords = ordersData.records;
              } else {
                invalidResponses.push('api/orders');
              }
            } else {
              failedEndpoints.push('api/orders (' + ordersRes.status + ')');
            }

            if (orderStatsRes.ok) {
              const orderStatsData = await orderStatsRes.json();
              if (orderStatsData && typeof orderStatsData.stats === 'object' && orderStatsData.stats !== null) {
                this.orderStats = orderStatsData.stats;
              } else {
                invalidResponses.push('api/order-stats');
              }
            } else {
              failedEndpoints.push('api/order-stats (' + orderStatsRes.status + ')');
            }

            this.lastRefreshed = new Date().toLocaleTimeString('ja-JP');

            if (failedEndpoints.length > 0) {
              this.showErrorPopup('API 取得エラー', '以下のエンドポイントの取得に失敗しました: ' + failedEndpoints.join(', '));
            } else if (invalidResponses.length > 0) {
              this.showErrorPopup('データ形式エラー', '以下のエンドポイントのレスポンス形式が不正です: ' + invalidResponses.join(', '));
            } else {
              this.dismissErrorPopup();
            }
          } catch (err) {
            console.error('データ取得エラー:', err);
            this.showErrorPopup('通信エラー', 'サーバーからのデータ取得に失敗しました: ' + (err instanceof Error ? err.message : String(err)));
          } finally {
            this.loading = false;
          }
        },

        formatDate(ts) {
          if (!ts) return '--';
          const d = new Date(ts);
          return d.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' }) + ' ' +
                 d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        },

        formatLastTime(ts) {
          if (!ts) return '--';
          const d = new Date(ts);
          return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        }
      };
    }
  </script>
</body>
</html>
`;
}
