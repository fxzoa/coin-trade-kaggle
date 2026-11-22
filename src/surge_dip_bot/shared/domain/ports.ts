/** Cloudflare KV を読み取る口 (実装は infrastructure、テストではモックに差し替える) */
export interface KvReader {
  /** キーの値を返す。キーが存在しなければ null。取得に失敗した場合は reject する */
  get(key: string): Promise<string | null>;
}

/** 銘柄ごとの 24H 取引高 (USD, dayNtlVlm) を参照する口 */
export interface VolumeLookup {
  /** 取引高を返す。未取得・対象外の銘柄は undefined */
  get(symbol: string): number | undefined;
}

/** Cloudflare KV 一括書き込みのエントリ */
export interface KvBulkEntry {
  key: string;
  value: string;
  expirationTtl?: number;
}

/** Cloudflare KV へ書き込む口 (実装は infrastructure、テストではモックに差し替える) */
export interface KvWriter {
  /** 単一キーに文字列を書き込む */
  put(key: string, value: string, expirationTtl?: number): Promise<void>;
  /** 複数キーを一括で書き込む (Cloudflare KV bulk API) */
  putBulk(entries: KvBulkEntry[]): Promise<void>;
}
