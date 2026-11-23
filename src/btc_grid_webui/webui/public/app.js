/**
 * BTC Grid Bot Dashboard - Client Application Logic
 * Fetches real-time market data, positions, active grid orders, and trade history.
 */

// State
let autoRefreshEnabled = true;
let refreshIntervalSeconds = 5;
let remainingCountdown = refreshIntervalSeconds;
let refreshTimerId = null;
let currentTabFilter = 'all';

let cachedOrders = [];
let cachedHistory = [];
let latestBotConfig = null;
let latestPosition = null;
let eventSource = null;

// DOM Elements
const elPrice = document.getElementById('statPrice');
const elPriceChange = document.getElementById('statPriceChange');
const elPositionSide = document.getElementById('statPositionSide');
const elPositionSize = document.getElementById('statPositionSize');
const elUnrealizedPnl = document.getElementById('statUnrealizedPnl');
const elEntryPrice = document.getElementById('statEntryPrice');
const elNotionalUsd = document.getElementById('statNotionalUsd');

const elActiveOrdersCount = document.getElementById('statActiveOrdersCount');
const elGridConfigBadge = document.getElementById('statGridConfigBadge');
const elGridOrderSize = document.getElementById('statGridOrderSize');
const elLastAction = document.getElementById('statLastAction');
const elNextTargetLevel = document.getElementById('statNextTargetLevel');

const elTotalRealizedPnl = document.getElementById('statTotalRealizedPnl');
const elFillsCount = document.getElementById('statFillsCount');
const elLastScanTime = document.getElementById('statLastScanTime');

const elOrdersBadge = document.getElementById('activeOrdersBadge');
const elOrdersTableBody = document.getElementById('ordersTableBody');

const elErrorsBadge = document.getElementById('activeErrorsBadge');
const elErrorsTableBody = document.getElementById('errorsTableBody');
const elTabOrdersBtn = document.getElementById('tabOrdersBtn');
const elTabErrorsBtn = document.getElementById('tabErrorsBtn');
const elOrdersPanelContent = document.getElementById('ordersPanelContent');
const elErrorsPanelContent = document.getElementById('errorsPanelContent');
const elPanelLegendOrders = document.getElementById('panelLegendOrders');
const elPanelControlsErrors = document.getElementById('panelControlsErrors');
const elRefreshErrorsBtn = document.getElementById('refreshErrorsBtn');
const elClearErrorsBtn = document.getElementById('clearErrorsBtn');

let currentActiveTab = 'orders';

const elBotStatusText = document.getElementById('botStatusText');
const elAutoRefreshToggle = document.getElementById('autoRefreshToggle');
const elCountdown = document.getElementById('refreshTimerCountdown');
const elRefreshBtn = document.getElementById('refreshBtn');
const elConnIndicator = document.getElementById('connIndicator');
const elConnText = document.getElementById('connText');
const elNetworkBadge = document.getElementById('networkBadge');

const elSsePill = document.getElementById('sseStatusPill');
const elSseText = document.getElementById('sseStatusText');

/**
 * Non-blocking corner error popup (fixed top-right)
 */
const CORNER_ERROR_ID = 'cornerErrorPopup';

function showCornerError(title, message) {
  if (typeof document === 'undefined' || !document.body) return;
  let el = document.getElementById(CORNER_ERROR_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CORNER_ERROR_ID;
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position: fixed',
      'top: 16px',
      'right: 16px',
      'z-index: 99999',
      'max-width: 380px',
      'min-width: 260px',
      'background: #131926',
      'border: 1px solid #F43F5E',
      'border-left: 4px solid #F43F5E',
      'border-radius: 8px',
      'padding: 12px 14px',
      'color: #F8FAFC',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 13px',
      'line-height: 1.45',
      'box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5)',
    ].join(';');
    document.body.appendChild(el);
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  el.innerHTML = '';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;';

  const titleEl = document.createElement('strong');
  titleEl.style.cssText = 'color:#FB7185;font-size:13px;font-weight:700;';
  titleEl.textContent = title || 'データ取得異常';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '閉じる');
  closeBtn.style.cssText = 'background:transparent;border:none;color:#94A3B8;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;';
  closeBtn.addEventListener('click', clearCornerError);

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'color:#E2E8F0;word-break:break-word;margin-bottom:6px;';
  msgEl.textContent = message || '異常なレスポンスを検出しました';

  const timeEl = document.createElement('div');
  timeEl.style.cssText = 'color:#94A3B8;font-size:11px;font-family:monospace;';
  timeEl.textContent = `検出時刻: ${ts}`;

  el.appendChild(header);
  el.appendChild(msgEl);
  el.appendChild(timeEl);
  el.style.display = 'block';
}

