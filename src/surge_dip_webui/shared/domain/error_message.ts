/** Cloudflare の識別子 (32 桁 16 進数または UUID) */
const CLOUDFLARE_ID =
  "(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

/** URL のパス中にある Cloudflare の識別子 (accounts / d1/database / namespaces / queues) */
const CLOUDFLARE_ID_IN_PATH = new RegExp(
  `/(accounts|database|namespaces|queues)/${CLOUDFLARE_ID}`,
  "gi",
);

/**
 * ログ出力用に、メッセージ中の Cloudflare の識別子を '***' に置き換える。
 * fetch の失敗メッセージには URL (アカウント・DB・KV・Queue の ID) が含まれるため、ログへ出す前に伏せる
 */
export function redactCloudflareIds(message: string): string {
  return message.replace(CLOUDFLARE_ID_IN_PATH, "/$1/***");
}

/** Authorization ヘッダ相当の値 (スキームも含めて伏せる) */
const AUTHORIZATION_VALUE =
  /(authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;]+/gi;

/** 単独で現れる Bearer トークン */
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * ログ出力用に、Cloudflare の識別子に加えて認証情報 (Authorization の値・Bearer トークン) を伏せる。
 * 例外メッセージに誤ってヘッダ値が混入してもログへ出さないための二重の防御
 */
export function redactSecrets(message: string): string {
  return redactCloudflareIds(message)
    .replace(AUTHORIZATION_VALUE, "$1***")
    .replace(BEARER_TOKEN, "Bearer ***");
}

/** 例外から、識別子と認証情報を伏せた表示用メッセージを作る */
export function errorMessage(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}
