/**
 * btc-grid-deno: 節目グリッドBuyLimit評価モジュール (純粋関数)
 *
 * 節目レベル算出式:
 *   buyLevel = floor((markPx - offsetUsd) / stepUsd) * stepUsd - stepUsd
 *   (現在の価格帯の1段下の節目にBuyLimitを置く)
 */

import { type Result, ok, err } from '../../shared/result.ts';
import { GridError } from '../../shared/errors.ts';

export interface GridDecision {
  action: 'PLACE' | 'KEEP' | 'SKIP';
  desiredLevel: number;
  reason: string;
}

/**
 * 節目グリッドレベルの妥当性を検証し、計算された BuyLimit レベルを Result 型で返す
 */
export function validateGridLevel(
  markPx: number,
  stepUsd: number,
  offsetUsd: number = 0
): Result<number, GridError> {
  if (!Number.isFinite(markPx) || markPx <= 0) {
    return err(new GridError(`無効なマーク価格のため節目レベルを算出できません (markPx=${markPx})`));
  }
  if (!Number.isFinite(stepUsd) || stepUsd <= 0) {
    return err(new GridError(`無効なグリッドステップです: stepUsd=${stepUsd}`));
  }
  const level = Math.floor((markPx - offsetUsd) / stepUsd) * stepUsd - stepUsd;
  if (level <= 0) {
    return err(new GridError(`無効なマーク価格のため節目レベルを算出できません (markPx=${markPx})`));
  }
  return ok(level);
}

/**
 * 現在のマーク価格から節目グリッドのBuyLimitレベルを算出する (後方互換用)
 */
export function computeGridBuyLevel(markPx: number, stepUsd: number, offsetUsd: number = 0): number {
  const result = validateGridLevel(markPx, stepUsd, offsetUsd);
  return result.ok ? result.value : 0;
}

/**
 * 節目グリッドの発注判断を評価し、Result 型で返す
 */
export function evaluateGridDecision(
  markPx: number,
  activeOrderLevels: number[],
  stepUsd: number,
  offsetUsd: number = 0
): Result<GridDecision, GridError> {
  const levelResult = validateGridLevel(markPx, stepUsd, offsetUsd);
  if (!levelResult.ok) {
    return err(levelResult.error);
  }

  const desiredLevel = levelResult.value;

  if (activeOrderLevels.includes(desiredLevel)) {
    return ok({
      action: 'KEEP',
      desiredLevel,
      reason: `同一レベルの既存指値(${desiredLevel})が存在するため新規発注しません`,
    });
  }

  return ok({
    action: 'PLACE',
    desiredLevel,
    reason: `現在価格(${markPx})から節目グリッドレベル ${desiredLevel} を算出し、既存指値(${activeOrderLevels.join(',') || 'なし'})は維持したまま新規発注します`,
  });
}

/**
 * 現在価格と既存のアクティブ指値レベル群から、発注/維持/スキップを判定する
 * (同一レベルの注文が既に存在すれば KEEP、無ければ旧注文を残したまま PLACE する)
 */
export function decideGridAction(
  markPx: number,
  activeOrderLevels: number[],
  stepUsd: number,
  offsetUsd: number = 0
): GridDecision {
  const decisionResult = evaluateGridDecision(markPx, activeOrderLevels, stepUsd, offsetUsd);
  if (!decisionResult.ok) {
    return {
      action: 'SKIP',
      desiredLevel: computeGridBuyLevel(markPx, stepUsd, offsetUsd),
      reason: decisionResult.error.message,
    };
  }
  return decisionResult.value;
}
