export interface PriceTick {
  symbol: string;
  price: number;
  timestamp: number;
}

export interface WsSubscription {
  type: string;
  user?: string;
  coin?: string;
  interval?: string;
}

export interface WsMessagePayload {
  method: "subscribe" | "unsubscribe" | "ping";
  subscription?: WsSubscription;
}

export interface HlBasicOrder {
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: string;
}

export interface HlPosition {
  coin: string;
  szi: string;
  entryPx?: string;
  positionValue?: string;
  unrealizedPnl?: string;
  returnOnEquity?: string;
  liquidationPx?: string | null;
  leverage?: {
    type: string;
    value: number;
  };
  marginUsed?: string;
  maxLeverage?: number;
  cumFunding?: {
    allTime?: string;
    sinceOpen?: string;
    sinceChange?: string;
  };
}

export interface HlOrderUpdate {
  order: HlBasicOrder;
  status: "open" | "filled" | "canceled" | "triggered" | "rejected" | "marginCanceled";
  statusTimestamp: number;
}

export interface HlUserFill {
  closedPnl: string;
  coin: string;
  crossed: boolean;
  fee: string;
  hash: string;
  oid: number;
  px: string;
  side: "B" | "A";
  startPosition: string;
  sz: string;
  time: number;
  tid?: number;
  cloid?: string;
  dir?: string;
}
