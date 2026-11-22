/**
 * hl-signal-evaluator-bot: 統合 Hyperliquid REST クライアント
 * - 新規注文発注 (Gtc, Ioc, Alo)
 * - 成行決済 (reduceOnly Ioc)
 * - ユーザー口座状態取得 (clearinghouseState, openOrders, withdrawable)
 */

import { HyperliquidSigner } from "./signer.ts";
import { HyperliquidError } from "./errors.ts";

export function roundPrice(px: number): number {
  if (px >= 10000) return Math.round(px);
  if (px >= 1000) return Math.round(px * 10) / 10;
  if (px >= 100) return Math.round(px * 100) / 100;
  if (px >= 1) return Math.round(px * 1000) / 1000;
  if (px >= 0.1) return Math.round(px * 10000) / 10000;
  return Math.round(px * 100000) / 100000;
}

export function roundSz(sz: number, szDecimals: number): number {
  const factor = Math.pow(10, szDecimals);
  return Math.floor(sz * factor) / factor;
}

export interface OpenOrderSpec {
  coin: string;
  isBuy: boolean; // LONG=true (BUY), SHORT=false (SELL)
  sz: number;
  limitPrice: number;
  orderType?: { limit: { tif: "Gtc" | "Ioc" | "Alo" } };
  reduceOnly?: boolean;
  cloid?: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: number;
  status: "FILLED" | "OPEN" | "REJECTED" | "ERROR";
  filledSz?: number;
  avgPx?: number;
  error?: string;
  raw?: any;
}

export interface MarketCloseOrderSpec {
  coin: string;
  isBuy: boolean; // LONGの決済=false, SHORTの決済=true
  sz: number;
  expectedPrice: number;
  slippage: number; // 例: 0.005 (0.5%)
  cloid?: string;
}

export class HyperliquidClient {
  private readonly apiUrl: string;
  private readonly walletAddress?: string;
  private readonly signer: HyperliquidSigner | null = null;
  private readonly isMainnet: boolean;
  private assetMetaCache: Record<string, { assetIndex: number; szDecimals: number }> = {};

  constructor(
    apiUrl = "https://api.hyperliquid.xyz",
    walletAddress?: string,
    secretKey?: string,
    isMainnet = true
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.walletAddress = walletAddress?.trim();
    this.isMainnet = isMainnet;
    if (secretKey && secretKey.trim()) {
      try {
        this.signer = new HyperliquidSigner(secretKey.trim());
      } catch (e) {
        console.error("[HyperliquidClient] Signer 初期化失敗:", e);
      }
    }
  }

  get canSign(): boolean {
    return this.signer !== null && !!this.walletAddress;
  }

