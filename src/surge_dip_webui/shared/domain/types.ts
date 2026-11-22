/** 1銘柄の価格ティック */
export interface PriceTick {
  /** 銘柄シンボル (例: "BTC") */
  symbol: string;
  /** 中間価格 */
  price: number;
  /** 受信時刻 (エポックミリ秒) */
  timestamp: number;
}