function clearCornerError() {
  const el = document.getElementById(CORNER_ERROR_ID);
  if (el) el.style.display = 'none';
}

async function fetchJsonChecked(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, data: null, error: `${url}: HTTP ${res.status}` };
    }
    const json = await res.json();
    if (!json || typeof json !== 'object') {
      return { ok: false, data: null, error: `${url}: 不正なJSONレスポンス` };
    }
    return { ok: true, data: json, error: null };
  } catch (err) {
    return { ok: false, data: null, error: `${url}: ${err.message || '通信/パースエラー'}` };
  }
}

/**
 * Format currency with commas and decimals
 */
function formatUsd(val, decimals = 2) {
  if (val === undefined || val === null || isNaN(val)) return '$ --';
  return '$' + Number(val).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Render 24h price change percentage badge
 */
function renderPriceChangeTag(targetEl, changePct) {
  if (!targetEl || changePct === undefined || changePct === null) return;
  const chg = Number(changePct);
  if (isNaN(chg)) return;

  const sign = chg > 0 ? '+' : '';
  const cls = chg > 0 ? 'positive' : chg < 0 ? 'negative' : 'neutral';
  targetEl.innerHTML = `<span class="change-tag ${cls}">${sign}${chg.toFixed(2)}% (24H)</span>`;
}

/**
 * Format BTC amount
 */
function formatBtc(val, decimals = 4) {
  if (val === undefined || val === null || isNaN(val)) return '0.0000';
  return Number(val).toFixed(decimals);
}

/**
 * Format timestamp into readable JST string
 */
function formatJst(isoStr) {
  if (!isoStr) return '--';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return isoStr;
  }
}

/**
 * Shorten hash or cloid for clean display
 */
function shortId(id, len = 8) {
  if (id === undefined || id === null || id === '') return '--';
  const str = String(id);
  if (str.length <= len * 2) return str;
  return `${str.slice(0, len)}...${str.slice(-len)}`;
}
const shortenId = shortId;

/**
 * Fetch all dashboard endpoints in parallel
 */
