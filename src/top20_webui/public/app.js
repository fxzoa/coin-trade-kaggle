/**
 * Crypto TOP 20 Volume Tracker - Frontend Application
 *
 * Visualizes past 24-hour trading volume totals and averages for market cap TOP 20 cryptocurrencies,
 * querying historical and latest records from Deno KV via REST API at 1-hour intervals.
 *
 * X-axis formatting:
 * - 24 Hours: Hourly format (HH:mm)
 * - 30 Days: Daily format (MM/DD)
 * - All Data: Monthly format (YYYY/MM)
 */

'use strict';

(function () {
  // Application State
  const state = {
    timeframe: '24h',       // '24h' | '30d' | 'all'
    autoRefresh: true,
    refreshIntervalSec: 60,
    countdownSec: 60,
    timerId: null,
    countdownTimerId: null,
    isLoading: false,
    chart: null,
    latestData: null,
    historyData: [],
    lastFetchTime: null
  };

  // DOM Elements Cache
  const elements = {
    // Buttons & Controls
    timeframeBtns: document.querySelectorAll('.btn-timeframe'),
    lastUpdatedTime: document.getElementById('lastUpdatedTime'),
    retryBtn: document.getElementById('retryBtn'),
    chartTimeframeTag: document.getElementById('chartTimeframeTag'),

    // Stat Cards
    statTotalVolume: document.getElementById('statTotalVolume'),
    statTotalVolumeChange: document.getElementById('statTotalVolumeChange'),
    statAvgVolume: document.getElementById('statAvgVolume'),
    statAvgVolumeChange: document.getElementById('statAvgVolumeChange'),
    statGainers: document.getElementById('statGainers'),
    statLosers: document.getElementById('statLosers'),
    statMomentumBar: document.getElementById('statMomentumBar'),
    statMomentumCaption: document.getElementById('statMomentumCaption'),
    statLastUpdated: document.getElementById('statLastUpdated'),
    statTimeAgo: document.getElementById('statTimeAgo'),

    // Chart & Overlays
    chartCanvas: document.getElementById('volumeChart'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    errorOverlay: document.getElementById('errorOverlay'),
    errorMessage: document.getElementById('errorMessage'),
    emptyOverlay: document.getElementById('emptyOverlay'),

    // Footer
    connectionStatusIndicator: document.getElementById('connectionStatusIndicator'),
    connectionStatusText: document.getElementById('connectionStatusText')
  };

  /* ==========================================================================
     Formatters & Utilities
     ========================================================================== */

  function formatCurrencyCompact(num, decimals = 2) {
    if (num === null || num === undefined || isNaN(num)) return '--';
    const absVal = Math.abs(num);

    if (absVal >= 1e9) {
      return `$${(num / 1e9).toFixed(decimals)}B`;
    } else if (absVal >= 1e6) {
      return `$${(num / 1e6).toFixed(decimals)}M`;
    } else if (absVal >= 1e3) {
      return `$${(num / 1e3).toFixed(decimals)}K`;
    }
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  }

  function formatCurrencyFull(num) {
    if (num === null || num === undefined || isNaN(num)) return '--';
    return `$${Math.round(num).toLocaleString('en-US')}`;
  }

  function formatTimestampJst(timestamp) {
    if (!timestamp) return '--';
    const d = new Date(timestamp);
    return d.toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  /**
   * Format X-axis tick / data label by timeframe
   * - 24h: 時間単位 (例: 15:00 または 15時)
   * - 30d: 日単位 (例: 11/13)
   * - all: 月単位 (例: 2026/11)
   */
  function formatChartLabelJst(timestamp, timeframe) {
    const d = new Date(timestamp);

    if (timeframe === '24h') {
      const jstDate = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        hour12: false
      }).format(d);
      return `${jstDate}:00`;
    }

    if (timeframe === '30d') {
      return d.toLocaleDateString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: '2-digit',
        day: '2-digit'
      });
    }

    // all: 月単位
    return d.toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit'
    });
  }

  function formatRelativeTime(date) {
    if (!date) return '未取得';
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffSec < 5) return 'たった今更新';
    if (diffSec < 60) return `${diffSec}秒前に更新`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}分前に更新`;
    const diffHours = Math.floor(diffMin / 60);
    return `${diffHours}時間前に更新`;
  }

  /* ==========================================================================
     Data Fetching & State Updates
     ========================================================================== */

  async function fetchDashboardData() {
    if (state.isLoading) return;
    state.isLoading = true;
    showLoading();

    try {
      let limit = 24;
      if (state.timeframe === '30d') limit = 720; // 30 days * 24 hours
      else if (state.timeframe === 'all') limit = 1000;

      const [latestRes, historyRes] = await Promise.all([
        fetch('/api/latest').then((r) => r.json()),
        fetch(`/api/history?limit=${limit}&order=desc`).then((r) => r.json())
      ]);

      if (!latestRes.success) {
        throw new Error(latestRes.error || 'Failed to fetch latest record');
      }
      if (!historyRes.success) {
        throw new Error(historyRes.error || 'Failed to fetch historical data');
      }

      state.latestData = latestRes.data;
      state.historyData = (historyRes.data || []).slice().reverse();
      state.lastFetchTime = new Date();

      updateUI();
      hideOverlays();
      updateConnectionStatus(true);
    } catch (err) {
      console.error('Fetch error:', err);
      showError(err.message || 'データ取得エラーが発生しました');
      updateConnectionStatus(false);
    } finally {
      state.isLoading = false;
      resetCountdown();
    }
  }

  /* ==========================================================================
     UI Rendering
     ========================================================================== */

  function updateUI() {
    updateTag();
    updateStatCards();
    renderChart();
  }

  function updateTag() {
    if (!elements.chartTimeframeTag) return;
    if (state.timeframe === '24h') {
      elements.chartTimeframeTag.textContent = '1時間ごと記録 (X軸: 時間単位)';
    } else if (state.timeframe === '30d') {
      elements.chartTimeframeTag.textContent = '過去30日間記録 (X軸: 日単位)';
    } else {
      elements.chartTimeframeTag.textContent = '全期間記録 (X軸: 月単位)';
    }
  }

  function updateStatCards() {
    const latest = state.latestData;
    const history = state.historyData;

    if (!latest) {
      elements.statTotalVolume.textContent = '--';
      elements.statTotalVolumeChange.textContent = '--';
      elements.statAvgVolume.textContent = '--';
      elements.statAvgVolumeChange.textContent = '--';
      elements.statGainers.textContent = '--';
      elements.statLosers.textContent = '--';
      elements.statLastUpdated.textContent = '--';
      elements.statTimeAgo.textContent = 'データなし';
      return;
    }

    // 1. Total 24h Volume & Previous Hour Change
    const totalVol = latest.total_volume_24h ?? latest.total_volume_1h ?? 0;
    elements.statTotalVolume.textContent = formatCurrencyCompact(totalVol, 2);
    elements.statTotalVolume.title = formatCurrencyFull(totalVol);

    // 2. Average 24h Volume
    const avgVol = latest.average_volume_24h ?? latest.average_volume_1h ?? (totalVol / 20);
    elements.statAvgVolume.textContent = formatCurrencyCompact(avgVol, 2);
    elements.statAvgVolume.title = formatCurrencyFull(avgVol);

    // Calculate percentage change from previous hourly record
    if (history.length >= 2) {
      const prev = history[history.length - 2];
      const prevTotal = prev.total_volume_24h ?? prev.total_volume_1h ?? 0;
      if (prevTotal > 0) {
        const diffTotalPercent = ((totalVol - prevTotal) / prevTotal) * 100;
        setChangeBadge(elements.statTotalVolumeChange, diffTotalPercent);
      }

      const prevAvg = prev.average_volume_24h ?? prev.average_volume_1h ?? 0;
      if (prevAvg > 0) {
        const diffAvgPercent = ((avgVol - prevAvg) / prevAvg) * 100;
        setChangeBadge(elements.statAvgVolumeChange, diffAvgPercent);
      }
    } else {
      elements.statTotalVolumeChange.textContent = '前時比 --';
      elements.statTotalVolumeChange.className = 'card-change';
      elements.statAvgVolumeChange.textContent = '前時比 --';
      elements.statAvgVolumeChange.className = 'card-change';
    }

    // 3. Momentum (Gainers / Losers)
    const upCount = latest.up_count ?? 0;
    const downCount = latest.down_count ?? 0;
    const topCount = latest.top_count ?? 20;

    elements.statGainers.textContent = `${upCount}`;
    elements.statLosers.textContent = `${downCount}`;

    const totalTracked = upCount + downCount;
    const gainerPercent = totalTracked > 0 ? (upCount / totalTracked) * 100 : 50;
    elements.statMomentumBar.style.width = `${Math.min(Math.max(gainerPercent, 0), 100)}%`;
    elements.statMomentumCaption.textContent = `TOP${topCount}通貨中 ${upCount}上昇 / ${downCount}下落`;

    // 4. Last Updated Timestamp
    elements.statLastUpdated.textContent = formatTimestampJst(latest.timestamp);
    elements.statTimeAgo.textContent = formatRelativeTime(state.lastFetchTime);
  }

  function setChangeBadge(element, percent) {
    const isPositive = percent > 0;
    const isZero = Math.abs(percent) < 0.01;
    const sign = isPositive ? '+' : '';
    element.textContent = `${sign}${percent.toFixed(2)}% (前時比)`;
    element.className = 'card-change ' + (isZero ? 'neutral' : (isPositive ? 'positive' : 'negative'));
  }

  /* ==========================================================================
     Chart.js Rendering
     ========================================================================== */

  function renderChart() {
    const records = state.historyData;

    if (!records || records.length === 0) {
      if (elements.emptyOverlay) elements.emptyOverlay.style.display = 'flex';
      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      }
      return;
    }

    if (elements.emptyOverlay) elements.emptyOverlay.style.display = 'none';

    // Raw formatted labels
    const rawLabels = records.map((r) => formatChartLabelJst(r.timestamp, state.timeframe));
    const totalVolumes = records.map((r) => r.total_volume_24h ?? r.total_volume_1h ?? 0);

    // Calculate timeframe average
    const sum = totalVolumes.reduce((acc, v) => acc + v, 0);
    const avg = totalVolumes.length > 0 ? sum / totalVolumes.length : 0;
    const avgLineData = records.map(() => avg);

    // Destroy and recreate chart on timeframe switch to reconfigure tick callback cleanly
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }

    const ctx = elements.chartCanvas.getContext('2d');

    // Create subtle gradient fill under volume curve
    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.00)');

    state.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: rawLabels,
        datasets: [
          {
            label: 'TOP20 過去24H取引量合計 (USD)',
            data: totalVolumes,
            borderColor: '#38bdf8',
            backgroundColor: gradient,
            borderWidth: 2.5,
            fill: true,
            tension: 0.25,
            pointRadius: records.length > 50 ? 0 : 3.5,
            pointHoverRadius: 6,
            pointBackgroundColor: '#38bdf8',
            pointBorderColor: '#0f172a',
            pointBorderWidth: 2,
          },
          {
            label: '期間平均値',
            data: avgLineData,
            borderColor: 'rgba(148, 163, 184, 0.65)',
            borderWidth: 1.5,
            borderDash: [6, 6],
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.92)',
            titleColor: '#f8fafc',
            bodyColor: '#cbd5e1',
            borderColor: 'rgba(56, 189, 248, 0.3)',
            borderWidth: 1,
            padding: 12,
            boxPadding: 6,
            callbacks: {
              title: function (items) {
                if (!items.length) return '';
                const idx = items[0].dataIndex;
                return formatTimestampJst(records[idx].timestamp);
              },
              label: function (context) {
                const val = context.raw;
                if (context.datasetIndex === 0) {
                  return ` 24H合計取引量: ${formatCurrencyCompact(val, 2)} (${formatCurrencyFull(val)})`;
                }
                return ` 期間平均: ${formatCurrencyCompact(val, 2)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(51, 65, 85, 0.3)',
              drawBorder: false
            },
            ticks: {
              color: '#94a3b8',
              font: {
                family: "'JetBrains Mono', monospace",
                size: 11
              },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: state.timeframe === '24h' ? 12 : (state.timeframe === '30d' ? 15 : 12),
              callback: function (value, index) {
                const currentLabel = rawLabels[index];
                // For 30d and all, suppress duplicate consecutive date / month labels
                if (state.timeframe === '30d' || state.timeframe === 'all') {
                  if (index > 0 && currentLabel === rawLabels[index - 1]) {
                    return '';
                  }
                }
                return currentLabel;
              }
            }
          },
          y: {
            grid: {
              color: 'rgba(51, 65, 85, 0.3)',
              drawBorder: false
            },
            ticks: {
              color: '#94a3b8',
              font: {
                family: "'JetBrains Mono', monospace",
                size: 11
              },
              callback: function (value) {
                return formatCurrencyCompact(value, 1);
              }
            }
          }
        }
      }
    });
  }

  /* ==========================================================================
     UI Helpers & Overlays
     ========================================================================== */

  function showLoading() {
    if (elements.loadingOverlay) elements.loadingOverlay.style.display = 'flex';
    if (elements.errorOverlay) elements.errorOverlay.style.display = 'none';
  }

  function hideOverlays() {
    if (elements.loadingOverlay) elements.loadingOverlay.style.display = 'none';
    if (elements.errorOverlay) elements.errorOverlay.style.display = 'none';
  }

  function showError(msg) {
    if (elements.loadingOverlay) elements.loadingOverlay.style.display = 'none';
    if (elements.errorOverlay) {
      elements.errorOverlay.style.display = 'flex';
      elements.errorMessage.textContent = msg;
    }
  }

  function updateConnectionStatus(isOnline) {
    if (elements.connectionStatusIndicator) {
      elements.connectionStatusIndicator.className = 'status-indicator ' + (isOnline ? 'online' : 'offline');
    }
    if (elements.connectionStatusText) {
      elements.connectionStatusText.textContent = isOnline ? 'Deno KV 接続中' : '接続エラー';
    }
  }

  /* ==========================================================================
     Timers & Auto-Refresh (Hourly at :01:00)
     ========================================================================== */

  function updateLastUpdatedTimeUI() {
    if (elements.lastUpdatedTime) {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      elements.lastUpdatedTime.textContent = `更新: ${hh}:${mm}:${ss}`;
    }
  }

  function resetCountdown() {
    updateLastUpdatedTimeUI();
  }

  function getMsUntilNextHourlyUpdate() {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(1, 0, 0);
    if (now.getTime() >= next.getTime()) {
      next.setHours(next.getHours() + 1);
    }
    return next.getTime() - now.getTime();
  }

  function startTimers() {
    stopTimers();
    const delayMs = getMsUntilNextHourlyUpdate();
    state.countdownTimerId = setTimeout(() => {
      fetchDashboardData();
      startTimers();
    }, delayMs);
  }

  function stopTimers() {
    if (state.countdownTimerId) {
      clearTimeout(state.countdownTimerId);
      state.countdownTimerId = null;
    }
  }

  /* ==========================================================================
     Event Listeners
     ========================================================================== */

  function setupEventListeners() {
    // Timeframe selector buttons
    elements.timeframeBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget;
        const newTimeframe = target.dataset.timeframe;
        if (state.timeframe === newTimeframe) return;

        elements.timeframeBtns.forEach((b) => b.classList.remove('active'));
        target.classList.add('active');

        state.timeframe = newTimeframe;
        fetchDashboardData();
      });
    });

    // Retry button
    if (elements.retryBtn) {
      elements.retryBtn.addEventListener('click', () => {
        fetchDashboardData();
      });
    }

    // Relative time updater (every 10 seconds)
    setInterval(() => {
      if (state.lastFetchTime && elements.statTimeAgo) {
        elements.statTimeAgo.textContent = formatRelativeTime(state.lastFetchTime);
      }
    }, 10000);
  }

  /* ==========================================================================
     Initialization
     ========================================================================== */

  function init() {
    setupEventListeners();
    startTimers();
    fetchDashboardData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
