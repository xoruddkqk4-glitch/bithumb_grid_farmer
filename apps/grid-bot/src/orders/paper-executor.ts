import { randomUUID } from "node:crypto";
import { calculateBuyQty, roundKrw } from "../../../../packages/shared/src";
import type { OrderExecution, OrderExecutor } from "../../../../packages/shared/src/types";

export class PaperOrderExecutor implements OrderExecutor {
  constructor(private readonly feeRate: number) {}

  async buyMarket(params: {
    market: string;
    price: number;
    amountKrw: number;
    requestId: string;
  }): Promise<OrderExecution> {
    const qty = calculateBuyQty(params.amountKrw, params.price);
    return {
      orderId: `paper-buy-${randomUUID()}`,
      requestId: params.requestId,
      market: params.market,
      side: "BUY",
      price: params.price,
      qty,
      amountKrw: params.amountKrw,
      feeKrw: roundKrw(params.amountKrw * this.feeRate),
      executedAt: new Date().toISOString(),
      isPaper: true,
    };
  }

  async sellMarket(params: {
    market: string;
    price: number;
    qty: number;
    requestId: string;
  }): Promise<OrderExecution> {
    const amountKrw = roundKrw(params.price * params.qty);
    return {
      orderId: `paper-sell-${randomUUID()}`,
      requestId: params.requestId,
      market: params.market,
      side: "SELL",
      price: params.price,
      qty: params.qty,
      amountKrw,
      feeKrw: roundKrw(amountKrw * this.feeRate),
      executedAt: new Date().toISOString(),
      isPaper: true,
    };
  }
}
