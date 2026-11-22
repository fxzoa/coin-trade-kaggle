/**
 * btc-grid-deno: エントリポイント共通のブートストラップ処理
 * .env 読み込みとシグナルによるグレースフルシャットダウン登録を提供
 */

import { load } from '@std/dotenv';
import { toError } from './errors.ts';
import { logger } from './logger.ts';

/**
 * .env ファイルが存在すれば環境変数としてロードする (無ければ既存の環境変数を使用)
 */
export async function loadEnvFile(): Promise<void> {
  try {
    await load({ export: true });
  } catch (err: unknown) {
    const error = toError(err);
    // 環境変数から直接読み込み可能なため、デバッグログに留める
    logger.debug('[bootstrap] .env ファイル読み込みスキップ:', error.message);
  }
}

/**
 * SIGINT / SIGTERM 受信時に呼ばれるシャットダウンハンドラを登録する
 * @param handler シグナル名を受け取る終了処理 (呼び出し側で Deno.exit する)
 */
export function registerShutdown(handler: (signal: 'SIGINT' | 'SIGTERM') => Promise<void>): void {
  Deno.addSignalListener('SIGINT', () => handler('SIGINT'));
  Deno.addSignalListener('SIGTERM', () => handler('SIGTERM'));
}
