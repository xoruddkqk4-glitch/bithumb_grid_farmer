import type { OrderExecution, OrderExecutor } from "../../../../packages/shared/src/types";
import type { BithumbPrivateClient } from "../bithumb/bithumb-client";

export interface RealOrderExecutorOptions {
  enabled: boolean;
  client: BithumbPrivateClient;
  maxOrderKrw: number;
}

export class RealOrderExecutor implements OrderExecutor {
  constructor(private readonly options: RealOrderExecutorOptions) {}

  async buyMarket(params: {
    market: string;
    price: number;
    amountKrw: number;
    requestId: string;
  }): Promise<OrderExecution> {
    if (!this.options.enabled) {
      throw new Error("Real orders are disabled. Set ENABLE_REAL_ORDERS=true only after paper validation.");
    }
    this.assertWithinOrderLimit(params.amountKrw);
    const krwAvailable = await this.options.client.getAvailableBalance("KRW");
    if (krwAvailable < params.amountKrw) {
      throw new Error(`Insufficient KRW balance for real buy. available=${krwAvailable} required=${params.amountKrw}`);
    }
    return await this.options.client.buyMarket(params);
  }

  async sellMarket(params: {
    market: string;
    price: number;
    qty: number;
    requestId: string;
  }): Promise<OrderExecution> {
    if (!this.options.enabled) {
      throw new Error("Real orders are disabled. Set ENABLE_REAL_ORDERS=true only after paper validation.");
    }
    this.assertWithinOrderLimit(params.price * params.qty);
    const assetCurrency = params.market.split("-")[1];
    if (!assetCurrency) {
      throw new Error(`Cannot infer asset currency from market ${params.market}.`);
    }
    const assetAvailable = await this.options.client.getAvailableBalance(assetCurrency);
    if (assetAvailable < params.qty) {
      throw new Error(
        `Insufficient ${assetCurrency} balance for real sell. available=${assetAvailable} required=${params.qty}`,
      );
    }
    return await this.options.client.sellMarket(params);
  }

  private assertWithinOrderLimit(amountKrw: number): void {
    if (!Number.isFinite(amountKrw) || amountKrw <= 0) {
      throw new Error(`Real order amount must be positive. Received: ${amountKrw}`);
    }
    if (amountKrw > this.options.maxOrderKrw) {
      throw new Error(
        `Real order amount ${amountKrw} exceeds GRID_BOT_MAX_REAL_ORDER_KRW=${this.options.maxOrderKrw}.`,
      );
    }
  }
}

export function selectOrderExecutor(params: {
  enableRealOrders: boolean;
  paperExecutor: OrderExecutor;
  realExecutor: OrderExecutor;
}): OrderExecutor {
  return params.enableRealOrders ? params.realExecutor : params.paperExecutor;
}
