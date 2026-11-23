/**
 * dca-deno: WebUI HTML テンプレート
 * Alpine.js & Tailwind CSS によるリアルタイム DCA モニター & 発注管理
 */

export function renderWebUI(): string {
  return `<!DOCTYPE html>
<html lang="ja" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Multi DCA Trader - dca-deno</title>

  <!-- PWA & Mobile 対応 -->
  <meta name="theme-color" content="#0B0F17">
  <meta name="color-scheme" content="dark">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
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
      color: #F1F5F9;
      -webkit-tap-highlight-color: transparent;
    }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0B0F17; }
    ::-webkit-scrollbar-thumb { background: #1E293B; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #334155; }
  </style>
</head>
<body class="min-h-screen bg-obsidian text-slate-100 font-sans flex flex-col antialiased selection:bg-telemetry/30 selection:text-telemetry p-1 gap-[4px]" x-data="dcaApp()" x-init="init()">

  <!-- ヘッダー -->
  <header class="w-full bg-[#0E131F]/95 backdrop-blur-md border border-border-base rounded-lg px-2.5 py-1.5 sm:px-4 flex items-center justify-between gap-2 sticky top-0 z-20">
    <!-- 左側: アイコン + タイトル -->
    <div class="flex items-center gap-2.5 flex-wrap">
      <div class="w-7 h-7 rounded bg-telemetry/10 border border-telemetry/30 flex items-center justify-center text-telemetry shadow-[0_0_12px_-2px_rgba(56,189,248,0.3)] shrink-0">
        <span class="material-symbols-outlined text-[18px]">bolt</span>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <div class="flex flex-col">
          <h1 class="text-sm font-bold tracking-tight text-white leading-tight">Multi DCA Trader</h1>
          <span class="text-[9px] font-mono uppercase tracking-widest text-telemetry leading-none">Obsidian Telemetry</span>
        </div>

        <!-- タブ切り替えボタン -->
        <div class="flex items-center space-x-1 ml-1 bg-obsidian border border-border-base p-0.5 rounded-lg">
          <button
            type="button"
            @click="currentTab = 'dca'"
            class="px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1"
            :class="currentTab === 'dca' ? 'bg-telemetry/15 text-telemetry border border-telemetry/30' : 'text-slate-400 hover:text-slate-100 border border-transparent'"
          >
            <span class="material-symbols-outlined text-[14px]">monitoring</span>
            <span>DCA監視 &amp; 発注</span>
          </button>
          <button
            type="button"
            @click="currentTab = 'drop'; loadChartData()"
            class="px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1"
            :class="currentTab === 'drop' ? 'bg-crimson-err/15 text-crimson-err border border-crimson-err/30' : 'text-slate-400 hover:text-slate-100 border border-transparent'"
          >
            <span class="material-symbols-outlined text-[14px]">trending_down</span>
            <span>高値からの下落率</span>
          </button>
          <button
            type="button"
            @click="currentTab = 'rise'; loadChartData()"
            class="px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1"
            :class="currentTab === 'rise' ? 'bg-emerald-ok/15 text-emerald-ok border border-emerald-ok/30' : 'text-slate-400 hover:text-slate-100 border border-transparent'"
          >
            <span class="material-symbols-outlined text-[14px]">trending_up</span>
            <span>安値からの上昇率</span>
          </button>
          <button
            type="button"
            @click="currentTab = 'errors'; fetchErrors()"
            class="px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1"
            :class="currentTab === 'errors' ? 'bg-crimson-err/15 text-crimson-err border border-crimson-err/30' : 'text-rose-400 hover:text-rose-300 border border-transparent'"
          >
            <span class="material-symbols-outlined text-[14px]">error_outline</span>
            <span>エラーログ</span>
            <span class="px-1.5 py-0.2 bg-surface-2 border border-border-base rounded font-mono text-[9px] tabular-nums" x-text="errorLogs.length"></span>
          </button>
        </div>
      </div>
    </div>

    <!-- 右側: BOT スイッチ & LIVE ステータスバッジ -->
    <div class="flex items-center gap-2 text-xs shrink-0">
      <!-- BOT ON/OFF トグルスイッチ -->
      <button
        @click="toggleBot()"
        class="text-[11px] px-2.5 py-1 rounded-lg font-mono font-semibold cursor-pointer border flex items-center gap-1.5 transition-colors"
        :class="botEnabled ? 'bg-emerald-ok/10 border-emerald-ok/40 text-emerald-ok hover:bg-emerald-ok/20' : 'bg-surface-1 border-border-base text-slate-400 hover:bg-surface-2'"
        :title="'BOTステータス: ' + (botEnabled ? '稼働中 (クリックで停止)' : '停止中 (クリックで再開)')"
      >
        <span class="w-1.5 h-1.5 rounded-full" :class="botEnabled ? 'bg-emerald-ok shadow-[0_0_6px_#10B981] animate-pulse' : 'bg-slate-500'"></span>
        <span>BOT</span>
      </button>

      <!-- LIVE 接続ステータスバッジ -->
      <div
        class="flex items-center space-x-1.5 bg-surface-1 border border-border-base px-2.5 py-1 rounded-lg text-xs font-medium"
        :title="'リアルタイム接続: ' + (sseConnected ? 'LIVE接続中' : '切断 (再接続試行中)')">
        <span class="w-1.5 h-1.5 rounded-full" :class="sseConnected ? 'bg-telemetry shadow-[0_0_6px_#38BDF8] animate-pulse' : 'bg-crimson-err'"></span>
        <span :class="sseConnected ? 'text-telemetry font-mono font-semibold text-[11px]' : 'text-crimson-err font-mono text-[11px]'"
          x-text="sseConnected ? 'LIVE' : 'OFF'">LIVE</span>
      </div>
    </div>
  </header>

  <!-- メインコンテンツ -->
  <main class="w-full space-y-[4px] flex-1">

    <div x-show="currentTab === 'dca'" class="space-y-3">
    <!-- 監視ステータスバー -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-500">監視通貨</div>
        <div class="text-sm font-semibold text-slate-100 mt-0.5 leading-tight font-mono" x-text="config?.targetCoins?.join(', ') || '読み込み中...'"></div>
      </div>
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-500">自動発注 (AUTO_ORDER)</div>
        <div class="text-sm font-semibold mt-0.5 flex items-center space-x-1.5 leading-tight" :class="config?.autoOrderEnabled ? 'text-emerald-ok' : 'text-amber-warn'">
          <span class="w-1.5 h-1.5 rounded-full" :class="config?.autoOrderEnabled ? 'bg-emerald-ok animate-pulse' : 'bg-amber-warn'"></span>
          <span x-text="config?.autoOrderEnabled ? '有効 (即時自動取引)' : '無効 (シグナル通知のみ)'"></span>
        </div>
      </div>
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-500">発注サイズ / 方式</div>
        <div class="text-sm font-semibold text-slate-100 mt-0.5 leading-tight font-mono tabular-nums" x-text="'$' + (config?.defaultOrderSizeUsd || 100) + ' / イベント駆動'"></div>
      </div>
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-500">累計シグナル数</div>
        <div class="text-sm font-semibold text-telemetry mt-0.5 leading-tight font-mono tabular-nums" x-text="signals.length + ' 件'"></div>
      </div>
    </div>

    <!-- 検出シグナル一覧テーブル -->
    <section class="space-y-1.5">
      <div class="flex items-center justify-between">
        <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[16px] text-telemetry">notifications_active</span>
          <span>検出シグナル &amp; 発注アクション (最新5件)</span>
        </h2>
        <span class="text-[11px] text-slate-400 font-mono tabular-nums" x-text="signals.slice(0, 5).length + ' 件表示'"></span>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead class="bg-[#0E131F] text-slate-400 font-mono text-[11px] uppercase tracking-wider border-b border-border-base">
              <tr>
                <th class="px-3 py-2.5">検知日時 (JST)</th>
                <th class="px-3 py-2.5">通貨</th>
                <th class="px-3 py-2.5">方向</th>
                <th class="px-3 py-2.5">時間枠</th>
                <th class="px-3 py-2.5">現在価格 ($)</th>
                <th class="px-3 py-2.5">基準極値 ($)</th>
                <th class="px-3 py-2.5">乖離率 (%)</th>
                <th class="px-3 py-2.5">発火閾値 (%)</th>
                <th class="px-3 py-2.5">注文ステータス</th>
                <th class="px-3 py-2.5">未発注の理由</th>
                <th class="px-3 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/60 font-mono text-xs">
              <template x-if="signals.length === 0">
                <tr>
                  <td colspan="11" class="px-4 py-8 text-center text-slate-500">
                    現在検出されているエントリーシグナルはありません
                  </td>
                </tr>
              </template>
              <template x-for="sig in signals.slice(0, 5)" :key="sig.id">
                <tr class="hover:bg-slate-800/40 transition">
                  <td class="px-3 py-2 text-slate-300" x-text="sig.createdAt ? sig.createdAt.substring(5, 19).replace('T', ' ') : '---'"></td>
                  <td class="px-3 py-2 font-bold text-slate-100" x-text="sig.coin"></td>
                  <td class="px-3 py-2 font-bold" :class="sig.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'" x-text="sig.side"></td>
                  <td class="px-3 py-2 text-indigo-400 font-semibold" x-text="sig.timeframe"></td>
                  <td class="px-3 py-2 text-slate-100" x-text="'$' + Number(sig.currentPx).toLocaleString()"></td>
                  <td class="px-3 py-2 text-slate-300" x-text="'$' + Number(sig.basePx).toLocaleString()"></td>
                  <td class="px-3 py-2 font-bold" :class="sig.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'" x-text="sig.changePct.toFixed(2) + '%'"></td>
                  <td class="px-3 py-2 text-slate-400" x-text="sig.thresholdPct + '%'"></td>
                  <td class="px-3 py-2">
                    <template x-if="sig.status === 'EXECUTED'">
                      <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 flex items-center space-x-1 w-max">
                        <span>✅ 発注済</span>
                        <span x-show="sig.orderId" x-text="'#' + sig.orderId"></span>
                      </span>
                    </template>
                    <template x-if="sig.status === 'NEW'">
                      <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950 text-amber-300 border border-amber-800">
                        ⚡ 未発注
                      </span>
                    </template>
                    <template x-if="sig.status !== 'EXECUTED' && sig.status !== 'NEW'">
                      <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400" x-text="sig.status"></span>
                    </template>
                  </td>
                  <td class="px-3 py-2 text-xs font-sans">
                    <span
                      class="text-[11px]"
                      :class="sig.error ? 'text-rose-400 font-semibold' : 'text-slate-400'"
                      x-text="getUnexecutedReason(sig)"
                    ></span>
                  </td>
                  <td class="px-3 py-2 text-right whitespace-nowrap space-x-1.5">
                    <button
                      x-show="sig.status === 'NEW'"
                      @click="executeSignal(sig.id)"
                      class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[10px] font-bold text-white shadow transition"
                    >
                      🚀 即時発注
                    </button>
                    <span x-show="sig.status === 'EXECUTED'" class="text-[10px] text-slate-500 mr-1">
                      完了
                    </span>
                    <button
                      @click="deleteSignal(sig.id)"
                      class="px-2 py-1 rounded bg-rose-950/80 hover:bg-rose-900 text-rose-300 hover:text-white text-[10px] font-medium border border-rose-800/60 transition"
                      title="シグナルデータを削除"
                    >
                      🗑️ 削除
                    </button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 通貨別 リアルタイム価格 & 期間別高値・安値カード -->
    <section class="space-y-1.5">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[16px] text-telemetry">analytics</span>
          <span>通貨別 4H足キャッシュ &amp; メモリ内動的 MIN/MAX 統計</span>
        </h2>
        <span class="text-[10px] text-slate-500">※リアルタイム価格が確定足のMIN/MAXを超過した場合、メモリ値を即時更新してシグナル判定</span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2">
        <template x-for="item in statsList" :key="item.coin">
          <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2 space-y-2">
            <!-- キャプション・ヘッダー行 -->
            <div class="flex items-center justify-between border-b border-border-base pb-1.5">
              <div class="flex items-center space-x-1.5">
                <span class="text-sm font-bold text-white" x-text="item.coin"></span>
                <span class="text-[9px] px-1.5 py-0.5 rounded bg-surface-2 border border-border-base text-slate-400 font-mono leading-tight">4H + RT</span>
                <template x-if="hasActiveTarget(item)">
                  <span class="text-[9px] px-1.5 py-0.2 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-500 font-bold animate-pulse shadow-sm shadow-emerald-500/30 leading-tight">
                    取引対象あり
                  </span>
                </template>
              </div>
              <div class="text-right">
                <div class="text-sm font-black text-amber-400 font-mono leading-tight" x-text="'$' + Number(item.currentPrice).toLocaleString()"></div>
              </div>
            </div>

            <!-- 乖離率・期間別レンジ (全6期間: 24H, 7D, 30D, 90D, 180D, 360D) -->
            <div class="space-y-1 text-xs">
              <div class="text-[10px] font-semibold text-slate-400 flex items-center justify-between leading-none">
                <span>期間別 高値 (LONG) / 安値 (SHORT)</span>
                <span class="text-[9px] text-indigo-400 font-mono">全6期間</span>
              </div>
              
              <div class="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
                <!-- 24H -->
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getLongCellClass('24H', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-emerald-400 font-bold">24H 高値 (Dip)</div>
                    <template x-if="getActiveSignal(item.coin, '24H', 'LONG')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '24H', 'LONG').status === 'EXECUTED'
                          ? 'bg-emerald-900/80 text-emerald-300 border border-emerald-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '24H', 'LONG').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.maxPrice24h)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isLongEligible('24H', item) || getActiveSignal(item.coin, '24H', 'LONG')) ? 'text-emerald-300 font-black' : ''" x-text="formatDip(item.maxPrice24h, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getLongThreshold('24H') + '%)'"></span>
                  </div>
                </div>
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getShortCellClass('24H', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-rose-400 font-bold">24H 安値 (Surge)</div>
                    <template x-if="getActiveSignal(item.coin, '24H', 'SHORT')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '24H', 'SHORT').status === 'EXECUTED'
                          ? 'bg-rose-900/80 text-rose-300 border border-rose-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '24H', 'SHORT').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.minPrice24h)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isShortEligible('24H', item) || getActiveSignal(item.coin, '24H', 'SHORT')) ? 'text-rose-300 font-black' : ''" x-text="formatSurge(item.minPrice24h, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getShortThreshold('24H') + '%)'"></span>
                  </div>
                </div>

                <!-- 7D -->
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getLongCellClass('7D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-emerald-400 font-bold">7D 高値 (Dip)</div>
                    <template x-if="getActiveSignal(item.coin, '7D', 'LONG')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '7D', 'LONG').status === 'EXECUTED'
                          ? 'bg-emerald-900/80 text-emerald-300 border border-emerald-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '7D', 'LONG').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.maxPrice7d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isLongEligible('7D', item) || getActiveSignal(item.coin, '7D', 'LONG')) ? 'text-emerald-300 font-black' : ''" x-text="formatDip(item.maxPrice7d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getLongThreshold('7D') + '%)'"></span>
                  </div>
                </div>
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getShortCellClass('7D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-rose-400 font-bold">7D 安値 (Surge)</div>
                    <template x-if="getActiveSignal(item.coin, '7D', 'SHORT')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '7D', 'SHORT').status === 'EXECUTED'
                          ? 'bg-rose-900/80 text-rose-300 border border-rose-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '7D', 'SHORT').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.minPrice7d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isShortEligible('7D', item) || getActiveSignal(item.coin, '7D', 'SHORT')) ? 'text-rose-300 font-black' : ''" x-text="formatSurge(item.minPrice7d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getShortThreshold('7D') + '%)'"></span>
                  </div>
                </div>

                <!-- 30D -->
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getLongCellClass('30D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-emerald-400 font-bold">30D 高値 (Dip)</div>
                    <template x-if="getActiveSignal(item.coin, '30D', 'LONG')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '30D', 'LONG').status === 'EXECUTED'
                          ? 'bg-emerald-900/80 text-emerald-300 border border-emerald-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '30D', 'LONG').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.maxPrice30d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isLongEligible('30D', item) || getActiveSignal(item.coin, '30D', 'LONG')) ? 'text-emerald-300 font-black' : ''" x-text="formatDip(item.maxPrice30d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getLongThreshold('30D') + '%)'"></span>
                  </div>
                </div>
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getShortCellClass('30D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-rose-400 font-bold">30D 安値 (Surge)</div>
                    <template x-if="getActiveSignal(item.coin, '30D', 'SHORT')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '30D', 'SHORT').status === 'EXECUTED'
                          ? 'bg-rose-900/80 text-rose-300 border border-rose-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '30D', 'SHORT').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.minPrice30d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isShortEligible('30D', item) || getActiveSignal(item.coin, '30D', 'SHORT')) ? 'text-rose-300 font-black' : ''" x-text="formatSurge(item.minPrice30d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getShortThreshold('30D') + '%)'"></span>
                  </div>
                </div>

                <!-- 90D -->
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getLongCellClass('90D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-emerald-400 font-bold">90D 高値 (Dip)</div>
                    <template x-if="getActiveSignal(item.coin, '90D', 'LONG')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '90D', 'LONG').status === 'EXECUTED'
                          ? 'bg-emerald-900/80 text-emerald-300 border border-emerald-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '90D', 'LONG').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.maxPrice90d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isLongEligible('90D', item) || getActiveSignal(item.coin, '90D', 'LONG')) ? 'text-emerald-300 font-black' : ''" x-text="formatDip(item.maxPrice90d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getLongThreshold('90D') + '%)'"></span>
                  </div>
                </div>
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getShortCellClass('90D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-rose-400 font-bold">90D 安値 (Surge)</div>
                    <template x-if="getActiveSignal(item.coin, '90D', 'SHORT')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '90D', 'SHORT').status === 'EXECUTED'
                          ? 'bg-rose-900/80 text-rose-300 border border-rose-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '90D', 'SHORT').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.minPrice90d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isShortEligible('90D', item) || getActiveSignal(item.coin, '90D', 'SHORT')) ? 'text-rose-300 font-black' : ''" x-text="formatSurge(item.minPrice90d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getShortThreshold('90D') + '%)'"></span>
                  </div>
                </div>

                <!-- 180D -->
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getLongCellClass('180D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-emerald-400 font-bold">180D 高値 (Dip)</div>
                    <template x-if="getActiveSignal(item.coin, '180D', 'LONG')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '180D', 'LONG').status === 'EXECUTED'
                          ? 'bg-emerald-900/80 text-emerald-300 border border-emerald-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '180D', 'LONG').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.maxPrice180d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isLongEligible('180D', item) || getActiveSignal(item.coin, '180D', 'LONG')) ? 'text-emerald-300 font-black' : ''" x-text="formatDip(item.maxPrice180d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getLongThreshold('180D') + '%)'"></span>
                  </div>
                </div>
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getShortCellClass('180D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-rose-400 font-bold">180D 安値 (Surge)</div>
                    <template x-if="getActiveSignal(item.coin, '180D', 'SHORT')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '180D', 'SHORT').status === 'EXECUTED'
                          ? 'bg-rose-900/80 text-rose-300 border border-rose-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '180D', 'SHORT').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.minPrice180d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isShortEligible('180D', item) || getActiveSignal(item.coin, '180D', 'SHORT')) ? 'text-rose-300 font-black' : ''" x-text="formatSurge(item.minPrice180d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getShortThreshold('180D') + '%)'"></span>
                  </div>
                </div>

                <!-- 360D -->
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getLongCellClass('360D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-emerald-400 font-bold">360D 高値 (Dip)</div>
                    <template x-if="getActiveSignal(item.coin, '360D', 'LONG')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '360D', 'LONG').status === 'EXECUTED'
                          ? 'bg-emerald-900/80 text-emerald-300 border border-emerald-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '360D', 'LONG').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.maxPrice360d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isLongEligible('360D', item) || getActiveSignal(item.coin, '360D', 'LONG')) ? 'text-emerald-300 font-black' : ''" x-text="formatDip(item.maxPrice360d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getLongThreshold('360D') + '%)'"></span>
                  </div>
                </div>
                <div
                  class="p-2 rounded-lg border transition-all duration-200"
                  :class="getShortCellClass('360D', item)"
                >
                  <div class="flex items-center justify-between">
                    <div class="text-[10px] text-rose-400 font-bold">360D 安値 (Surge)</div>
                    <template x-if="getActiveSignal(item.coin, '360D', 'SHORT')">
                      <span class="text-[9px] px-1.5 py-0.2 rounded font-bold"
                        :class="getActiveSignal(item.coin, '360D', 'SHORT').status === 'EXECUTED'
                          ? 'bg-rose-900/80 text-rose-300 border border-rose-600'
                          : 'bg-amber-900/80 text-amber-300 border border-amber-600 animate-pulse'"
                        x-text="getActiveSignal(item.coin, '360D', 'SHORT').status === 'EXECUTED' ? '発注済' : '⚡検知中'"
                      ></span>
                    </template>
                  </div>
                  <div class="text-slate-200 font-bold" x-text="formatPrice(item.minPrice360d)"></div>
                  <div class="text-[10px] text-slate-400 flex items-center justify-between">
                    <span :class="(isShortEligible('360D', item) || getActiveSignal(item.coin, '360D', 'SHORT')) ? 'text-rose-300 font-black' : ''" x-text="formatSurge(item.minPrice360d, item.currentPrice)"></span>
                    <span class="text-[9px] text-slate-500" x-text="'(閾値 ≥' + getShortThreshold('360D') + '%)'"></span>
                  </div>
                </div>
              </div>
            </div>

            <div class="text-[10px] text-slate-500 flex justify-between pt-1 border-t border-slate-800/60 font-mono">
              <span>最終更新日時</span>
              <span class="text-slate-400 font-semibold" x-text="formatTime(item.updatedAt)"></span>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- 直近注文履歴 -->
    <section class="space-y-1.5" x-show="orders.length > 0">
      <div class="flex items-center justify-between">
        <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[16px] text-telemetry">receipt_long</span>
          <span>直近注文履歴 (Hyperliquid Orders)</span>
        </h2>
        <span class="text-[11px] text-slate-400 font-mono tabular-nums" x-text="orders.length + ' 件'"></span>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead class="bg-[#0E131F] text-slate-400 font-mono text-[11px] uppercase tracking-wider border-b border-border-base">
              <tr>
                <th class="px-3 py-2">日時 (JST)</th>
                <th class="px-3 py-2">通貨</th>
                <th class="px-3 py-2">売買</th>
                <th class="px-3 py-2">価格 ($)</th>
                <th class="px-3 py-2">数量</th>
                <th class="px-3 py-2">想定額 ($)</th>
                <th class="px-3 py-2">ステータス</th>
                <th class="px-3 py-2">OID / CLOID</th>
                <th class="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/60 font-mono text-xs">
              <template x-for="ord in orders" :key="ord.id">
                <tr class="hover:bg-slate-800/40 transition">
                  <td class="px-3 py-2 text-slate-300" x-text="ord.createdAt ? ord.createdAt.substring(5, 19).replace('T', ' ') : '---'"></td>
                  <td class="px-3 py-2 font-bold text-slate-100" x-text="ord.coin"></td>
                  <td class="px-3 py-2 font-bold" :class="ord.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'" x-text="ord.side"></td>
                  <td class="px-3 py-2 text-slate-100" x-text="'$' + Number(ord.price).toLocaleString()"></td>
                  <td class="px-3 py-2 text-slate-200" x-text="ord.size"></td>
                  <td class="px-3 py-2 text-slate-200" x-text="'$' + Number(ord.notionalUsd).toLocaleString()"></td>
                  <td class="px-3 py-2">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold"
                      :class="ord.status === 'FILLED' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-indigo-950 text-indigo-300 border border-indigo-800'"
                      x-text="ord.status"></span>
                  </td>
                  <td class="px-3 py-2 text-[10px] text-slate-500" x-text="ord.oid || ord.cloid?.substring(0, 10)"></td>
                  <td class="px-3 py-2 text-right">
                    <button
                      @click="deleteOrder(ord.id)"
                      class="px-2 py-1 rounded bg-rose-950/80 hover:bg-rose-900 text-rose-300 hover:text-white text-[10px] font-medium border border-rose-800/60 transition"
                      title="注文履歴レコードを削除"
                    >
                      🗑️ 削除
                    </button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>
    </div>

    <!-- [タブ: 期間別 下落率 / 上昇率 チャート] -->
    <section x-show="currentTab === 'drop' || currentTab === 'rise'" x-cloak class="space-y-2">
      <div class="flex items-center justify-between bg-surface-1 border border-border-base px-4 py-2.5 rounded-lg">
        <span class="text-sm font-semibold text-slate-200"
          x-text="currentTab === 'drop' ? '期間別 最高値からの下落率 (%) ※現在値 vs 期間内最高値' : '期間別 最安値からの上昇率 (%) ※現在値 vs 期間内最安値'"></span>
        <button type="button" @click="loadChartData()" class="px-2.5 py-1 bg-surface-2 hover:bg-border-elevated border border-border-base text-slate-200 rounded text-xs font-medium transition cursor-pointer flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px]">refresh</span>
          <span>再読込</span>
        </button>
      </div>
      <div class="bg-surface-1 border border-border-base rounded-lg p-3 overflow-x-auto">
        <div x-show="chartLoading" class="text-slate-500 text-xs p-4 font-mono">読み込み中...</div>
        <div x-html="renderChart(currentTab)"></div>
      </div>
    </section>

    <!-- [タブ: 🚨 エラーログ一覧] -->
    <section x-show="currentTab === 'errors'" x-cloak class="space-y-2">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-surface-1 border border-border-base px-4 py-2.5 rounded-lg">
        <div class="flex items-center space-x-2">
          <span class="material-symbols-outlined text-[18px] text-crimson-err">error</span>
          <span class="text-crimson-err font-semibold text-sm">エラーログ一覧 (最新100件)</span>
          <span class="px-2 py-0.5 rounded text-[10px] font-mono tabular-nums bg-crimson-err/10 text-crimson-err border border-crimson-err/30" x-text="errorLogs.length + ' 件'"></span>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="fetchErrors()"
            class="px-2.5 py-1 bg-surface-2 hover:bg-border-elevated border border-border-base text-slate-200 rounded text-xs font-medium transition cursor-pointer flex items-center gap-1"
          >
            <span class="material-symbols-outlined text-[14px]">refresh</span>
            <span>再読込</span>
          </button>
          <button
            type="button"
            @click="clearErrors()"
            class="px-2.5 py-1 bg-crimson-err/10 hover:bg-crimson-err/20 text-crimson-err border border-crimson-err/30 rounded text-xs font-medium transition cursor-pointer flex items-center gap-1"
          >
            <span class="material-symbols-outlined text-[14px]">delete_sweep</span>
            <span>ログ消去</span>
          </button>
        </div>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap border-collapse">
            <thead class="bg-[#0E131F] text-slate-400 font-mono text-[11px] uppercase tracking-wider border-b border-border-base">
              <tr>
                <th class="px-3 py-2 w-36">発生日時 (JST)</th>
                <th class="px-3 py-2 w-28">サービス</th>
                <th class="px-3 py-2 w-32">コンテキスト</th>
                <th class="px-3 py-2">エラー詳細・メッセージ</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/60 font-mono text-xs">
              <template x-if="errorLogs.length === 0">
                <tr>
                  <td colspan="4" class="px-4 py-8 text-center text-slate-500">
                    現在記録されたエラーログはありません (正常稼働中)
                  </td>
                </tr>
              </template>
              <template x-for="err in errorLogs" :key="err.timestamp + err.message">
                <tr class="hover:bg-rose-950/20 transition">
                  <td class="px-3 py-2 text-slate-400" x-text="err.timestamp ? err.timestamp.substring(5, 19).replace('T', ' ') : '---'"></td>
                  <td class="px-3 py-2 font-bold text-slate-200" x-text="err.service"></td>
                  <td class="px-3 py-2 text-rose-400 font-semibold" x-text="err.context"></td>
                  <td class="px-3 py-2 text-rose-200">
                    <div class="font-medium" x-text="err.message"></div>
                    <template x-if="err.stack">
                      <pre class="mt-1 text-[10px] text-rose-300/80 bg-black/40 p-1.5 rounded overflow-x-auto" x-text="err.stack"></pre>
                    </template>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>

  </main>

  <footer class="w-full text-center text-[11px] font-mono text-slate-600 pt-4 pb-3 border-t border-border-base">
    dca-deno (Deno 2.x / Hyperliquid DEX Self-Contained Worker)
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
            @click="refreshData()"
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

  <script>
    function dcaApp() {
      return {
        config: null,
        statsList: [],
        signals: [],
        orders: [],
        insufficientCooldown: null,
        isScanning: false,
        sseConnected: false,
        redisConnected: true,
        eventSource: null,
        botEnabled: true,
        currentTab: 'dca',
        errorLogs: [],
        chartLoading: false,
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
        chartPeriods: [
          { label: '24時間', hours: 24 },
          { label: '7日', hours: 168 },
          { label: '30日', hours: 720 },
          { label: '90日', hours: 2160 },
          { label: '180日', hours: 4320 },
          { label: '360日', hours: 8640 },
        ],

        // 「通貨別 4H足キャッシュ & メモリ内動的 MIN/MAX 統計」(statsList) から期間別の下落率/上昇率(%)を算出
        async loadChartData() {
          this.chartLoading = true;
          await this.refreshData();
          this.chartLoading = false;
        },

        buildChartData() {
          const keys = { '24時間': '24h', '7日': '7d', '30日': '30d', '90日': '90d', '180日': '180d', '360日': '360d' };
          const result = {};
          for (const s of this.statsList) {
            const cur = s.currentPrice;
            if (!cur) continue;
            const row = {};
            for (const [label, k] of Object.entries(keys)) {
              const hi = s['maxPrice' + k], lo = s['minPrice' + k];
              row[label] = {
                drop: hi > 0 ? (cur - hi) / hi * 100 : 0,
                rise: lo > 0 ? (cur - lo) / lo * 100 : 0,
              };
            }
            result[s.coin] = row;
          }
          return result;
        },

        // X軸=期間別グループ / 各バー=通貨 / Y軸=率(%) のインラインSVG棒グラフ
        renderChart(kind) {
          const data = this.buildChartData();
          const coins = Object.keys(data);
          if (coins.length === 0) return '<div class="text-slate-500 text-xs p-4">データなし</div>';
          const colors = ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#e879f9', '#a3e635', '#fb923c', '#94a3b8', '#f472b6'];
          const W = Math.max(720, this.chartPeriods.length * (coins.length * 22 + 30) + 90), H = 380;
          const L = 56, R = 10, T = 14, B = 52;
          const vals = [];
          for (const c of coins) for (const p of this.chartPeriods) vals.push(data[c][p.label]?.[kind] ?? 0);
          let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
          if (max === min) max = min + 1;
          const pad = (max - min) * 0.08;
          if (max > 0) max += pad;
          if (min < 0) min -= pad;
          const y = (v) => T + (max - v) / (max - min) * (H - T - B);
          const gw = (W - L - R) / this.chartPeriods.length;
          const bw = Math.min(26, (gw * 0.8) / coins.length);
          let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="min-width:' + W + 'px" font-family="monospace" font-size="10">';
          for (let i = 0; i <= 5; i++) {
            const v = min + (max - min) * i / 5;
            s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#1f2b42"/>';
            s += '<text x="' + (L - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end" fill="#94a3b8">' + v.toFixed(1) + '%</text>';
          }
          s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="#64748b"/>';
          this.chartPeriods.forEach((p, pi) => {
            const gx = L + gw * pi + (gw - bw * coins.length) / 2;
            coins.forEach((c, ci) => {
              const v = data[c][p.label]?.[kind] ?? 0;
              const x = gx + bw * ci;
              const y0 = y(0), y1 = y(v);
              s += '<rect x="' + (x + 1) + '" y="' + Math.min(y0, y1) + '" width="' + (bw - 2) + '" height="' + Math.max(1, Math.abs(y1 - y0)) + '" fill="' + colors[ci % colors.length] + '"><title>' + c + ' ' + p.label + ': ' + v.toFixed(2) + '%</title></rect>';
              s += '<text x="' + (x + bw / 2) + '" y="' + (v < 0 ? y1 + 10 : y1 - 3) + '" text-anchor="middle" fill="#cbd5e1" font-size="8">' + v.toFixed(0) + '</text>';
            });
            s += '<text x="' + (L + gw * pi + gw / 2) + '" y="' + (H - B + 16) + '" text-anchor="middle" fill="#e2e8f0" font-size="11">' + p.label + '</text>';
          });
          coins.forEach((c, ci) => {
            const lx = L + ci * 70;
            s += '<rect x="' + lx + '" y="' + (H - 16) + '" width="10" height="10" fill="' + colors[ci % colors.length] + '"/><text x="' + (lx + 14) + '" y="' + (H - 7) + '" fill="#cbd5e1">' + c + '</text>';
          });
          return s + '</svg>';
        },

        async init() {
          await Promise.all([this.loadConfig(), this.loadBotEnabled()]);
          await this.refreshData();
          this.initSSE();

          // 完全イベント駆動: 定期タイマーによる画面更新ポーリングは全廃。
          // 注文・約定・統計更新の各SSEイベントを受信した瞬間のみ画面同期を実行
        },

        initSSE() {
          if (this.eventSource) {
            try { this.eventSource.close(); } catch (_) {}
            this.eventSource = null;
          }

          try {
            const es = new EventSource('api/events');
            this.eventSource = es;

            es.addEventListener('open', () => {
              this.sseConnected = true;
            });

            es.addEventListener('connected', () => {
              this.sseConnected = true;
            });

            es.addEventListener('prices', (e) => {
              try {
                const payload = JSON.parse(e.data);
                if (payload && payload.prices) {
                  // 即時価格を statsList に反映
                  for (const [coin, px] of Object.entries(payload.prices)) {
                    const stat = this.statsList.find(s => s.coin.toUpperCase() === coin.toUpperCase());
                    if (stat && typeof px === 'number') {
                      stat.currentPrice = px;
                      if (!stat.minPrice24h || px < stat.minPrice24h) stat.minPrice24h = px;
                      if (!stat.maxPrice24h || px > stat.maxPrice24h) stat.maxPrice24h = px;
                    }
                  }
                }
              } catch (err) {
                console.error('SSE prices 解析エラー:', err);
              }
            });

            // 注文・約定・統計更新イベントを受信した瞬間にテーブル・状態をイベント駆動で再同期
            es.addEventListener('orders', () => this.refreshData());
            es.addEventListener('fills', () => this.refreshData());
            es.addEventListener('price_stats', () => this.refreshData());

            es.onerror = () => {
              this.sseConnected = false;
            };
          } catch (err) {
            console.error('SSE 初期化エラー:', err);
            this.sseConnected = false;
          }
        },

        async loadConfig() {
          try {
            const res = await fetch('api/config');
            if (res.ok) {
              this.config = await res.json();
            }
          } catch (e) {
            console.error('設定取得エラー:', e);
          }
        },

        async loadBotEnabled() {
          try {
            const res = await fetch('api/flags/enabled');
            if (res.ok) {
              const data = await res.json();
              this.botEnabled = Boolean(data.enabled);
            }
          } catch (e) {
            console.error('ボット稼働状態取得エラー:', e);
          }
        },

        async toggleBot() {
          try {
            const target = !this.botEnabled;
            const res = await fetch('api/flags/enabled', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: target }),
            });
            if (res.ok) {
              const data = await res.json();
              this.botEnabled = Boolean(data.enabled);
            }
          } catch (e) {
            console.error('ボット稼働状態切り替えエラー:', e);
          }
        },

        async refreshData() {
          try {
            const [statsRes, signalsRes, ordersRes, sysRes, healthRes] = await Promise.all([
              fetch('api/stats'),
              fetch('api/signals?limit=5'),
              fetch('api/orders'),
              fetch('api/system-status'),
              fetch('api/health'),
            ]);
            const failedEndpoints = [];
            const invalidResponses = [];
            if (healthRes.ok) {
              const healthData = await healthRes.json();
              this.redisConnected = Boolean(healthData && healthData.redisConnected);
            } else {
              failedEndpoints.push('api/health (' + healthRes.status + ')');
            }
            if (statsRes.ok) {
              const newStats = await statsRes.json();
              if (Array.isArray(newStats)) {
                // SSE で既に受信している最新のリアルタイム価格を保護 (古いAPI値による巻き戻しを防止)
                for (const item of newStats) {
                  const existing = this.statsList.find(s => s.coin.toUpperCase() === item.coin.toUpperCase());
                  if (existing && typeof existing.currentPrice === 'number' && existing.currentPrice > 0) {
                    item.currentPrice = existing.currentPrice;
                  }
                }
                this.statsList = newStats;
              } else {
                invalidResponses.push('api/stats');
              }
            } else {
              failedEndpoints.push('api/stats (' + statsRes.status + ')');
            }
            if (signalsRes.ok) {
              const signalsData = await signalsRes.json();
              if (Array.isArray(signalsData)) {
                this.signals = signalsData;
              } else {
                invalidResponses.push('api/signals');
              }
            } else {
              failedEndpoints.push('api/signals (' + signalsRes.status + ')');
            }
            if (ordersRes.ok) {
              const ordersData = await ordersRes.json();
              if (Array.isArray(ordersData)) {
                this.orders = ordersData;
              } else {
                invalidResponses.push('api/orders');
              }
            } else {
              failedEndpoints.push('api/orders (' + ordersRes.status + ')');
            }
            if (sysRes.ok) {
              const sys = await sysRes.json();
              this.insufficientCooldown = sys ? sys.insufficientCooldown : null;
            } else {
              failedEndpoints.push('api/system-status (' + sysRes.status + ')');
            }
            await this.fetchErrors();

            if (failedEndpoints.length > 0) {
              this.showErrorPopup('API 取得エラー', '以下のエンドポイントの取得に失敗しました: ' + failedEndpoints.join(', '));
            } else if (invalidResponses.length > 0) {
              this.showErrorPopup('データ形式エラー', '以下のエンドポイントのレスポンス形式が不正です: ' + invalidResponses.join(', '));
            } else if (!this.redisConnected) {
              this.showErrorPopup('Redis 未接続', 'Redis サーバーとの接続が確立されていません。価格統計を取得できない可能性があります。');
            } else if (this.statsList.length === 0) {
              const coins = this.config && this.config.targetCoins ? this.config.targetCoins.join(', ') : '対象通貨';
              this.showErrorPopup('価格統計データ未取得', '対象銘柄 (' + coins + ') の価格統計データ (api/stats) が空です。Redis の hl:price_stats / 個別キーを確認してください。');
            } else {
              this.dismissErrorPopup();
            }
          } catch (e) {
            console.error('データ取得エラー:', e);
            this.showErrorPopup('通信エラー', 'サーバーからのデータ取得に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
          }
        },

        async fetchErrors() {
          try {
            const res = await fetch('api/errors?limit=100');
            if (res.ok) {
              const data = await res.json();
              this.errorLogs = data.errors || [];
            }
          } catch (e) {
            console.error('エラーログ取得失敗:', e);
          }
        },

        async clearErrors() {
          if (!confirm('エラーログを消去しますか？')) return;
          try {
            await fetch('api/errors', { method: 'DELETE' });
            await this.fetchErrors();
          } catch (e) {
            console.error('エラーログ消去失敗:', e);
          }
        },

        async triggerScan() {
          this.isScanning = true;
          try {
            const res = await fetch('api/scan', { method: 'POST' });
            const data = await res.json();
            await this.refreshData();
            if (data.detectedCount > 0) {
              alert(\`スキャン完了: \${data.detectedCount} 件のシグナルを検知 (新規: \${data.insertedCount}件, 自動発注: \${data.executedOrderCount || 0}件, 重複枠内: \${data.skippedCount}件)\`);
            } else {
              alert('スキャン完了: 現在の市場価格では発火条件を満たす通貨はありませんでした');
            }
          } catch (e) {
            alert('スキャン実行エラー: ' + (e.message || e));
          } finally {
            this.isScanning = false;
          }
        },

        async executeSignal(signalId) {
          if (!confirm('このシグナルを Hyperliquid 取引所に即時発注しますか？')) return;
          try {
            const res = await fetch(\`api/signals/\${signalId}/execute\`, { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
              alert('発注完了: ' + data.message);
              await this.refreshData();
            } else {
              alert('発注失敗: ' + (data.message || data.error || '不明なエラー'));
            }
          } catch (e) {
            alert('通信エラー: ' + (e.message || e));
          }
        },

        async deleteSignal(signalId) {
          if (!confirm('このシグナルレコードを削除しますか？ (※取引所の注文はキャンセルされません)')) return;
          try {
            const res = await fetch(\`api/signals?id=\${encodeURIComponent(signalId)}\`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok && data.success) {
              this.signals = this.signals.filter(s => s.id !== signalId);
            } else {
              alert('シグナル削除に失敗しました: ' + (data.error || '不明なエラー'));
            }
          } catch (e) {
            alert('通信エラー: ' + (e.message || e));
          }
        },

        async deleteOrder(orderId) {
          if (!confirm('この注文履歴レコードを削除しますか？ (※取引所の注文はキャンセルされません)')) return;
          try {
            const res = await fetch(\`api/orders?id=\${encodeURIComponent(orderId)}\`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok && data.success) {
              this.orders = this.orders.filter(o => o.id !== orderId);
            } else {
              alert('注文履歴削除に失敗しました: ' + (data.error || '不明なエラー'));
            }
          } catch (e) {
            alert('通信エラー: ' + (e.message || e));
          }
        },

        formatPrice(val) {
          if (val === null || val === undefined || isNaN(val) || Number(val) <= 0) return '---';
          const num = Number(val);
          return '$' + num.toLocaleString('en-US', {
            minimumFractionDigits: num >= 1000 ? 1 : num >= 1 ? 2 : 4,
            maximumFractionDigits: num >= 1 ? 2 : 4
          });
        },

        formatDip(high, current) {
          if (!high || !current || Number(high) <= 0) return '---';
          const h = Number(high);
          const c = Number(current);
          const pct = ((h - c) / h) * 100;
          return '-' + pct.toFixed(1) + '%';
        },

        formatSurge(low, current) {
          if (!low || !current || Number(low) <= 0) return '---';
          const l = Number(low);
          const c = Number(current);
          const pct = ((c - l) / l) * 100;
          return '+' + pct.toFixed(1) + '%';
        },

        formatTime(val) {
          if (!val) return '---';
          if (typeof val === 'string') {
            if (val.includes('T')) {
              const timePart = val.split('T')[1];
              if (timePart) return timePart.substring(0, 8);
            }
            if (val.length >= 19) return val.substring(11, 19);
          }
          const num = Number(val);
          if (!isNaN(num) && num > 1000000000) {
            const d = new Date(num > 10000000000 ? num : num * 1000);
            return d.toTimeString().substring(0, 8);
          }
          return String(val);
        },

        getLongThreshold(tf) {
          const c = this.config || {};
          const key = 'dipThreshold' + tf.toLowerCase();
          if (c[key] !== undefined && c[key] !== null) return Number(c[key]);
          const defaults = { '24H': 16.18, '7D': 26.18, '30D': 36.18, '90D': 46.18, '180D': 56.18, '360D': 66.18 };
          return defaults[tf] || 20;
        },

        getShortThreshold(tf) {
          const c = this.config || {};
          const key = 'surgeThreshold' + tf.toLowerCase();
          if (c[key] !== undefined && c[key] !== null) return Number(c[key]);
          const defaults = { '24H': 16.18, '7D': 38.2, '30D': 61.8, '90D': 100.0, '180D': 138.2, '360D': 161.8 };
          return defaults[tf] || 50;
        },

        getActiveSignal(coin, tf, side) {
          if (!this.signals || !Array.isArray(this.signals)) return null;
          const c = (coin || '').toUpperCase();
          const s = (side || '').toUpperCase();
          return this.signals.find(sig =>
            sig.coin?.toUpperCase() === c &&
            sig.timeframe === tf &&
            sig.side === s &&
            sig.status !== 'DISMISSED'
          ) || null;
        },

        getLongCellClass(tf, item) {
          if (this.isLongEligible(tf, item)) {
            return 'border-emerald-400 bg-emerald-950/60 shadow-lg shadow-emerald-500/20 ring-1 ring-emerald-400/50';
          }
          const sig = this.getActiveSignal(item?.coin, tf, 'LONG');
          if (sig) {
            return sig.status === 'EXECUTED'
              ? 'border-emerald-500/80 bg-emerald-950/40 shadow-md shadow-emerald-500/10 ring-1 ring-emerald-500/40'
              : 'border-amber-500/80 bg-amber-950/30 shadow-md shadow-amber-500/10 ring-1 ring-amber-500/40';
          }
          return 'bg-slate-950/60 border-slate-800/50';
        },

        getShortCellClass(tf, item) {
          if (this.isShortEligible(tf, item)) {
            return 'border-rose-400 bg-rose-950/60 shadow-lg shadow-rose-500/20 ring-1 ring-rose-400/50';
          }
          const sig = this.getActiveSignal(item?.coin, tf, 'SHORT');
          if (sig) {
            return sig.status === 'EXECUTED'
              ? 'border-rose-500/80 bg-rose-950/40 shadow-md shadow-rose-500/10 ring-1 ring-rose-500/40'
              : 'border-amber-500/80 bg-amber-950/30 shadow-md shadow-amber-500/10 ring-1 ring-amber-500/40';
          }
          return 'bg-slate-950/60 border-slate-800/50';
        },

        isLongEligible(tf, item) {
          if (!item || !item.currentPrice || Number(item.currentPrice) <= 0) return false;
          const currentPx = Number(item.currentPrice);
          const maxPx = Number(item['maxPrice' + tf.toLowerCase()]);
          if (!maxPx || maxPx <= 0) return false;
          const dipPct = ((maxPx - currentPx) / maxPx) * 100;
          return dipPct >= this.getLongThreshold(tf);
        },

        isShortEligible(tf, item) {
          if (!item || !item.currentPrice || Number(item.currentPrice) <= 0) return false;
          const currentPx = Number(item.currentPrice);
          const minPx = Number(item['minPrice' + tf.toLowerCase()]);
          if (!minPx || minPx <= 0) return false;
          const surgePct = ((currentPx - minPx) / minPx) * 100;
          return surgePct >= this.getShortThreshold(tf);
        },

        hasActiveTarget(item) {
          const tfs = ['24H', '7D', '30D', '90D', '180D', '360D'];
          return tfs.some(tf =>
            this.isLongEligible(tf, item) ||
            this.isShortEligible(tf, item) ||
            this.getActiveSignal(item?.coin, tf, 'LONG') ||
            this.getActiveSignal(item?.coin, tf, 'SHORT')
          );
        },

        getUnexecutedReason(sig) {
          if (!sig) return 'ー';
          if (sig.status === 'EXECUTED') return 'ー (発注済)';
          if (sig.unexecutedReason) return sig.unexecutedReason;
          if (sig.error) return '発注エラー: ' + sig.error;
          if (this.config && this.config.autoOrderEnabled === false) {
            return '自動発注OFF (手動待機)';
          }
          // 自動発注ONで理由が未記録: 手動待機ではなく、記録前に検出された旧シグナル等のため理由が不明
          return '未発注 (理由未記録)';
        }
      };
    }
  </script>
</body>
</html>`;
}
