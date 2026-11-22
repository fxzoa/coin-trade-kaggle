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
  <title>BTC DCA Trader - btc-dca-deno</title>

  <!-- PWA & Mobile 対応 -->
  <meta name="theme-color" content="#0B0F17">
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
      color: #F8FAFC;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-tap-highlight-color: transparent;
    }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0B0F17; }
    ::-webkit-scrollbar-thumb { background: #1E293B; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #334155; }
  </style>
</head>
<body class="min-h-screen bg-obsidian text-slate-100 flex flex-col font-sans antialiased selection:bg-telemetry/30 selection:text-telemetry p-1 gap-[4px]" x-data="dcaApp()" x-init="init()">

  <!-- ヘッダー -->
  <header class="w-full bg-surface-1 border border-border-base rounded-lg px-2.5 py-1.5 sm:px-4 flex items-center justify-between gap-2">
    <!-- 左側: アイコン + タイトル -->
    <div class="flex items-center gap-2.5">
      <div class="w-7 h-7 rounded bg-telemetry/10 border border-telemetry/30 flex items-center justify-center text-telemetry shadow-[0_0_12px_-2px_rgba(56,189,248,0.3)]">
        <span class="material-symbols-outlined text-[18px]">currency_bitcoin</span>
      </div>
      <div class="flex flex-col">
        <h1 class="text-sm font-bold tracking-tight text-white leading-tight">BTC DCA Trader</h1>
        <span class="text-[10px] font-mono uppercase tracking-widest text-telemetry leading-tight">Obsidian Telemetry</span>
      </div>
    </div>

    <!-- 右側: BOT スイッチ & LIVE ステータスバッジ -->
    <div class="flex items-center gap-2 text-xs">
      <!-- BOT ON/OFF トグルスイッチ -->
      <button
        @click="toggleBot()"
        class="text-[11px] px-2.5 py-1 rounded font-mono font-semibold cursor-pointer border flex items-center gap-1.5 transition-colors"
        :class="botEnabled ? 'bg-emerald-ok/10 border-emerald-ok/40 text-emerald-ok hover:bg-emerald-ok/20' : 'bg-surface-2 border-border-base text-slate-400 hover:text-slate-200 hover:border-border-elevated'"
        :title="'BOTステータス: ' + (botEnabled ? '稼働中 (クリックで停止)' : '停止中 (クリックで再開)')"
      >
        <span class="w-1.5 h-1.5 rounded-full" :class="botEnabled ? 'bg-emerald-ok shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse' : 'bg-slate-500'"></span>
        <span>BOT</span>
      </button>

      <!-- LIVE 接続ステータスバッジ -->
      <div
        class="flex items-center gap-1.5 bg-surface-2 border border-border-base px-2.5 py-1 rounded text-[11px] font-mono font-semibold"
        :title="'リアルタイム接続: ' + (sseConnected ? 'LIVE接続中' : '切断 (再接続試行中)')">
        <span class="w-1.5 h-1.5 rounded-full" :class="sseConnected ? 'bg-telemetry shadow-[0_0_8px_rgba(56,189,248,0.7)] animate-pulse' : 'bg-crimson-err shadow-[0_0_8px_rgba(244,63,94,0.7)]'"></span>
        <span :class="sseConnected ? 'text-telemetry' : 'text-crimson-err'"
          x-text="sseConnected ? 'LIVE' : 'OFF'">LIVE</span>
      </div>
    </div>
  </header>

  <!-- メインコンテンツ -->
  <main class="w-full space-y-[4px] flex-1">

    <!-- 監視ステータスバー -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">監視通貨</div>
        <div class="text-sm font-bold text-white mt-0.5 leading-tight font-mono" x-text="config?.targetCoins?.join(', ') || '読み込み中...'"></div>
      </div>
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">自動発注 (AUTO_ORDER)</div>
        <div class="text-sm font-bold mt-0.5 flex items-center gap-1.5 leading-tight" :class="config?.autoOrderEnabled ? 'text-emerald-ok' : 'text-amber-warn'">
          <span class="w-1.5 h-1.5 rounded-full" :class="config?.autoOrderEnabled ? 'bg-emerald-ok animate-pulse' : 'bg-amber-warn'"></span>
          <span x-text="config?.autoOrderEnabled ? '有効 (即時自動取引)' : '無効 (シグナル通知のみ)'"></span>
        </div>
      </div>
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">発注サイズ / 方式</div>
        <div class="text-sm font-bold text-slate-100 mt-0.5 leading-tight font-mono" x-text="'$' + (config?.defaultOrderSizeUsd || 100) + ' / イベント駆動'"></div>
      </div>
      <div class="bg-surface-1 border border-border-base rounded-lg px-3 py-2">
        <div class="text-[10px] font-mono uppercase tracking-wider text-slate-400">累計シグナル数</div>
        <div class="text-sm font-bold text-telemetry mt-0.5 leading-tight font-mono" x-text="signals.length + ' 件'"></div>
      </div>
    </div>

    <!-- 検出シグナル一覧テーブル -->
    <section class="space-y-1.5">
      <div class="flex items-center justify-between px-0.5">
        <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[16px] text-telemetry">notifications_active</span>
          <span>検出シグナル &amp; 発注アクション</span>
        </h2>
        <span class="text-[11px] text-slate-400 font-mono" x-text="signals.length + ' 件'"></span>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead class="bg-obsidian/80 text-slate-400 font-mono text-[11px] uppercase tracking-wider border-b border-border-base">
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
            <tbody class="divide-y divide-border-base/60 font-mono text-xs">
              <template x-if="signals.length === 0">
                <tr>
                  <td colspan="11" class="px-4 py-8 text-center text-slate-500 font-sans">
                    現在検出されているエントリーシグナルはありません
                  </td>
                </tr>
              </template>
              <template x-for="sig in signals" :key="sig.id">
                <tr class="hover:bg-surface-2/60 transition-colors">
                  <td class="px-3 py-2 text-slate-300" x-text="sig.createdAt ? sig.createdAt.substring(5, 19).replace('T', ' ') : '---'"></td>
                  <td class="px-3 py-2 font-bold text-white" x-text="sig.coin"></td>
                  <td class="px-3 py-2 font-bold" :class="sig.side === 'LONG' ? 'text-emerald-ok' : 'text-crimson-err'" x-text="sig.side"></td>
                  <td class="px-3 py-2 text-telemetry font-semibold" x-text="sig.timeframe"></td>
                  <td class="px-3 py-2 text-slate-100" x-text="formatPrice(sig.currentPx)"></td>
                  <td class="px-3 py-2 text-slate-300" x-text="formatPrice(sig.basePx)"></td>
                  <td class="px-3 py-2 font-bold" :class="sig.side === 'LONG' ? 'text-emerald-ok' : 'text-crimson-err'" x-text="sig.changePct.toFixed(2) + '%'"></td>
                  <td class="px-3 py-2 text-slate-400" x-text="sig.thresholdPct + '%'"></td>
                  <td class="px-3 py-2">
                    <template x-if="sig.status === 'EXECUTED'">
                      <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-ok/10 text-emerald-ok border border-emerald-ok/30 inline-flex items-center gap-1 w-max">
                        <span class="material-symbols-outlined text-[12px]">check_circle</span>
                        <span>発注済</span>
                        <span x-show="sig.orderId" x-text="'#' + sig.orderId"></span>
                      </span>
                    </template>
                    <template x-if="sig.status === 'NEW'">
                      <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-warn/10 text-amber-warn border border-amber-warn/30 inline-flex items-center gap-1 w-max">
                        <span class="material-symbols-outlined text-[12px]">bolt</span>
                        <span>未発注</span>
                      </span>
                    </template>
                    <template x-if="sig.status !== 'EXECUTED' && sig.status !== 'NEW'">
                      <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-surface-2 text-slate-400 border border-border-base" x-text="sig.status"></span>
                    </template>
                  </td>
                  <td class="px-3 py-2 text-xs font-sans">
                    <span
                      class="text-[11px]"
                      :class="sig.error ? 'text-crimson-err font-semibold' : 'text-slate-400'"
                      x-text="getUnexecutedReason(sig)"
                    ></span>
                  </td>
                  <td class="px-3 py-2 text-right">
                    <button
                      x-show="sig.status === 'NEW'"
                      @click="executeSignal(sig.id)"
                      class="px-2.5 py-1 rounded bg-telemetry/15 hover:bg-telemetry/25 border border-telemetry/40 text-[10px] font-semibold text-telemetry inline-flex items-center gap-1 transition-colors"
                    >
                      <span class="material-symbols-outlined text-[13px]">rocket_launch</span>
                      <span>即時発注</span>
                    </button>
                    <span x-show="sig.status === 'EXECUTED'" class="text-[10px] text-slate-500">
                      完了
                    </span>
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
      <div class="flex items-center justify-between flex-wrap gap-1 px-0.5">
        <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[16px] text-telemetry">monitoring</span>
          <span>通貨別 4H足キャッシュ &amp; メモリ内動的 MIN/MAX 統計</span>
        </h2>
        <span class="text-[10px] text-slate-500">※リアルタイム価格が確定足のMIN/MAXを超過した場合、メモリ値を即時更新してシグナル判定</span>
      </div>

      <div class="grid grid-cols-1 w-full gap-2">
        <template x-for="item in statsList" :key="item.coin">
          <div class="bg-surface-1 border border-border-base rounded-lg p-3 space-y-2.5">
            <div class="flex items-center justify-between border-b border-border-base pb-2">
              <div class="flex items-center gap-2">
                <span class="text-base font-bold text-white font-mono" x-text="item.coin"></span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 border border-border-base text-slate-400 font-mono">4H + RT</span>
                <template x-if="hasActiveTarget(item)">
                  <span class="text-[10px] px-2 py-0.5 rounded bg-emerald-ok/10 text-emerald-ok border border-emerald-ok/40 font-semibold animate-pulse">
                    取引対象あり
                  </span>
                </template>
              </div>
              <div class="text-right">
                <div class="text-sm sm:text-base font-bold text-telemetry font-mono" x-text="formatPrice(item.currentPrice)"></div>
              </div>
            </div>

            <!-- 乖離率・期間別レンジ (2行6列固定: 上段LONG高値 / 下段SHORT安値: 24H, 7D, 30D, 90D, 180D, 360D) -->
            <div class="overflow-x-auto">
              <div class="min-w-[760px] space-y-1.5 font-mono text-[11px]">
                <!-- 1行目: LONG (高値からの下落率・Dip) 全6期間 (6列固定) -->
                <div class="grid grid-cols-6 gap-2">
                  <!-- 24H LONG -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getLongCellClass('24H', item)">
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

                  <!-- 7D LONG -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getLongCellClass('7D', item)">
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

                  <!-- 30D LONG -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getLongCellClass('30D', item)">
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

                  <!-- 90D LONG -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getLongCellClass('90D', item)">
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

                  <!-- 180D LONG -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getLongCellClass('180D', item)">
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

                  <!-- 360D LONG -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getLongCellClass('360D', item)">
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
                </div>

                <!-- 2行目: SHORT (安値からの急騰率・Surge) 全6期間 (6列固定) -->
                <div class="grid grid-cols-6 gap-2">
                  <!-- 24H SHORT -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getShortCellClass('24H', item)">
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

                  <!-- 7D SHORT -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getShortCellClass('7D', item)">
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

                  <!-- 30D SHORT -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getShortCellClass('30D', item)">
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

                  <!-- 90D SHORT -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getShortCellClass('90D', item)">
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

                  <!-- 180D SHORT -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getShortCellClass('180D', item)">
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

                  <!-- 360D SHORT -->
                  <div class="p-2 rounded-lg border transition-all duration-200" :class="getShortCellClass('360D', item)">
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
            </div>

            <div class="text-[10px] text-slate-500 flex justify-between pt-1.5 border-t border-border-base/60 font-mono">
              <span>最終更新日時</span>
              <span class="text-slate-400 font-semibold" x-text="formatTime(item.updatedAt)"></span>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- 直近注文履歴 -->
    <section class="space-y-1.5" x-show="orders.length > 0">
      <div class="flex items-center justify-between px-0.5">
        <h2 class="text-xs sm:text-sm font-semibold text-slate-200 flex items-center gap-1.5">
          <span class="material-symbols-outlined text-[16px] text-telemetry">receipt_long</span>
          <span>直近注文履歴 (Hyperliquid Orders)</span>
        </h2>
        <span class="text-[11px] text-slate-400 font-mono" x-text="orders.length + ' 件'"></span>
      </div>

      <div class="bg-surface-1 border border-border-base rounded-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead class="bg-obsidian/80 text-slate-400 font-mono text-[11px] uppercase tracking-wider border-b border-border-base">
              <tr>
                <th class="px-3 py-2">日時 (JST)</th>
                <th class="px-3 py-2">通貨</th>
                <th class="px-3 py-2">売買</th>
                <th class="px-3 py-2">価格 ($)</th>
                <th class="px-3 py-2">数量</th>
                <th class="px-3 py-2">想定額 ($)</th>
                <th class="px-3 py-2">ステータス</th>
                <th class="px-3 py-2">OID / CLOID</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border-base/60 font-mono text-xs">
              <template x-for="ord in orders" :key="ord.id">
                <tr class="hover:bg-surface-2/60 transition-colors">
                  <td class="px-3 py-2 text-slate-300" x-text="ord.createdAt ? ord.createdAt.substring(5, 19).replace('T', ' ') : '---'"></td>
                  <td class="px-3 py-2 font-bold text-white" x-text="ord.coin"></td>
                  <td class="px-3 py-2 font-bold" :class="ord.side === 'BUY' ? 'text-emerald-ok' : 'text-crimson-err'" x-text="ord.side"></td>
                  <td class="px-3 py-2 text-slate-100" x-text="formatPrice(ord.price)"></td>
                  <td class="px-3 py-2 text-slate-200" x-text="ord.size"></td>
                  <td class="px-3 py-2 text-slate-200" x-text="formatPrice(ord.notionalUsd)"></td>
                  <td class="px-3 py-2">
                    <span class="px-2 py-0.5 rounded text-[10px] font-semibold"
                      :class="ord.status === 'FILLED' ? 'bg-emerald-ok/10 text-emerald-ok border border-emerald-ok/30' : 'bg-telemetry/10 text-telemetry border border-telemetry/30'"
                      x-text="ord.status"></span>
                  </td>
                  <td class="px-3 py-2 text-[10px] text-slate-500" x-text="ord.oid || ord.cloid?.substring(0, 10)"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>

  </main>

  <footer class="w-full text-center text-[11px] font-mono text-slate-600 pt-4 pb-2 border-t border-border-base/60">
    dca-deno (Deno 2.x / Hyperliquid DEX Self-Contained Worker)
  </footer>

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
              fetch('api/signals'),
              fetch('api/orders'),
              fetch('api/system-status'),
              fetch('api/health'),
            ]);
            if (healthRes.ok) {
              const healthData = await healthRes.json();
              this.redisConnected = Boolean(healthData.redisConnected);
            }
            if (statsRes.ok) {
              const fetchedList = await statsRes.json();
              if (Array.isArray(fetchedList)) {
                this.statsList = fetchedList.map((newItem) => {
                  const existing = this.statsList.find(s => s.coin.toUpperCase() === newItem.coin.toUpperCase());
                  // 既にSSEでより新しい現在価格を受信している場合はそれを優先・維持
                  if (existing && existing.currentPrice && typeof existing.currentPrice === 'number') {
                    newItem.currentPrice = existing.currentPrice;
                  }
                  return newItem;
                });
              }
            }
            if (signalsRes.ok) {
              this.signals = await signalsRes.json();
            }
            if (ordersRes.ok) {
              this.orders = await ordersRes.json();
            }
            if (sysRes.ok) {
              const sys = await sysRes.json();
              this.insufficientCooldown = sys.insufficientCooldown;
            }
          } catch (e) {
            console.error('データ取得エラー:', e);
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

        formatPrice(val) {
          if (val === null || val === undefined || isNaN(val) || Number(val) <= 0) return '---';
          const num = Math.round(Number(val));
          return '$' + num.toLocaleString('en-US');
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
            return 'border-emerald-ok bg-emerald-ok/10 shadow-[0_0_12px_-3px_rgba(16,185,129,0.25)] ring-1 ring-emerald-ok/40';
          }
          const sig = this.getActiveSignal(item?.coin, tf, 'LONG');
          if (sig) {
            return sig.status === 'EXECUTED'
              ? 'border-emerald-ok/60 bg-emerald-ok/10 ring-1 ring-emerald-ok/30'
              : 'border-amber-warn/60 bg-amber-warn/10 ring-1 ring-amber-warn/30';
          }
          return 'bg-obsidian/70 border-border-base/80';
        },

        getShortCellClass(tf, item) {
          if (this.isShortEligible(tf, item)) {
            return 'border-crimson-err bg-crimson-err/10 shadow-[0_0_12px_-3px_rgba(244,63,94,0.25)] ring-1 ring-crimson-err/40';
          }
          const sig = this.getActiveSignal(item?.coin, tf, 'SHORT');
          if (sig) {
            return sig.status === 'EXECUTED'
              ? 'border-crimson-err/60 bg-crimson-err/10 ring-1 ring-crimson-err/30'
              : 'border-amber-warn/60 bg-amber-warn/10 ring-1 ring-amber-warn/30';
          }
          return 'bg-obsidian/70 border-border-base/80';
        },

        isLongEligible(tf, item) {
          if (!item || !item.currentPrice || Number(item.currentPrice) <= 0) return false;
          const currentPx = Number(item.currentPrice);
          const maxPx = Number(item['maxPrice' + tf.toLowerCase()]);
          if (!maxPx || maxPx <= 0) return false;
          const dipPct = ((maxPx - currentPx) / maxPx) * 100;
          if (dipPct < this.getLongThreshold(tf)) return false;
          if (tf === '24H') return true;
          const max24h = Number(item.maxPrice24h);
          if (!max24h || max24h <= 0) return false;
          const dip24hPct = ((max24h - currentPx) / max24h) * 100;
          const addDipLimit = Number(this.config?.additionalDipThreshold24h ?? 3.82);
          return dip24hPct >= addDipLimit;
        },

        isShortEligible(tf, item) {
          if (!item || !item.currentPrice || Number(item.currentPrice) <= 0) return false;
          const currentPx = Number(item.currentPrice);
          const minPx = Number(item['minPrice' + tf.toLowerCase()]);
          if (!minPx || minPx <= 0) return false;
          const surgePct = ((currentPx - minPx) / minPx) * 100;
          if (surgePct < this.getShortThreshold(tf)) return false;
          if (tf === '24H') return true;
          const min24h = Number(item.minPrice24h);
          if (!min24h || min24h <= 0) return false;
          const surge24hPct = ((currentPx - min24h) / min24h) * 100;
          const addSurgeLimit = Number(this.config?.additionalSurgeThreshold24h ?? 3.82);
          return surge24hPct >= addSurgeLimit;
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