async function fetchDashboardData() {
  let resStatusWrap;
  let resPositionsWrap;
  let resOrdersWrap;
  let resHistoryWrap;

  try {
    [resStatusWrap, resPositionsWrap, resOrdersWrap, resHistoryWrap] = await Promise.all([
      fetchJsonChecked('api/status'),
      fetchJsonChecked('api/positions'),
      fetchJsonChecked('api/orders'),
      fetchJsonChecked('api/history'),
    ]);
  } catch (netErr) {
    console.error('[Dashboard] Network fetch error:', netErr);
    updateConnectionStatus(false);
    showCornerError('通信エラー', netErr.message || 'API データの取得に失敗しました');
    return;
  }

  const resStatus = resStatusWrap.data;
  const resPositions = resPositionsWrap.data;
  const resOrders = resOrdersWrap.data;
  const resHistory = resHistoryWrap.data;

  const anomalies = [];
  if (!resStatusWrap.ok) {
    anomalies.push(resStatusWrap.error);
  } else if (!resStatus.success || !resStatus.data || typeof resStatus.data !== 'object') {
    anomalies.push('api/status: ステータスデータが不正または欠損');
  } else {
    const price = Number(resStatus.data.currentPrice);
    if (!Number.isFinite(price) || price <= 0) {
      anomalies.push('api/status: BTC現在価格が異常(NaNまたは0以下)');
    }
  }

  if (!resPositionsWrap.ok) {
    anomalies.push(resPositionsWrap.error);
  } else if (!resPositions.success || !resPositions.data || typeof resPositions.data !== 'object') {
    anomalies.push('api/positions: ポジションデータが不正または欠損');
  }

  if (!resOrdersWrap.ok) {
    anomalies.push(resOrdersWrap.error);
  } else if (!resOrders.success || !resOrders.data || typeof resOrders.data !== 'object') {
    anomalies.push('api/orders: 注文データが不正または欠損');
  } else {
    const d = resOrders.data;
    const hasInvalidArr =
      (d.exchangeActiveOrders !== undefined && !Array.isArray(d.exchangeActiveOrders)) ||
      (d.activeOrders !== undefined && !Array.isArray(d.activeOrders)) ||
      (d.recentGridOrders !== undefined && !Array.isArray(d.recentGridOrders));
    if (hasInvalidArr) {
      anomalies.push('api/orders: 注文配列の形式が不正');
    }
  }

  if (!resHistoryWrap.ok) {
    anomalies.push(resHistoryWrap.error);
  } else if (!resHistory.success || !resHistory.data || typeof resHistory.data !== 'object') {
    anomalies.push('api/history: 履歴データが不正または欠損');
  } else if (resHistory.data.fills !== undefined && !Array.isArray(resHistory.data.fills)) {
    anomalies.push('api/history: 約定履歴(fills)が配列ではありません');
  }

  if (anomalies.length > 0) {
    showCornerError('データ異常検知', anomalies.join(' / '));
  } else {
    clearCornerError();
  }

  const isConnected = Boolean(
    (resStatus && resStatus.success) ||
    (resPositions && resPositions.success) ||
    (resOrders && resOrders.success) ||
    (resHistory && resHistory.success)
  );

  updateConnectionStatus(isConnected);

  // Update Redis Pill Status
  const elRedisDot = document.getElementById('redisStatusDot');
  const elRedisText = document.getElementById('redisStatusText');
  if (elRedisDot && elRedisText) {
    if (isConnected) {
      elRedisDot.style.background = '#10b981';
      elRedisDot.style.boxShadow = '0 0 6px #10b981';
      elRedisText.style.color = '#10b981';
      elRedisText.textContent = 'Redis 🟢';
    } else {
      elRedisDot.style.background = '#ef4444';
      elRedisDot.style.boxShadow = '0 0 6px #ef4444';
      elRedisText.style.color = '#ef4444';
      elRedisText.textContent = 'Redis 🔴';
    }
  }

  if (resStatus && resStatus.success) {
    try {
      renderStatus(resStatus.data);
    } catch (err) {
      console.error('[Dashboard] Error rendering status:', err);
    }
  }

  if (resPositions && resPositions.success) {
    try {
      renderPositions(resPositions.data);
    } catch (err) {
      console.error('[Dashboard] Error rendering positions:', err);
    }
  }

  if (resOrders && resOrders.success) {
    try {
      renderOrders(resOrders.data);
    } catch (err) {
      console.error('[Dashboard] Error rendering orders:', err);
    }
  }

  if (resHistory && resHistory.success) {
    try {
      renderHistory(resHistory.data);
    } catch (err) {
      console.error('[Dashboard] Error rendering history:', err);
    }
  }

  fetchErrorsData();
}

/**
 * Fetch and Render Error Logs
 */
async function fetchErrorsData() {
  try {
    const res = await fetch('api/errors?limit=100');
    if (!res.ok) return;
    const json = await res.json();
    const errors = json.errors || [];
    if (elErrorsBadge) elErrorsBadge.textContent = errors.length;
    renderErrorsTable(errors);
  } catch (err) {
    console.error('[Dashboard] Failed to fetch errors:', err);
  }
}

