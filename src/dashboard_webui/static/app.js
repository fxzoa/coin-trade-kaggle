// 統合ダッシュボード クライアントロジック (SPA)

let currentView = "summary";
let currentBotKey = null;
let botDataCache = [];
let autoRefreshTimer = null;
let activeFilter = "all";
let searchQuery = "";

// DOM要素
const summaryView = document.getElementById("summary-view");
const botEmbedView = document.getElementById("bot-embed-view");
const botFrame = document.getElementById("bot-frame");
const embedLoader = document.getElementById("embed-loader");
const viewTitle = document.getElementById("view-title");
const viewDesc = document.getElementById("view-desc");
const btnOpenExternal = document.getElementById("btn-open-external");
const overallBadge = document.getElementById("overall-status-badge");
const botNavTrading = document.getElementById("bot-nav-trading");
const botNavInfra = document.getElementById("bot-nav-infra");
const navCountTrading = document.getElementById("nav-count-trading");
const navCountInfra = document.getElementById("nav-count-infra");
const botCardsContainer = document.getElementById("bot-cards-container");
const btnRefresh = document.getElementById("btn-refresh");
const systemTime = document.getElementById("system-time");
const botSearchInput = document.getElementById("bot-search");

// メトリック要素
const valTotalBots = document.getElementById("val-total-bots");
const valHealthyBots = document.getElementById("val-healthy-bots");
const valUnhealthyBots = document.getElementById("val-unhealthy-bots");
const valLastChecked = document.getElementById("val-last-checked");

function getBotProxyUrl(botKey) {
  return `${globalThis.location.origin}/proxy/${encodeURIComponent(botKey)}/`;
}

// 時計更新
function updateClock() {
  const now = new Date();
  systemTime.textContent = now.toLocaleTimeString("ja-JP");
}
setInterval(updateClock, 1000);
updateClock();

// ナビゲーション切り替え
function switchView(target, botKey = null) {
  currentView = target;
  currentBotKey = botKey;

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.remove("active");
  });

  if (target === "summary") {
    document.querySelector('.nav-item[data-view="summary"]')?.classList.add("active");
    summaryView.classList.remove("hidden");
    botEmbedView.classList.add("hidden");
    viewTitle.textContent = "Overall System Summary";
    viewDesc.textContent = "全取引ボットの健全性・稼働メトリクス一括監視";
    btnOpenExternal.classList.add("hidden");
    btnOpenExternal.classList.remove("inline-flex");
  } else if (target === "bot" && botKey) {
    const navBtn = document.querySelector(`.nav-item[data-bot="${botKey}"]`);
    if (navBtn) navBtn.classList.add("active");

    const bot = botDataCache.find((b) => b.key === botKey);
    if (bot) {
      viewTitle.textContent = bot.name;
      viewDesc.textContent = `${bot.description} (Port :${bot.directPort})`;
      btnOpenExternal.classList.remove("hidden");
      btnOpenExternal.classList.add("inline-flex");
      btnOpenExternal.onclick = () => {
        globalThis.open(getBotProxyUrl(bot.key), "_blank", "noopener");
      };

      summaryView.classList.add("hidden");
      botEmbedView.classList.remove("hidden");

      embedLoader.classList.remove("hidden");
      botFrame.onload = () => {
        embedLoader.classList.add("hidden");
      };

      const targetProxyUrl = getBotProxyUrl(bot.key);
      if (botFrame.src !== targetProxyUrl) {
        botFrame.src = targetProxyUrl;
      } else {
        embedLoader.classList.add("hidden");
      }
    }
  }
}

