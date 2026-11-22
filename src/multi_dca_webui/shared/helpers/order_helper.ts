/**
 * dca-deno: 注文関連ユーティリティ (価格丸め、数量丸め、cloid生成、注文パラメータ検証)
 */

import { ok, err, type Result } from '../result.ts';
import { OrderError } from '../errors.ts';

/**
 * Hyperliquid 取引所ルールに従った価格丸め (有効数字 5 桁、大きな数値の整数対応)
 */
export function roundPrice(price: number): number {
  if (price <= 0) return 0;
  if (price >= 100000) {
    return Math.round(price);
  }
  if (price >= 10000) {
    return Math.round(price * 10) / 10;
  }
  return Number(price.toPrecision(5));
}

/**
 * 通貨注文数量を szDecimals に応じて切り捨て丸め
 */
export function roundSz(sz: number, szDecimals: number = 2): number {
  if (sz <= 0) return 0;
  const factor = Math.pow(10, szDecimals);
  return Math.floor(sz * factor) / factor;
}

/**
 * Hyperliquid 用 128-bit hex 形式の cloid を生成
 */
export function generateCloid(): string {
  const randomHex = Math.random().toString(16).substring(2, 10);
  return `0x${randomHex}${Date.now().toString(16).padStart(24, '0')}`.substring(0, 34);
}

export interface ValidOrderParams {
  coin: string;
  limitPx: number;
  sz: number;
}

/**
 * 注文パラメータの妥当性を検証し、丸め処理済みの値を Result 型で返却
 */
export function validateOrderParams(
  coin: string,
  limitPx: number,
  sz: number,
  szDecimals = 2
): Result<ValidOrderParams, OrderError> {
  if (!coin || !coin.trim()) {
    return err(new OrderError('通貨名 (coin) が指定されていません'));
  }
  const roundedPx = roundPrice(limitPx);
  if (roundedPx <= 0 || !Number.isFinite(roundedPx)) {
    return err(new OrderError(`注文価格が不正です: limitPx=${limitPx}`));
  }
  const roundedSz = roundSz(sz, szDecimals);
  if (roundedSz <= 0 || !Number.isFinite(roundedSz)) {
    return err(new OrderError(`注文数量が不正です: sz=${sz}, szDecimals=${szDecimals}`));
  }
  return ok({
    coin: coin.toUpperCase(),
    limitPx: roundedPx,
    sz: roundedSz,
  });
}
