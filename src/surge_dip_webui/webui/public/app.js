/**
 * HL Price & Breakout Monitor - Alpine.js アプリケーション
 * - 全銘柄の期間別レンジを取得し、SELL基準達成銘柄を SHORT 一覧、BUY基準達成銘柄を BUY 一覧に表示する
 * - 5秒ごとの自動更新 (ステータス・レンジ) とカウントダウン表示
 * - Redis Pub/Sub による期間別 MIN/MAX のリアルタイム更新
 */

// しきい値の初期値 (フォールバック専用)。
// 正の情報源は src/shared/domain/trade_signal.ts で、/api/ranges 応答の thresholds で上書きされる。
// 初回取得前や取得失敗時に判定が止まらないよう、同値の最小限の既定値のみ保持する。
const FALLBACK_THRESHOLDS = {
  dip: { "24h": 38.2, "7d": 50.0, "30d": 61.8, "90d": 70.0, "180d": 80.0, "360d": 90.0 },
  surge: { "24h": 61.8, "7d": 161.8, "30d": 261.8, "90d": 361.8, "180d": 461.8, "360d": 561.8 },
  additionalDip24h: 3.82,
  additionalSurge24h: 3.82,
};

/** 各期間の急騰（SHORT）・急落（LONG）シグナル判定閾値の標準定義 (dashboard-worker 互換) */
const PRICE_CHANGE_PERIOD_THRESHOLDS = {
  change24h: { label: "24H", surge: 61.8, dip: -38.2 },
  change7d: { label: "7D", surge: 161.8, dip: -50.0 },
  change30d: { label: "30D", surge: 261.8, dip: -61.8 },
  change90d: { label: "90D", surge: 361.8, dip: -70.0 },
  change180d: { label: "180D", surge: 461.8, dip: -80.0 },
  change360d: { label: "360D", surge: 561.8, dip: -90.0 },
};

/**
 * 数値を絶対値の整数部の桁数に応じて小数桁数を可変にしてフォーマットする
 */
function formatMagnitudeAware(val) {
  if (typeof val !== "number" || isNaN(val)) return "-";
  const decimals = Math.abs(val) < 10 ? 1 : 0;
  const formatted = val.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return formatted === "-0" ? "0" : formatted;
}

function formatSignedMagnitudeAware(val) {
  if (typeof val !== "number" || isNaN(val)) return "-";
  const formatted = formatMagnitudeAware(val);
  return val > 0 ? `+${formatted}` : formatted;
}

function formatVolumeUsdCompact(val) {
  if (val === null || val === undefined || val === "") return "-";
  const num = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(num) || num <= 0) return "-";
  if (num >= 1e9) return "$" + formatMagnitudeAware(num / 1e9) + "B";
  if (num >= 1e6) return "$" + formatMagnitudeAware(num / 1e6) + "M";
  if (num >= 1e3) return "$" + formatMagnitudeAware(num / 1e3) + "K";
  return "$" + formatMagnitudeAware(num);
}

/** /api/ranges 応答の thresholds が利用可能な形式か検証する */
function isValidThresholds(t) {
  return !!t && typeof t === "object" && !!t.dip && !!t.surge &&
    typeof t.additionalDip24h === "number" && typeof t.additionalSurge24h === "number";
}

/**
 * Non-blocking corner error popup (fixed top-right) with per-source tracking
 */
const CORNER_ERROR_ID = "cornerErrorPopup";
const activeCornerErrors = new Map();

function showCornerError(title, message) {
  if (typeof document === "undefined" || !document.body) return;
  let el = document.getElementById(CORNER_ERROR_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = CORNER_ERROR_ID;
    el.setAttribute("role", "alert");
    el.style.cssText = [
      "position: fixed",
      "top: 16px",
      "right: 16px",
      "z-index: 99999",
      "max-width: 380px",
      "min-width: 260px",
      "background: #131926",
      "border: 1px solid #F43F5E",
      "border-left: 4px solid #F43F5E",
      "border-radius: 8px",
      "padding: 12px 14px",
      "color: #F8FAFC",
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      "font-size: 13px",
      "line-height: 1.45",
      "box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5)",
    ].join(";");
    document.body.appendChild(el);
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  el.innerHTML = "";
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;";

  const titleEl = document.createElement("strong");
  titleEl.style.cssText = "color:#FB7185;font-size:13px;font-weight:700;";
  titleEl.textContent = title || "データ取得異常";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "閉じる");
  closeBtn.style.cssText = "background:transparent;border:none;color:#94A3B8;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;";
  closeBtn.addEventListener("click", clearCornerError);

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const msgEl = document.createElement("div");
  msgEl.style.cssText = "color:#E2E8F0;word-break:break-word;margin-bottom:6px;";
  msgEl.textContent = message || "異常なレスポンスを検出しました";

  const timeEl = document.createElement("div");
  timeEl.style.cssText = "color:#94A3B8;font-size:11px;font-family:monospace;";
  timeEl.textContent = `検出時刻: ${ts}`;

  el.appendChild(header);
  el.appendChild(msgEl);
  el.appendChild(timeEl);
  el.style.display = "block";
}