// フィルタ適用済みボットカード描画
function renderFilteredBotCards() {
  const query = searchQuery.trim().toLowerCase();
  const filtered = botDataCache.filter((b) => {
    if (activeFilter === "trading" && b.category !== "Trading") return false;
    if (activeFilter === "infra" && b.category === "Trading") return false;
    if (activeFilter === "alerts" && b.isHealthy) return false;
    if (query) {
      const hay = `${b.name} ${b.description} ${b.key}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    botCardsContainer.innerHTML = `
      <div class="col-span-full py-12 text-center border border-dashed border-border-base rounded bg-surface-1/50">
        <p class="text-xs font-mono text-slate-500">一致するボットがありません</p>
      </div>
    `;
    return;
  }

  botCardsContainer.innerHTML = filtered.map((b) => {
    const isTrading = b.category === "Trading";
    const categoryBadge = isTrading
      ? `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-telemetry/10 text-telemetry border border-telemetry/20">Trading</span>`
      : `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">Infra</span>`;

    const statusBadge = b.isHealthy
      ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-emerald-ok/10 text-emerald-ok border border-emerald-ok/25">
           <span class="w-1.5 h-1.5 rounded-full bg-emerald-ok shadow-[0_0_6px_#10b981]"></span>
           HEALTHY
         </span>`
      : `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-crimson-err/10 text-crimson-err border border-crimson-err/25">
           <span class="w-1.5 h-1.5 rounded-full bg-crimson-err animate-pulse"></span>
           OFFLINE
         </span>`;

    const codeColor = b.isHealthy ? "text-emerald-ok" : "text-crimson-err";

    return `
      <div class="bg-surface-1 border border-border-base hover:border-border-elevated rounded p-4 flex flex-col justify-between gap-4 transition-colors shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
        <div class="space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div class="space-y-1 min-w-0">
              <div class="text-sm font-semibold text-white truncate">${b.name}</div>
              ${categoryBadge}
            </div>
            ${statusBadge}
          </div>
          <p class="text-xs text-slate-400 leading-relaxed line-clamp-2">${b.description}</p>
        </div>

        <div class="space-y-3">
          <div class="grid grid-cols-3 gap-2 p-2.5 rounded bg-obsidian border border-border-base font-mono text-[11px] tabular-nums">
            <div>
              <div class="text-[10px] text-slate-500">PORT</div>
              <div class="text-slate-200 font-medium">:${b.directPort}</div>
            </div>
            <div>
              <div class="text-[10px] text-slate-500">LATENCY</div>
              <div class="text-slate-200 font-medium">${b.latencyMs}ms</div>
            </div>
            <div>
              <div class="text-[10px] text-slate-500">CODE</div>
              <div class="${codeColor} font-medium">${b.statusCode || "ERR"}</div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button
              class="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-telemetry hover:bg-sky-300 text-obsidian text-xs font-semibold transition-colors cursor-pointer"
              onclick="switchView('bot', '${b.key}')"
            >
              <span class="material-symbols-outlined text-[15px]">open_in_browser</span>
              <span>WebUIを開く</span>
            </button>
            <a
              class="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded bg-surface-2 hover:bg-slate-700/60 border border-border-base hover:border-border-elevated text-xs font-medium text-slate-200 transition-colors"
              href="${getBotProxyUrl(b.key)}"
              target="_blank"
              rel="noopener"
            >
              <span>直接開く</span>
              <span class="material-symbols-outlined text-[14px]">north_east</span>
            </a>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// ボットカード & ナビゲーション描画
function renderBots(bots) {
  botDataCache = bots;

  const tradingBots = bots.filter((b) => b.category === "Trading");
  const infraBots = bots.filter((b) => b.category !== "Trading");

  if (navCountTrading) navCountTrading.textContent = String(tradingBots.length);
  if (navCountInfra) navCountInfra.textContent = String(infraBots.length);

  const buildNavHtml = (list, iconName) =>
    list.map((b) => `
      <button
        class="nav-item w-full flex items-center justify-between px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer"
        data-view="bot"
        data-bot="${b.key}"
      >
        <span class="flex items-center gap-2.5 min-w-0">
          <span class="material-symbols-outlined text-[16px] shrink-0">${iconName}</span>
          <span class="truncate">${b.name}</span>
        </span>
        <span class="nav-status-dot ${b.isHealthy ? "healthy" : "unhealthy"}" id="dot-${b.key}"></span>
      </button>
    `).join("");

  if (botNavTrading && botNavTrading.children.length === 0) {
    botNavTrading.innerHTML = buildNavHtml(tradingBots, "candlestick_chart");
    if (botNavInfra) botNavInfra.innerHTML = buildNavHtml(infraBots, "memory");

    document.querySelectorAll("aside .nav-item[data-view='bot']").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchView("bot", btn.getAttribute("data-bot"));
      });
    });
  } else {
    bots.forEach((b) => {
      const dot = document.getElementById(`dot-${b.key}`);
      if (dot) {
        dot.className = `nav-status-dot ${b.isHealthy ? "healthy" : "unhealthy"}`;
      }
    });
  }

  renderFilteredBotCards();
}