function renderErrorsTable(errors) {
  if (!elErrorsTableBody) return;

  if (!errors || errors.length === 0) {
    elErrorsTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">現在記録されたエラーログはありません (正常稼働中)</td>
      </tr>
    `;
    return;
  }

  elErrorsTableBody.innerHTML = errors.map((err) => {
    const timeStr = err.timestamp ? formatJst(err.timestamp) : '--';
    const service = err.service || 'btc-grid-bot';
    const context = err.context || 'General';
    const msg = err.message || JSON.stringify(err);
    const stack = err.stack ? `<pre style="margin-top: 4px; font-size: 10px; color: #fca5a5; background: rgba(0,0,0,0.5); padding: 4px; border-radius: 4px; overflow-x: auto;">${err.stack}</pre>` : '';

    return `
      <tr>
        <td class="mono" style="font-size: 10px; color: #94a3b8; white-space: nowrap;">${timeStr}</td>
        <td class="mono" style="font-weight: bold; color: #cbd5e1; font-size: 11px;">${service}</td>
        <td class="mono" style="color: #f87171; font-weight: 600; font-size: 11px;">${context}</td>
        <td style="color: #fecdd3;">
          <div style="font-weight: 500;">${msg}</div>
          ${stack}
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Render Bot Status & Header Cards
 */
function renderStatus(data) {
  if (!data) return;

  const currentPrice = Number(data.currentPrice) || 0;
  if (currentPrice > 0) {
    elPrice.textContent = formatUsd(currentPrice, 0);
  }

  // Render 24H Price Change
  renderPriceChangeTag(elPriceChange, data.priceChange24h);

  const cfg = data.config || {};
  latestBotConfig = cfg;
  if (cfg.gridStepUsd) {
    elGridConfigBadge.textContent = `Step $${Number(cfg.gridStepUsd).toLocaleString()}`;
  }
  if (cfg.gridOrderSizeUsd) {
    elGridOrderSize.innerHTML = `1注文あたり: <strong>$${Number(cfg.gridOrderSizeUsd).toLocaleString()} USD</strong>`;
  }
  if (cfg.isMainnet !== undefined && elNetworkBadge) {
    elNetworkBadge.textContent = cfg.isMainnet ? 'Hyperliquid Mainnet' : 'Hyperliquid Testnet';
  }

  // 証拠金不足クールダウンバッジの制御
  const elInsufficientPill = document.getElementById('insufficientStatusPill');
  const elInsufficientText = document.getElementById('insufficientStatusText');
  if (elInsufficientPill && elInsufficientText) {
    if (data.insufficientCooldown?.active) {
      elInsufficientPill.style.display = 'inline-flex';
      const m = data.insufficientCooldown.remainingSec ? `(${Math.ceil(data.insufficientCooldown.remainingSec / 60)}m)` : '';
      elInsufficientText.textContent = `🚨 証拠金不足停止中 ${m}`.trim();
      elInsufficientPill.title = data.insufficientCooldown.reason || '証拠金不足により一時停止中';
    } else {
      elInsufficientPill.style.display = 'none';
    }
  }

  // Last run information
  const lastRun = data.lastRun?.result || data.lastRun || {};
  if (lastRun.timestamp) {
    elLastScanTime.textContent = formatJst(lastRun.timestamp);
  }
  if (lastRun.gridAction) {
    elLastAction.textContent = lastRun.gridAction;
    elLastAction.style.color =
      lastRun.gridAction === 'PLACE' ? 'var(--accent-green)' :
      lastRun.gridAction === 'KEEP' ? 'var(--text-main)' : 'var(--btc-orange)';
  }
  if (lastRun.gridLevel) {
    elNextTargetLevel.textContent = formatUsd(lastRun.gridLevel, 0);
  } else if (currentPrice > 0 && cfg.gridStepUsd) {
    const step = cfg.gridStepUsd;
    const nextLevel = Math.floor(currentPrice / step) * step - step;
    elNextTargetLevel.textContent = formatUsd(nextLevel, 0);
  }
}

/**
 * Render Position and Unrealized PnL
 */
function renderPositions(data) {
  if (!data) return;

  const pos = data.position;
  latestPosition = pos;
  const currentPrice = Number(data.currentPrice) || 0;

  if (currentPrice > 0 && elPrice.textContent === '$ --') {
    elPrice.textContent = formatUsd(currentPrice, 0);
  }
  if (elPriceChange && elPriceChange.textContent.includes('--')) {
    renderPriceChangeTag(elPriceChange, data.priceChange24h);
  }

  if (pos && pos.size > 0) {
    elPositionSide.textContent = pos.side || 'LONG';
    elPositionSize.innerHTML = `${formatBtc(pos.size, 2)} <span class="unit">${pos.coin || 'BTC'}</span>`;
    elEntryPrice.textContent = formatUsd(pos.entryPrice);
    elNotionalUsd.textContent = formatUsd(pos.notionalUsd, 0);

    const uPnl = Number(pos.unrealizedPnl) || 0;
    const uPnlPct = Number(pos.unrealizedPnlPct) || 0;
    const pnlSign = uPnl >= 0 ? '+' : '';
    const pnlClass = uPnl > 0 ? 'positive' : uPnl < 0 ? 'negative' : 'neutral';

    elUnrealizedPnl.innerHTML = `未実現損益: <span class="pnl-val ${pnlClass}">${pnlSign}${formatUsd(uPnl, 0)} (${pnlSign}${uPnlPct.toFixed(1)}%)</span>`;
  } else {
    elPositionSide.textContent = 'NO POSITION';
    elPositionSize.innerHTML = `0.00 <span class="unit">BTC</span>`;
    elEntryPrice.textContent = '$ --';
    elNotionalUsd.textContent = '$0';
    elUnrealizedPnl.innerHTML = `未実現損益: <span class="pnl-val neutral">$0 (0.0%)</span>`;
  }
}

/**
 * Render Active Grid Orders Table
 */
function renderOrders(data) {
  if (!data) return;

  const activeOrders = data.activeOrders || [];
  const recentOrders = data.recentGridOrders || [];
  const exchangeOrders = data.exchangeActiveOrders || [];

  // Hyperliquid取引所APIから同期された実オープン注文(exchangeActiveOrders)を最優先で表示
  let displayList = exchangeOrders;
  if (!displayList || displayList.length === 0) {
    displayList = activeOrders;
  }
  if (!displayList || displayList.length === 0) {
    displayList = recentOrders.filter((o) => o.status === 'OPEN');
  }

  cachedOrders = displayList.length > 0 ? displayList : [];
  const count = displayList.length;

  elActiveOrdersCount.innerHTML = `${count} <span class="unit">件</span>`;
  elOrdersBadge.textContent = count;

  if (!cachedOrders || cachedOrders.length === 0) {
    elOrdersTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">現在未約定の節目指値注文はありません</td>
      </tr>
    `;
    return;
  }

  elOrdersTableBody.innerHTML = cachedOrders.map((o) => {
    const priceNum = Number(o.price ?? o.limitPrice ?? 0);
    const levelNum = Number(o.level ?? o.limitPrice ?? o.price ?? 0);
    const sizeNum = Number(o.size ?? 0);
    const notionalNum = Number(o.notionalUsd ?? (priceNum * sizeNum));

    const levelStr = levelNum > 0 ? formatUsd(levelNum, 0) : '$ --';
    const priceStr = priceNum > 0 ? formatUsd(priceNum) : '$ --';
    const sizeStr = formatBtc(sizeNum);
    const notionalStr = notionalNum > 0 ? formatUsd(notionalNum, 0) : '$ --';
    const statusVal = o.status || 'OPEN';
    const statusClass = statusVal.toLowerCase();
    const cloidStr = o.cloid || (o.orderId ? '#' + o.orderId : o.id) || '--';
    const rawTime = o.createdAt || o.updatedAt || o.timestamp;
    const timeStr = formatJst(rawTime);
    const targetKey = String(o.cloid || o.orderId || o.id || '');

    return `
      <tr>
        <td class="mono"><strong>${levelStr}</strong></td>
        <td class="mono">${priceStr}</td>
        <td class="mono">${sizeStr}</td>
        <td class="mono">${notionalStr}</td>
        <td><span class="status-tag ${statusClass}">${statusVal}</span></td>
        <td class="cloid-text" title="${cloidStr}">${shortId(cloidStr, 8)}</td>
        <td class="mono">${timeStr}</td>
        <td style="text-align: right; white-space: nowrap;">
          <button
            onclick="deleteGridOrder('${targetKey}')"
            style="padding: 2px 8px; font-size: 11px; background: rgba(225, 29, 72, 0.15); color: #fda4af; border: 1px solid rgba(225, 29, 72, 0.4); border-radius: 4px; cursor: pointer;"
            title="節目注文データを削除"
          >
            🗑️ 削除
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Render Realized PnL summary
 */
function renderHistory(data) {
  if (!data) return;

  const fills = data.fills || [];
  const summary = data.summary || {};

  // Render Realized PnL summary on Stat Card
  const totalPnl = Number(summary.totalRealizedPnl) || 0;
  const pnlSign = totalPnl >= 0 ? '+' : '';
  if (elTotalRealizedPnl) {
    elTotalRealizedPnl.textContent = `${pnlSign}${formatUsd(totalPnl)}`;
    elTotalRealizedPnl.style.color =
      totalPnl > 0 ? 'var(--accent-green)' :
      totalPnl < 0 ? 'var(--accent-red)' : 'var(--text-main)';
  }

  if (elFillsCount) {
    elFillsCount.textContent = summary.fillsCount || fills.length || 0;
  }
}

/**
 * Update connection status UI
 */
function updateConnectionStatus(isOnline) {
  if (isOnline) {
    elConnIndicator.className = 'conn-dot online';
    elConnText.textContent = 'REST API / Deno KV 接続良好';
    if (elBotStatusText) elBotStatusText.textContent = 'SYSTEM ACTIVE';
  } else {
    elConnIndicator.className = 'conn-dot offline';
    elConnText.textContent = 'API 切断 / 再試行中...';
    if (elBotStatusText) elBotStatusText.textContent = 'CONNECTING...';
  }
}

/**
 * Setup Event Listeners and Timer
 */
function setupEvents() {
  // Auto-refresh toggle
  if (elAutoRefreshToggle) {
    elAutoRefreshToggle.addEventListener('change', (e) => {
      autoRefreshEnabled = e.target.checked;
      remainingCountdown = refreshIntervalSeconds;
      if (elCountdown) elCountdown.textContent = `${remainingCountdown}s`;
    });
  }

  // Manual refresh button
  if (elRefreshBtn) {
    elRefreshBtn.addEventListener('click', () => {
      remainingCountdown = refreshIntervalSeconds;
      if (elCountdown) elCountdown.textContent = `${remainingCountdown}s`;
      fetchDashboardData();
    });
  }

  // タブ切り替え制御
  function setDashboardTab(tab) {
    currentActiveTab = tab;
    if (tab === 'orders') {
      if (elTabOrdersBtn) {
        elTabOrdersBtn.style.background = '#00e599';
        elTabOrdersBtn.style.color = '#0b0e14';
      }
      if (elTabErrorsBtn) {
        elTabErrorsBtn.style.background = 'transparent';
        elTabErrorsBtn.style.color = '#f43f5e';
      }
      if (elOrdersPanelContent) elOrdersPanelContent.style.display = 'block';
      if (elErrorsPanelContent) elErrorsPanelContent.style.display = 'none';
      if (elPanelLegendOrders) elPanelLegendOrders.style.display = 'flex';
      if (elPanelControlsErrors) elPanelControlsErrors.style.display = 'none';
    } else {
      if (elTabOrdersBtn) {
        elTabOrdersBtn.style.background = 'transparent';
        elTabOrdersBtn.style.color = '#00e599';
      }
      if (elTabErrorsBtn) {
        elTabErrorsBtn.style.background = '#f43f5e';
        elTabErrorsBtn.style.color = '#ffffff';
      }
      if (elOrdersPanelContent) elOrdersPanelContent.style.display = 'none';
      if (elErrorsPanelContent) elErrorsPanelContent.style.display = 'block';
      if (elPanelLegendOrders) elPanelLegendOrders.style.display = 'none';
      if (elPanelControlsErrors) elPanelControlsErrors.style.display = 'flex';
      fetchErrorsData();
    }
  }

  if (elTabOrdersBtn) elTabOrdersBtn.addEventListener('click', () => setDashboardTab('orders'));
  if (elTabErrorsBtn) elTabErrorsBtn.addEventListener('click', () => setDashboardTab('errors'));

  if (elRefreshErrorsBtn) elRefreshErrorsBtn.addEventListener('click', () => fetchErrorsData());
  if (elClearErrorsBtn) {
    elClearErrorsBtn.addEventListener('click', async () => {
      if (!confirm('エラーログを消去しますか？')) return;
      try {
        await fetch('api/errors', { method: 'DELETE' });
        await fetchErrorsData();
      } catch (e) {
        console.error('Failed to clear errors:', e);
      }
    });
  }

  // BOT ON/OFF スイッチのバインド
  const btnBotToggle = document.getElementById('btnBotToggle');
  const botToggleDot = document.getElementById('botToggleDot');
  const botToggleText = document.getElementById('botToggleText');

  let botEnabled = true;

  async function updateBotEnabledUI(enabled) {
    botEnabled = enabled;
    if (btnBotToggle && botToggleDot && botToggleText) {
      if (botEnabled) {
        btnBotToggle.style.background = '#064e3b';
        btnBotToggle.style.borderColor = '#065f46';
        btnBotToggle.style.color = '#34d399';
        botToggleDot.style.background = '#34d399';
        botToggleText.textContent = 'BOT';
      } else {
        btnBotToggle.style.background = '#1e293b';
        btnBotToggle.style.borderColor = '#334155';
        btnBotToggle.style.color = '#94a3b8';
        botToggleDot.style.background = '#64748b';
        botToggleText.textContent = 'BOT';
      }
    }
  }

  fetch('api/flags/enabled')
    .then((r) => r.json())
    .then((d) => updateBotEnabledUI(d.enabled ?? true))
    .catch(() => {});

  if (btnBotToggle) {
    btnBotToggle.addEventListener('click', async () => {
      const next = !botEnabled;
      try {
        const res = await fetch('api/flags/enabled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        });
        const d = await res.json();
        updateBotEnabledUI(d.enabled ?? next);
      } catch (err) {
        console.error('Failed to toggle bot enabled:', err);
      }
    });
  }

  // 1-second interval timer for countdown
  setInterval(() => {
    if (!autoRefreshEnabled) {
      if (elCountdown) elCountdown.textContent = 'Paused';
      return;
    }

    remainingCountdown--;
    if (remainingCountdown <= 0) {
      remainingCountdown = refreshIntervalSeconds;
      fetchDashboardData();
    }
    if (elCountdown) elCountdown.textContent = `${remainingCountdown}s`;
  }, 1000);
}

/**
 * Handle real-time price update from SSE
 */
function handleLivePriceUpdate(price, timestamp) {
  if (!price || isNaN(price) || price <= 0) return;
  elPrice.textContent = formatUsd(price, 0);

  // Update position metrics with new mark price
  if (latestPosition && latestPosition.size > 0 && latestPosition.entryPrice > 0) {
    const notional = price * latestPosition.size;
    const uPnl = (price - latestPosition.entryPrice) * latestPosition.size;
    const uPnlPct = ((price - latestPosition.entryPrice) / latestPosition.entryPrice) * 100;
    elNotionalUsd.textContent = formatUsd(notional, 0);

    const pnlSign = uPnl >= 0 ? '+' : '';
    const pnlClass = uPnl > 0 ? 'positive' : uPnl < 0 ? 'negative' : 'neutral';
    elUnrealizedPnl.innerHTML = `未実現損益: <span class="pnl-val ${pnlClass}">${pnlSign}${formatUsd(uPnl, 0)} (${pnlSign}${uPnlPct.toFixed(1)}%)</span>`;
  }

  // Update next target level if bot config is present
  if (latestBotConfig && latestBotConfig.gridStepUsd) {
    const step = latestBotConfig.gridStepUsd;
    const nextLevel = Math.floor(price / step) * step - step;
    elNextTargetLevel.textContent = formatUsd(nextLevel, 0);
  }
}

/**
 * Initialize SSE Connection
 */
function initSSE() {
  if (eventSource) {
    try {
      eventSource.close();
    } catch {
      // ignore
    }
  }

  if (elSsePill) {
    elSsePill.className = 'status-pill sse-pill';
    if (elSseText) elSseText.textContent = 'CONNECTING...';
  }

  eventSource = new EventSource('api/events');

  eventSource.addEventListener('connected', () => {
    if (elSsePill) elSsePill.className = 'status-pill sse-pill connected';
    if (elSseText) elSseText.textContent = 'LIVE';
  });

  eventSource.addEventListener('prices', (e) => {
    try {
      const payload = JSON.parse(e.data);
      const btcPrice = payload.prices?.['BTC'] ?? payload.prices?.['btc'];
      if (typeof btcPrice === 'number') {
        handleLivePriceUpdate(btcPrice, payload.timestamp);
      }
    } catch (err) {
      console.error('[SSE] Error handling prices event:', err);
    }
  });

  eventSource.addEventListener('orders', () => {
    // 注文イベント到着時は次回フェッチを待たずに最新データを更新
    fetchDashboardData();
  });

  eventSource.addEventListener('fills', () => {
    // 約定イベント到着時は直ちに最新データを更新
    fetchDashboardData();
  });

  eventSource.addEventListener('positions', () => {
    // ポジション更新イベント到着時は直ちに最新データを更新
    fetchDashboardData();
  });

  eventSource.onerror = () => {
    if (elSsePill) elSsePill.className = 'status-pill sse-pill disconnected';
    if (elSseText) elSseText.textContent = 'SSE DISCONNECTED';
  };
}

// グローバル操作関数: 節目注文削除
window.deleteGridOrder = async function(id) {
  if (!id) return;
  if (!confirm('この節目注文レコードを削除しますか？\n（※取引所の未約定注文はキャンセルされません）')) return;

  try {
    const res = await fetch(`api/orders?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      await fetchDashboardData();
    } else {
      alert('注文削除に失敗しました: ' + (data.error || '不明なエラー'));
    }
  } catch (err) {
    alert('通信エラー: ' + (err.message || err));
  }
};

// Initialization on load
document.addEventListener('DOMContentLoaded', () => {
  setupEvents();
  fetchDashboardData();
  initSSE();
});