function clearCornerError() {
  activeCornerErrors.clear();
  const el = document.getElementById(CORNER_ERROR_ID);
  if (el) el.style.display = "none";
}

function reportCornerError(sourceKey, title, message) {
  activeCornerErrors.set(sourceKey, { title, message });
  const messages = Array.from(activeCornerErrors.values()).map((e) => e.message);
  showCornerError(title, messages.join(" / "));
}

function resolveCornerError(sourceKey) {
  if (!activeCornerErrors.has(sourceKey)) return;
  activeCornerErrors.delete(sourceKey);
  if (activeCornerErrors.size === 0) {
    const el = document.getElementById(CORNER_ERROR_ID);
    if (el) el.style.display = "none";
  } else {
    const last = Array.from(activeCornerErrors.values()).pop();
    const messages = Array.from(activeCornerErrors.values()).map((e) => e.message);
    showCornerError(last.title, messages.join(" / "));
  }
}

document.addEventListener("alpine:init", () => {
  Alpine.data("priceMonitor", () => {
    // 導出データのメモ化キャッシュ (入力の参照が変わらない限り再計算しない。非リアクティブに保持する)
    let rowsCache = { ranges: null, thresholds: null, value: [] };
    let tablesCache = { rows: null, value: [] };

    return {
      status: {
        db: {
          rangeCount: 0,
          uniqueSymbols: 0,
          fileSizeFormatted: "--",
          latestUpdateJst: "--",
        },
        network: {
          network: "Mainnet",
          ws: "Active",
          circuitBreakers: "Normal",
        },
        serverTimeJst: "--",
      },
      ranges: [],
      totalSymbols: 0,
      refTimeJst: "--",
      tradeMode: "BOTH",
      isUpdatingMode: false,
      botEnabled: true,
      isTogglingBot: false,
      signals: [],
      signalsCount: 0,
      isSignalsLoading: false,

      // 判定に使うしきい値 (取得成功時にサーバー応答で置き換える)
      thresholds: FALLBACK_THRESHOLDS,

      // タブ管理 ('signals' | 'price-change' | 'volume-ranking')
      currentTab: "signals",

      // 騰落率一覧ステート (dashboard-worker 互換)
      priceChangeItems: [],
      isPriceChangeLoading: false,
      priceChangeError: "",
      priceChangeSearchQuery: "",
      priceChangeSortKey: "change180d",
      priceChangeSortAsc: false,
      priceChangeTimestamp: "",
      priceChangeFilterThresholdOnly: false,

      // 出来高倍率ランキングステート (dashboard-worker 互換)
      volumeRankingItems: [],
      isVolumeRankingLoading: false,
      volumeRankingError: "",
      volumeRankingSearchQuery: "",
      volumeRankingSortKey: "volumeRatio",
      volumeRankingSortAsc: false,
      volumeRankingTimestamp: "",

      // エラーログステート
      errorLogs: [],
      isErrorsLoading: false,

      sseConnected: false,
      eventSource: null,

      autoRefresh: true,
      countdown: 5,
      countdownTimerId: null,
      isLoading: true,
      // レンジ取得の失敗状態 (失敗時に「該当なし」と誤表示しないための判別用)
      loadFailed: false,
      isRefreshing: false,
      errorMessage: "",

      init() {
        this.fetchStatus();
        this.fetchRanges();
        this.fetchPriceChange();
        this.fetchVolumeRanking();
        this.fetchTradeMode();
        this.fetchBotEnabled();
        this.fetchSignals();
        this.fetchErrors();
        this.startTimers();
        this.initSSE();
      },

      async fetchBotEnabled() {
        try {
          const res = await fetch("api/flags/enabled");
          if (res.ok) {
            const data = await res.json();
            if (data.success !== undefined) {
              this.botEnabled = Boolean(data.enabled);
            }
          }
        } catch (err) {
          console.error("BOT稼働状態取得エラー:", err);
        }
      },

      async toggleBot() {
        if (this.isTogglingBot) return;
        this.isTogglingBot = true;
        try {
          const target = !this.botEnabled;
          const res = await fetch("api/flags/enabled", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: target }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.success !== undefined) {
              this.botEnabled = Boolean(data.enabled);
            }
          }
        } catch (err) {
          console.error("BOT稼働状態切り替えエラー:", err);
        } finally {
          this.isTogglingBot = false;
        }
      },

      async fetchTradeMode() {
        try {
          const res = await fetch("api/flags/mode");
          if (res.ok) {
            const data = await res.json();
            if (data.success) {
              this.tradeMode = data.mode;
            }
          }
        } catch (err) {
          console.error("トレードモード取得失敗:", err);
        }
      },

      async setTradeMode(mode) {
        if (this.isUpdatingMode) return;
        this.isUpdatingMode = true;
        try {
          const res = await fetch("api/flags/mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.success) {
              this.tradeMode = data.mode;
            }
          }
        } catch (err) {
          console.error("トレードモード更新失敗:", err);
        } finally {
          this.isUpdatingMode = false;
        }
      },

      async fetchSignals() {
        this.isSignalsLoading = true;
        try {
          const res = await fetch("api/signals?limit=50");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data || typeof data !== "object" || !data.success || !Array.isArray(data.data)) {
            throw new Error("シグナル応答形式が不正です");
          }
          this.signals = data.data;
          this.signalsCount = data.count || 0;
          resolveCornerError("signals");
        } catch (err) {
          console.error("シグナル一覧取得失敗:", err);
          reportCornerError("signals", "シグナル取得異常", `api/signals: ${err.message || "通信/パースエラー"}`);
        } finally {
          this.isSignalsLoading = false;
        }
      },

      initSSE() {
        if (this.eventSource) {
          try {
            this.eventSource.close();
          } catch {
            // ignore
          }
        }

        try {
          this.eventSource = new EventSource("api/events");

          this.eventSource.addEventListener("connected", () => {
            this.sseConnected = true;
          });

          this.eventSource.addEventListener("prices", (e) => {
            try {
              const payload = JSON.parse(e.data);
              if (payload.prices && typeof payload.prices === "object") {
                this.handleLivePrices(payload.prices);
              }
            } catch (err) {
              console.error("[SSE] Error handling prices:", err);
            }
          });

          this.eventSource.addEventListener("ranges", () => {
            this.fetchRanges();
            this.fetchStatus();
          });

          this.eventSource.onerror = () => {
            this.sseConnected = false;
          };
        } catch (err) {
          console.error("[SSE] Failed to initialize EventSource:", err);
          this.sseConnected = false;
        }
      },

      handleLivePrices(prices) {
        if (!this.ranges || this.ranges.length === 0) return;
        let hasChanges = false;

        for (const item of this.ranges) {
          const sym = item.symbol;
          const newPrice = prices[sym];
          if (typeof newPrice === "number" && newPrice > 0 && item.latestClose !== newPrice) {
            item.latestClose = newPrice;
            hasChanges = true;
          }
        }

        if (hasChanges) {
          // メモ化キャッシュのキー参照を更新して再計算を促す
          this.ranges = [...this.ranges];
        }
      },

      startTimers() {
        this.clearTimers();
        this.countdown = 60;
        this.countdownTimerId = setInterval(() => {
          if (!this.autoRefresh) return;
          if (this.countdown > 1) {
            this.countdown--;
          } else {
            this.countdown = 60;
            this.refreshAll(true);
          }
        }, 1000);
      },

      clearTimers() {
        if (this.countdownTimerId) clearInterval(this.countdownTimerId);
      },

      toggleAutoRefresh() {
        if (this.autoRefresh) {
          this.startTimers();
        } else {
          this.clearTimers();
        }
      },

      async refreshAll(silent = false) {
        if (!silent) this.isRefreshing = true;
        try {
          await Promise.all([
            this.fetchStatus(),
            this.fetchRanges(),
            this.fetchTradeMode(),
            this.fetchSignals(),
          ]);
          this.countdown = 60;
        } finally {
          if (!silent) {
            setTimeout(() => {
              this.isRefreshing = false;
            }, 400);
          }
        }
      },

      async fetchStatus() {
        try {
          const res = await fetch("api/status");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data || typeof data !== "object" || !data.success || !data.db || typeof data.db !== "object") {
            throw new Error("ステータスデータが不正または欠損しています");
          }
          this.status = data;
          this.errorMessage = "";
          resolveCornerError("status");
        } catch (err) {
          console.error("ステータス取得に失敗しました:", err);
          this.errorMessage = "バックエンド通信エラー: DBステータスを取得できませんでした";
          reportCornerError("status", "ステータス取得異常", `api/status: ${err.message || "通信/パースエラー"}`);
        }
      },

      async fetchRanges() {
        try {
          const url = new URL(
            "api/ranges",
            globalThis.location?.href || "http://localhost:8004/",
          );
          // 基準達成銘柄を取りこぼさないよう全件取得する (サーバー既定は50件、0=全件)
          url.searchParams.set("limit", "0");
          const res = await fetch(url.toString());
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data || typeof data !== "object" || !data.success || !Array.isArray(data.data)) {
            throw new Error("レンジ応答形式が不正です");
          }
          this.ranges = data.data;
          this.totalSymbols = data.total || 0;
          this.refTimeJst = data.refTimeJst || "--";
          if (isValidThresholds(data.thresholds)) this.thresholds = data.thresholds;
          this.errorMessage = "";
          this.loadFailed = false;

          if (data.data.length === 0) {
            reportCornerError("ranges", "レンジデータ異常", "api/ranges: 銘柄レンジデータが空(0件)です");
          } else {
            const invalidItem = data.data.find(
              (it) => !it || !it.symbol || (it.latestClose !== null && it.latestClose !== undefined && Number.isNaN(Number(it.latestClose))),
            );
            if (invalidItem) {
              reportCornerError("ranges", "レンジデータ異常", "api/ranges: 必須フィールド欠損またはNaN価格を検出");
            } else {
              resolveCornerError("ranges");
            }
          }
        } catch (err) {
          console.error("レンジ取得に失敗しました:", err);
          reportCornerError("ranges", "レンジ取得異常", `api/ranges: ${err.message || "通信/パースエラー"}`);
          // 既にデータが表示されている場合はエラーバナーで消去せず前回のデータを保持する
          if (!this.ranges || this.ranges.length === 0) {
            this.errorMessage = "期間別レンジの取得に失敗しました";
            this.loadFailed = true;
          }
        } finally {
          this.isLoading = false;
        }
      },

      async fetchErrors() {
        this.isErrorsLoading = true;
        try {
          const res = await fetch("api/errors?limit=100");
          if (!res.ok) return;
          const json = await res.json();
          this.errorLogs = json.errors || [];
        } catch (e) {
          console.error("Failed to fetch error logs:", e);
        } finally {
          this.isErrorsLoading = false;
        }
      },

      async clearErrors() {
        if (!confirm("エラーログを消去しますか？")) return;
        try {
          await fetch("api/errors", { method: "DELETE" });
          await this.fetchErrors();
        } catch (e) {
          console.error("Failed to clear error logs:", e);
        }
      },

      // 期間メタデータ定義 (short: 一覧ヘッダー表示用 / dipThreshold: BUY基準の下落率閾値)
      getPeriodDefinitions() {
        const defs = [
          {
            key: "24h",
            short: "24H",
            label: "24H Range",
            title: "24時間レンジ",
            days: "1日 (短期)",
            color: "cyan",
          },
          {
            key: "7d",
            short: "7D",
            label: "7D Range",
            title: "7日間レンジ",
            days: "7日 (週間)",
            color: "emerald",
          },
          {
            key: "30d",
            short: "30D",
            label: "30D Range",
            title: "30日間レンジ",
            days: "30日 (月間)",
            color: "purple",
          },
          {
            key: "90d",
            short: "90D",
            label: "90D Range",
            title: "90日間レンジ",
            days: "90日 (四半期)",
            color: "amber",
          },
          {
            key: "180d",
            short: "180D",
            label: "180D Range",
            title: "180日間レンジ",
            days: "180日 (半期)",
            color: "rose",
          },
          {
            key: "360d",
            short: "360D",
            label: "360D Range",
            title: "360日間レンジ",
            days: "360日 (年間)",
            color: "indigo",
          },
        ];
        return defs.map((d) => ({
          ...d,
          dipThreshold: this.thresholds.dip[d.key],
          surgeThreshold: this.thresholds.surge[d.key],
        }));
      },

      /**
       * SHORT 一覧 (SELL基準達成) と BUY 一覧 (BUY基準達成) の表定義。
       * 同一の行データ (rangeRows) を達成種別で振り分け、テンプレートは1つを共用する。
       */
      get signalTables() {
        const rows = this.rangeRows;
        if (tablesCache.rows === rows) return tablesCache.value;
        const value = [
          {
            id: "short",
            title: "SHORT 一覧 (SELL基準達成)",
            note: "高値更新後の急騰 (上昇率: 24H は閾値以上 / 他期間は閾値超過) を検出",
            rows: rows.filter((r) => r.hasSell),
            cellText: (c) => (c.isSell ? c.surgeText : c.dipText),
            cellClass: (c) => (c.isSell ? "bg-rose-600 text-white" : "text-slate-400"),
            threshold: (p) => `(+${p.surgeThreshold}%)`,
            thresholdClass: "text-rose-400",
            dotClass: "bg-rose-400",
            badgeClass: "bg-rose-950/80 text-rose-300 border border-rose-800",
            rowClass: "bg-rose-950/20 hover:bg-rose-950/30",
          },
          {
            id: "buy",
            title: "BUY 一覧 (BUY基準達成)",
            note: "高値からの下落 (下落率 ≥ 閾値) を検出",
            rows: rows.filter((r) => r.hasBuy),
            cellText: (c) => c.dipText,
            cellClass: (c) => (c.isBuy ? "bg-emerald-600 text-white" : "text-slate-400"),
            threshold: (p) => `(-${p.dipThreshold}%)`,
            thresholdClass: "text-emerald-500",
            dotClass: "bg-emerald-400",
            badgeClass: "bg-emerald-950/80 text-emerald-300 border border-emerald-800",
            rowClass: "bg-emerald-950/20 hover:bg-emerald-950/30",
          },
        ];
        tablesCache = { rows, value };
        return value;
      },

      /**
       * 期間別レンジ一覧の表示用行データ (x-for で宣言的に描画する)
       * 各セルは主表示=高値からの下落率(BUY達成時)/安値からの上昇率(SELL達成時)、副表示=安値~高値
       * レンジ・しきい値の参照が変わらない限りメモ化結果を返し、5秒ごとの再描画で重複計算しない。
       */
      get rangeRows() {
        const ranges = this.ranges;
        const thresholds = this.thresholds;
        if (rowsCache.ranges === ranges && rowsCache.thresholds === thresholds) {
          return rowsCache.value;
        }
        const periods = this.getPeriodDefinitions();
        const value = (ranges || []).map((item) => {
          let buyCount = 0;
          let sellCount = 0;
          const cells = periods.map((p) => {
            const res = this.checkTradeCriteria(p.key, item);
            if (res.isBuy) buyCount++;
            if (res.isSell) sellCount++;
            return this.buildRangeCell(p, res, item.ranges?.[p.key]);
          });
          return {
            symbol: item.symbol,
            latestClose: item.latestClose,
            cells,
            buyCount,
            sellCount,
            hasBuy: buyCount > 0,
            hasSell: sellCount > 0,
          };
        });
        rowsCache = { ranges, thresholds, value };
        return value;
      },

      /** 一覧の1セル分 (期間p・判定結果res・レンジrange) の表示データを組み立てる */
      buildRangeCell(p, res, range) {
        const spread = this.formatSpread(range);
        const hasRange = range && range.low !== null && range.high !== null;
        // 下落率は「高値からの変化」として符号を反転して表示する (高値超えなら +、下落なら -)
        const dipText = this.formatSignedPct(res.dipPct === null ? null : -Number(res.dipPct));
        const surgeText = this.formatSignedPct(res.surgePct === null ? null : Number(res.surgePct));
        return {
          key: p.key,
          isBuy: res.isBuy,
          isSell: res.isSell,
          dipText,
          surgeText,
          sub: hasRange
            ? `${this.formatMarkPrice(range.low)} ~ ${this.formatMarkPrice(range.high)}`
            : "--",
          tooltip:
            `${p.title}: 安値 ${this.formatPrice(range?.low)} ~ 高値 ${
              this.formatPrice(range?.high)
            }` + (spread ? ` / 振幅 ${spread}` : "") +
            ` / 高値比 ${dipText}` +
            ` (BUY基準 下落率 ≥ ${res.targetDip ?? p.dipThreshold}%)` +
            ` / 安値比 ${surgeText}` +
            ` (SELL基準 上昇率 ${res.surgeOp ?? ">"} ${
              res.targetSurge ?? this.thresholds.surge[p.key]
            }%)`,
        };
      },

      /** 符号付きの百分率文字列 (小数1桁)。null は "--"。丸めて 0.0 になる値は符号なし */
      formatSignedPct(value) {
        if (value === null || value === undefined || Number.isNaN(value)) return "--";
        const rounded = Number(value.toFixed(1));
        const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
        return `${sign}${Math.abs(rounded).toFixed(1)}%`;
      },

      /**
       * 指定期間が売買シグナル基準を満たすか判定する (item 必須)。
       * サーバー側 signal_rules.ts と同じ規則:
       * - BUY: 24H は下落率 >= 閾値。他期間は 24H 下落率 >= additionalDip24h かつ 期間下落率 >= 閾値。
       * - SELL: 24H は上昇率 >= 閾値。他期間は 24H 上昇率 >= additionalSurge24h かつ 期間上昇率 > 閾値。
       */
      checkTradeCriteria(periodKey, item) {
        const targetItem = item;
        if (!targetItem || !targetItem.ranges) {
          return {
            status: "NONE",
            badgeText: "データなし",
            dipPct: null,
            surgePct: null,
            isBuy: false,
            isSell: false,
          };
        }

        const price = targetItem.latestClose;
        const periodRange = targetItem.ranges[periodKey];
        const range24h = targetItem.ranges["24h"];

        if (!price || !periodRange || periodRange.high === null || periodRange.low === null) {
          return {
            status: "NONE",
            badgeText: "未計測",
            dipPct: null,
            surgePct: null,
            isBuy: false,
            isSell: false,
          };
        }

        const high = periodRange.high;
        const low = periodRange.low;

        // 高値からの下落率 (%)
        const dipPct = high > 0 ? ((high - price) / high) * 100 : null;
        // 安値からの上昇率 (%)
        const surgePct = low > 0 ? ((price - low) / low) * 100 : null;

        // 24H の下落率・上昇率
        const dip24h = (range24h && range24h.high > 0)
          ? ((range24h.high - price) / range24h.high) * 100
          : null;
        const surge24h = (range24h && range24h.low > 0)
          ? ((price - range24h.low) / range24h.low) * 100
          : null;

        const dipLimit = this.thresholds.dip[periodKey] || 0;
        const surgeLimit = this.thresholds.surge[periodKey] || 0;

        // BUY / SELL は独立した基準 (サーバー側 signal_rules.ts と同じ) のため、両方を個別に判定する
        let isBuy = false;
        if (dipPct !== null) {
          isBuy = periodKey === "24h"
            ? dipPct >= dipLimit
            : (dip24h !== null && dip24h >= this.thresholds.additionalDip24h) && dipPct >= dipLimit;
        }

        // SELL は 24H のみ「以上」、他期間は「超過」
        let isSell = false;
        if (surgePct !== null) {
          isSell = periodKey === "24h"
            ? surgePct >= surgeLimit
            : (surge24h !== null && surge24h >= this.thresholds.additionalSurge24h) &&
              surgePct > surgeLimit;
        }

        const surgeOp = periodKey === "24h" ? "≥" : ">";
        const dipText = dipPct !== null ? dipPct.toFixed(1) : null;
        const surgeText = surgePct !== null ? surgePct.toFixed(1) : null;
        const badges = [];
        if (isBuy) badges.push(`BUY基準達成 (下落率 -${dipText}% ≥ 閾値 ${dipLimit}%)`);
        if (isSell) {
          badges.push(`SELL基準達成 (上昇率 +${surgeText}% ${surgeOp} 閾値 ${surgeLimit}%)`);
        }

        return {
          status: isBuy && isSell ? "BOTH" : isBuy ? "BUY" : isSell ? "SELL" : "NONE",
          isBuy,
          isSell,
          dipPct: dipText,
          surgePct: surgeText,
          targetDip: dipLimit,
          targetSurge: surgeLimit,
          surgeOp,
          badgeText: badges.length > 0
            ? badges.join(" / ")
            : `基準未達 (BUY目標: ${dipLimit}% / SELL目標: ${surgeLimit}%)`,
        };
      },

      // フォーマッタ
      formatPrice(val) {
        if (val === null || val === undefined || isNaN(val)) return "--";
        const num = Number(val);
        if (num >= 1000) {
          return "$" +
            num.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
        } else if (num >= 1) {
          return "$" +
            num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        } else if (num >= 0.001) {
          return "$" +
            num.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
        } else {
          return "$" + num.toFixed(6);
        }
      },

      /**
       * 価格を有効数字5桁・小数点以下最大4桁に整形する (SIG タブ準拠)
       */
      formatMarkPrice(price) {
        if (price === null || price === undefined || price === "") return "-";
        const num = Number(price);
        if (isNaN(num) || num <= 0) return "-";
        if (num >= 10000) return String(Math.round(num));
        const sigStr = String(Number(num.toPrecision(5)));
        const decimals = sigStr.split(".")[1];
        return decimals && decimals.length > 4 ? num.toFixed(4) : sigStr;
      },

      /** 現在値の表示 ($ プレフィックス付き) */
      formatMarkPriceDisplay(price) {
        const formatted = this.formatMarkPrice(price);
        return formatted === "-" ? "-" : `$${formatted}`;
      },

      formatSpread(period) {
        if (!period || period.high === null || period.low === null || period.low <= 0) return null;
        const spreadPct = ((period.high - period.low) / period.low) * 100;
        return spreadPct.toFixed(1) + "%";
      },

      formatNumber(val) {
        if (val === null || val === undefined || isNaN(val)) return "0";
        return Number(val).toLocaleString("en-US");
      },

      // ====================================================================
      // 騰落率一覧 (Price Change) メソッド群
      // ====================================================================
      async fetchPriceChange() {
        this.isPriceChangeLoading = true;
        this.priceChangeError = "";
        try {
          const res = await fetch("api/price-change");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data || typeof data !== "object" || !data.success || !Array.isArray(data.items)) {
            const msg = (data && data.error) || "騰落率データの応答形式が不正です";
            this.priceChangeError = msg;
            reportCornerError("price-change", "騰落率データ異常", `api/price-change: ${msg}`);
          } else {
            this.priceChangeItems = data.items;
            this.priceChangeTimestamp = data.timestamp
              ? new Date(data.timestamp).toLocaleTimeString("ja-JP")
              : "";
            resolveCornerError("price-change");
          }
        } catch (err) {
          console.error("騰落率データ取得エラー:", err);
          this.priceChangeError = err.message || "通信エラーが発生しました";
          reportCornerError("price-change", "騰落率取得異常", `api/price-change: ${this.priceChangeError}`);
        } finally {
          this.isPriceChangeLoading = false;
        }
      },

      setPriceChangeSort(key) {
        if (this.priceChangeSortKey === key) {
          this.priceChangeSortAsc = !this.priceChangeSortAsc;
        } else {
          this.priceChangeSortKey = key;
          this.priceChangeSortAsc = false;
        }
      },

      getPeriodThreshold(key) {
        return PRICE_CHANGE_PERIOD_THRESHOLDS[key] || null;
      },

      getCurrentThreshold() {
        return this.getPeriodThreshold(this.priceChangeSortKey);
      },

      getRowHighlightType(item) {
        const threshold = this.getCurrentThreshold();
        if (!threshold) return null;
        const val = item[this.priceChangeSortKey];
        if (typeof val !== "number" || isNaN(val)) return null;
        if (val >= threshold.surge) return "surge";
        if (val <= threshold.dip) return "dip";
        return null;
      },

      getRowHighlightClass(item) {
        const type = this.getRowHighlightType(item);
        if (type === "surge") {
          return "bg-emerald-950/35 border-l-4 border-l-emerald-500 hover:bg-emerald-950/50 shadow-inner transition-colors";
        }
        if (type === "dip") {
          return "bg-rose-950/35 border-l-4 border-l-rose-500 hover:bg-rose-950/50 shadow-inner transition-colors";
        }
        return "border-l-4 border-l-transparent hover:bg-slate-800/40 transition-colors";
      },

      isCellThresholdExceeded(key, val) {
        const threshold = PRICE_CHANGE_PERIOD_THRESHOLDS[key];
        if (!threshold || typeof val !== "number" || isNaN(val)) return null;
        if (val >= threshold.surge) return "surge";
        if (val <= threshold.dip) return "dip";
        return null;
      },

      getFilteredPriceChangeItems() {
        try {
          let list = [...(this.priceChangeItems || [])];

          if (this.priceChangeSearchQuery && this.priceChangeSearchQuery.trim()) {
            const q = this.priceChangeSearchQuery.trim().toUpperCase();
            list = list.filter((item) => item.coin && item.coin.toUpperCase().includes(q));
          }

          if (this.priceChangeFilterThresholdOnly && this.getCurrentThreshold()) {
            list = list.filter((item) => this.getRowHighlightType(item) !== null);
          }

          const key = this.priceChangeSortKey;
          const asc = this.priceChangeSortAsc;

          list.sort((a, b) => {
            const valA = a[key];
            const valB = b[key];

            if (typeof valA === "string" || typeof valB === "string") {
              const strA = (valA || "").toUpperCase();
              const strB = (valB || "").toUpperCase();
              return asc ? strA.localeCompare(strB) : strB.localeCompare(strA);
            }

            const isNullA = valA === null || valA === undefined || isNaN(valA);
            const isNullB = valB === null || valB === undefined || isNaN(valB);

            if (isNullA && isNullB) return 0;
            if (isNullA) return 1;
            if (isNullB) return -1;

            const numA = Number(valA);
            const numB = Number(valB);
            return asc ? numA - numB : numB - numA;
          });

          return list;
        } catch (err) {
          console.error("getFilteredPriceChangeItems エラー:", err);
          return this.priceChangeItems || [];
        }
      },

      formatPriceChange(val) {
        if (val === null || val === undefined || isNaN(val)) return "N/A";
        return `${formatSignedMagnitudeAware(val)}%`;
      },

      getPriceChangeTextClass(val) {
        if (val === null || val === undefined || isNaN(val)) return "text-slate-500";
        if (val > 0) return "text-emerald-400";
        if (val < 0) return "text-rose-400";
        return "text-slate-400";
      },

      getPriceChangeBadgeClass(val) {
        if (val === null || val === undefined || isNaN(val)) {
          return "bg-slate-800 text-slate-500 border border-slate-700/50";
        }
        if (val >= 20.0) {
          return "bg-emerald-950 text-emerald-300 border border-emerald-600 font-bold shadow-sm shadow-emerald-900/30";
        }
        if (val > 0) {
          return "bg-emerald-950/60 text-emerald-400 border border-emerald-800/60";
        }
        if (val <= -20.0) {
          return "bg-rose-950 text-rose-300 border border-rose-600 font-bold shadow-sm shadow-rose-900/30";
        }
        if (val < 0) {
          return "bg-rose-950/60 text-rose-400 border border-rose-800/60";
        }
        return "bg-slate-800 text-slate-400 border border-slate-700/60";
      },

      formatPriceChangeMarkPrice(price) {
        if (price === null || price === undefined || price === "") return "-";
        const num = typeof price === "string" ? parseFloat(price) : price;
        if (isNaN(num) || num <= 0) return "-";
        if (num >= 10000) return "$" + Math.round(num).toLocaleString("ja-JP");
        if (num >= 1) {
          return "$" +
            num.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        }
        return "$" + Number(num.toPrecision(5)).toString();
      },

      formatPriceChangeVolume(val) {
        return formatVolumeUsdCompact(val);
      },

      // ====================================================================
      // 出来高倍率ランキング (Volume Ranking) メソッド群
      // ====================================================================
      async fetchVolumeRanking() {
        this.isVolumeRankingLoading = true;
        this.volumeRankingError = "";
        try {
          const res = await fetch("api/volume-ranking?limit=200");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data || typeof data !== "object" || !data.success || !Array.isArray(data.items)) {
            const msg = (data && data.error) || "出来高データの応答形式が不正です";
            this.volumeRankingError = msg;
            reportCornerError("volume-ranking", "出来高データ異常", `api/volume-ranking: ${msg}`);
          } else {
            this.volumeRankingItems = data.items;
            this.volumeRankingTimestamp = data.timestamp
              ? new Date(data.timestamp).toLocaleTimeString("ja-JP")
              : "";
            resolveCornerError("volume-ranking");
          }
        } catch (err) {
          console.error("出来高データ取得エラー:", err);
          this.volumeRankingError = err.message || "通信エラーが発生しました";
          reportCornerError("volume-ranking", "出来高取得異常", `api/volume-ranking: ${this.volumeRankingError}`);
        } finally {
          this.isVolumeRankingLoading = false;
        }
      },

      setVolumeRankingSort(key) {
        if (this.volumeRankingSortKey === key) {
          this.volumeRankingSortAsc = !this.volumeRankingSortAsc;
        } else {
          this.volumeRankingSortKey = key;
          this.volumeRankingSortAsc = false;
        }
      },

      getFilteredVolumeRankingItems() {
        try {
          let list = [...(this.volumeRankingItems || [])];

          if (this.volumeRankingSearchQuery && this.volumeRankingSearchQuery.trim()) {
            const q = this.volumeRankingSearchQuery.trim().toUpperCase();
            list = list.filter((item) => item.coin && item.coin.toUpperCase().includes(q));
          }

          const key = this.volumeRankingSortKey;
          const asc = this.volumeRankingSortAsc;

          list.sort((a, b) => {
            const valA = a[key];
            const valB = b[key];

            if (typeof valA === "string" || typeof valB === "string") {
              const strA = (valA || "").toUpperCase();
              const strB = (valB || "").toUpperCase();
              return asc ? strA.localeCompare(strB) : strB.localeCompare(strA);
            }

            const isNullA = valA === null || valA === undefined || isNaN(valA);
            const isNullB = valB === null || valB === undefined || isNaN(valB);

            if (isNullA && isNullB) return 0;
            if (isNullA) return 1;
            if (isNullB) return -1;

            const numA = Number(valA);
            const numB = Number(valB);
            return asc ? numA - numB : numB - numA;
          });

          return list;
        } catch (err) {
          console.error("getFilteredVolumeRankingItems エラー:", err);
          return this.volumeRankingItems || [];
        }
      },

      formatVolumeRatio(ratio) {
        if (ratio === null || ratio === undefined || isNaN(ratio)) return "-";
        return `${Number(ratio).toFixed(2)}x`;
      },

      getVolumeRatioBadgeClass(ratio) {
        if (ratio === null || ratio === undefined || isNaN(ratio)) {
          return "bg-slate-800 text-slate-500 border border-slate-700/50";
        }
        if (ratio >= 3.0) {
          return "bg-indigo-950 text-indigo-200 border border-indigo-400 font-extrabold shadow-sm shadow-indigo-900/50 ring-1 ring-indigo-400/50";
        }
        if (ratio >= 2.0) {
          return "bg-indigo-950 text-indigo-300 border border-indigo-500 font-bold shadow-sm shadow-indigo-900/30";
        }
        if (ratio >= 1.5) {
          return "bg-indigo-950/60 text-indigo-400 border border-indigo-800/60 font-semibold";
        }
        return "bg-slate-800 text-slate-400 border border-slate-700/60";
      },

      getVolumeRatioStatusBadge(ratio) {
        if (ratio >= 3.0) {
          return {
            label: "超急増",
            class: "bg-indigo-500/20 text-indigo-300 border border-indigo-400/50",
          };
        }
        if (ratio >= 2.0) {
          return {
            label: "急増",
            class: "bg-indigo-500/10 text-indigo-400 border border-indigo-500/30",
          };
        }
        if (ratio >= 1.5) {
          return { label: "増加", class: "bg-slate-800 text-slate-300 border border-slate-700" };
        }
        return { label: "平常", class: "bg-slate-900 text-slate-500 border border-slate-800" };
      },
    };
  });
});