// ステータス更新フェッチ
async function fetchStatus() {
  try {
    const res = await fetch("/api/bots/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    valTotalBots.textContent = data.summary.total;
    valHealthyBots.textContent = data.summary.healthy;
    valUnhealthyBots.textContent = data.summary.unhealthy;
    valLastChecked.textContent = new Date().toLocaleTimeString("ja-JP");

    if (overallBadge) {
      if (data.summary.allHealthy) {
        overallBadge.style.display = "none";
      } else {
        overallBadge.style.display = "inline-flex";
        overallBadge.querySelector(".status-text").textContent =
          `${data.summary.unhealthy} Bots Offline`;
      }
    }

    renderBots(data.bots);
  } catch (err) {
    console.error("Failed to fetch status:", err);
    if (overallBadge) {
      overallBadge.style.display = "inline-flex";
      overallBadge.querySelector(".status-text").textContent = "Gateway Disconnected";
    }
  }

  // Redis ステータス取得
  try {
    const healthRes = await fetch("/api/health");
    if (healthRes.ok) {
      const healthData = await healthRes.json();
      const redisBadge = document.getElementById("redis-status-badge");
      const redisIndicator = document.getElementById("redis-indicator");
      const redisText = document.getElementById("redis-status-text");

      if (redisBadge && redisIndicator && redisText) {
        if (healthData.redis === "connected") {
          redisIndicator.style.background = "#10b981";
          redisIndicator.style.boxShadow = "0 0 8px #10b981";
          const latencyStr = healthData.redisLatencyMs ? ` (${healthData.redisLatencyMs}ms)` : "";
          redisText.textContent = `Redis${latencyStr}`;
        } else {
          redisIndicator.style.background = "#f43f5e";
          redisIndicator.style.boxShadow = "0 0 8px #f43f5e";
          redisText.textContent = "Redis Offline";
        }
      }

      const insBadge = document.getElementById("dashboard-insufficient-badge");
      const insTime = document.getElementById("dashboard-insufficient-time");
      if (insBadge && insTime) {
        if (healthData.insufficientCooldown?.active) {
          insBadge.style.display = "inline-flex";
          const m = healthData.insufficientCooldown.remainingSec
            ? `(${Math.ceil(healthData.insufficientCooldown.remainingSec / 60)}m)`
            : "";
          insTime.textContent = m;
          insBadge.title = healthData.insufficientCooldown.reason || "残高不足により一時停止中";
        } else {
          insBadge.style.display = "none";
        }
      }
    }
  } catch {
    // ignore
  }
}

// 初期化
document.addEventListener("DOMContentLoaded", () => {
  document.querySelector('.nav-item[data-view="summary"]')?.addEventListener("click", () => {
    switchView("summary");
  });

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.getAttribute("data-filter") || "all";
      renderFilteredBotCards();
    });
  });

  if (botSearchInput) {
    botSearchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value || "";
      renderFilteredBotCards();
    });
  }

  btnRefresh.addEventListener("click", () => {
    const label = btnRefresh.querySelector("span:last-child");
    if (label) label.textContent = "...";
    fetchStatus().finally(() => {
      setTimeout(() => {
        if (label) label.textContent = "更新";
      }, 500);
    });
  });

  fetchStatus();
  autoRefreshTimer = setInterval(fetchStatus, 60000);
});