  async getAssetMeta(coin: string): Promise<{ assetIndex: number; szDecimals: number }> {
    const upper = coin.toUpperCase();
    if (this.assetMetaCache[upper]) {
      return this.assetMetaCache[upper];
    }
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    if (!res.ok) {
      throw new Error(`Hyperliquid meta API エラー: HTTP ${res.status}`);
    }
    const meta = await res.json();
    const universe: Array<{ name: string; szDecimals: number }> = meta.universe || [];
    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i];
      this.assetMetaCache[asset.name.toUpperCase()] = {
        assetIndex: i,
        szDecimals: asset.szDecimals,
      };
    }
    const found = this.assetMetaCache[upper];
    if (!found) {
      throw new Error(`銘柄メタデータが見つかりません: ${upper}`);
    }
    return found;
  }

  async placeOrder(spec: OpenOrderSpec): Promise<OrderResult> {
    if (!this.canSign || !this.signer || !this.walletAddress) {
      return { success: false, status: "ERROR", error: "署名用秘密鍵またはウォレットが設定されていません" };
    }

    const meta = await this.getAssetMeta(spec.coin);
    const szRounded = roundSz(spec.sz, meta.szDecimals);
    const pxRounded = roundPrice(spec.limitPrice);

    if (szRounded <= 0 || pxRounded <= 0) {
      return {
        success: false,
        status: "ERROR",
        error: `無効な注文サイズまたは価格: sz=${szRounded}, px=${pxRounded}`,
      };
    }

    const nonce = Date.now();
    const action = {
      type: "order" as const,
      orders: [
        {
          a: meta.assetIndex,
          b: spec.isBuy,
          p: String(pxRounded),
          s: String(szRounded),
          r: spec.reduceOnly ?? false,
          t: spec.orderType ?? { limit: { tif: "Gtc" } },
          c: spec.cloid,
        },
      ],
      grouping: "na" as const,
    };

    const signature = await this.signer.signAction(action, nonce, this.isMainnet);
    const payload = { action, nonce, signature, vaultAddress: null };

    const res = await fetch(`${this.apiUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return {
        success: false,
        status: "ERROR",
        error: `Hyperliquid exchange API HTTP ${res.status}`,
      };
    }

    const resData = await res.json();
    if (resData.status === "ok") {
      const statuses = resData.response?.data?.statuses;
      if (Array.isArray(statuses) && statuses.length > 0) {
        const first = statuses[0];
        if (first.resting) {
          return {
            success: true,
            status: "OPEN",
            orderId: first.resting.oid,
            raw: resData,
          };
        } else if (first.filled) {
          return {
            success: true,
            status: "FILLED",
            orderId: first.filled.oid,
            filledSz: Number(first.filled.totalSz),
            avgPx: Number(first.filled.avgPx),
            raw: resData,
          };
        } else if (first.error) {
          return {
            success: false,
            status: "REJECTED",
            error: first.error,
            raw: resData,
          };
        }
      }
      return { success: true, status: "OPEN", raw: resData };
    }

    return {
      success: false,
      status: "REJECTED",
      error: resData.response || JSON.stringify(resData),
      raw: resData,
    };
  }

  async closePositionsBatch(specs: MarketCloseOrderSpec[]): Promise<Array<{ success: boolean; oid?: number; error?: string; filledSz?: number; avgPx?: number }>> {
    if (specs.length === 0) return [];
    if (!this.signer) {
      throw new HyperliquidError("署名用アカウントが設定されていないため、決済発注できません", {
        code: "SIGNER_NOT_CONFIGURED",
        statusCode: 400,
      });
    }

    const orders = [];
    for (const spec of specs) {
      const { assetIndex, szDecimals } = await this.getAssetMeta(spec.coin);
      const roundedSz = roundSz(spec.sz, szDecimals);
      if (roundedSz <= 0) continue;

      const limitPxRaw = spec.isBuy
        ? spec.expectedPrice * (1 + spec.slippage)
        : spec.expectedPrice * (1 - spec.slippage);
      const roundedPx = roundPrice(limitPxRaw);

      orders.push({
        a: assetIndex,
        b: spec.isBuy,
        p: String(roundedPx),
        s: String(roundedSz),
        r: true,
        t: { limit: { tif: "Ioc" } },
        c: spec.cloid,
      });
    }

    if (orders.length === 0) return [];

    const action = { type: "order", orders, grouping: "na" };
    const nonce = Date.now();
    const signature = await this.signer.signAction(action, nonce, this.isMainnet);

    const res = await fetch(`${this.apiUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, nonce, signature }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new HyperliquidError(`Hyperliquid exchange API エラー: HTTP ${res.status} - ${errText}`, {
        statusCode: res.status,
        code: `HYPERLIQUID_HTTP_${res.status}`,
      });
    }

    const payload = (await res.json()) as any;
    if (payload?.status === "err") {
      const errMsg = typeof payload.response === "string" ? payload.response : JSON.stringify(payload.response);
      return specs.map(() => ({ success: false, error: errMsg }));
    }

    const statuses = payload?.response?.data?.statuses || [];
    return specs.map((spec, idx) => {
      const st = statuses[idx];
      if (!st || st.error) {
        const error = st?.error || "決済受付拒否";
        return { success: false, error };
      }
      const oid = st.filled?.oid ?? st.resting?.oid;
      const filledSz = st.filled ? Number(st.filled.totalSz) : undefined;
      const avgPx = st.filled ? Number(st.filled.avgPx) : undefined;
      return { success: true, oid, filledSz, avgPx };
    });
  }

  async getUserState(): Promise<{ openOrders: any[]; positions: any[]; withdrawable: number }> {
    if (!this.walletAddress) {
      return { openOrders: [], positions: [], withdrawable: 0 };
    }
    const [clearinghouseRes, openOrdersRes] = await Promise.all([
      fetch(`${this.apiUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: this.walletAddress }),
      }),
      fetch(`${this.apiUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "frontendOpenOrders", user: this.walletAddress }),
      }),
    ]);

    const clearinghouse = clearinghouseRes.ok ? await clearinghouseRes.json() : null;
    const openOrders = openOrdersRes.ok ? await openOrdersRes.json() : [];

    const positions = (clearinghouse?.assetPositions || []).map((p: any) => p.position);
    const withdrawable = parseFloat(clearinghouse?.withdrawable || "0");

    return {
      openOrders: Array.isArray(openOrders) ? openOrders : [],
      positions: Array.isArray(positions) ? positions : [],
      withdrawable: isNaN(withdrawable) ? 0 : withdrawable,
    };
  }
}
