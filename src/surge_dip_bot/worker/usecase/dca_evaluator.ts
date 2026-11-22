import { evaluateDcaSignals } from "../../shared/domain/dca_rules.ts";
import type { TradeSignal } from "../../shared/domain/trade_signal.ts";
import type { PriceTick } from "../../shared/domain/types.ts";
import type { DcaPositionCache } from "./dca_position_cache.ts";

/**
 * ティックの価格 (allMids の中間価格 = 現在価格) を、その銘柄の OPEN ポジションに当てて
 * DCA シグナルを判定する。OPEN ポジションが無い銘柄はキャッシュ参照だけで即座に空を返す
 */
export class DcaEvaluator {
  constructor(
    private readonly positions: Pick<DcaPositionCache, "positionsOf">,
    private readonly now: () => number = Date.now,
  ) {}

  /** ティックを判定し、成立した DCA シグナルを返す (ポジション順に Tier1 → Tier2) */
  evaluate(tick: PriceTick): TradeSignal[] {
    return this.positions.positionsOf(tick.symbol).flatMap((position) =>
      evaluateDcaSignals(position, tick.price, this.now())
    );
  }
}
