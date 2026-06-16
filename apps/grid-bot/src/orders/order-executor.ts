import type { OrderExecution, OrderExecutor } from "../../../../packages/shared/src/types";
import type { BithumbPrivateClient } from "../bithumb/bithumb-client";

export interface RealOrderExecutorOptions {
  enabled: boolean;
  client: BithumbPrivateClient;
  maxOrderKrw: number;
  useAggressiveLimitOrders: boolean;
  aggressiveLimitOffsetPct: number;
  aggressiveLimitWaitMs: number;
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
    if (this.options.useAggressiveLimitOrders) {
      const price = calculateAggressiveLimitPrice("BUY", params.price, this.options.aggressiveLimitOffsetPct);
      return await this.options.client.buyLimit({
        ...params,
        price,
        waitMs: this.options.aggressiveLimitWaitMs,
      });
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
    if (this.options.useAggressiveLimitOrders) {
      const price = calculateAggressiveLimitPrice("SELL", params.price, this.options.aggressiveLimitOffsetPct);
      return await this.options.client.sellLimit({
        ...params,
        price,
        waitMs: this.options.aggressiveLimitWaitMs,
      });
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

function calculateAggressiveLimitPrice(side: "BUY" | "SELL", referencePrice: number, offsetPct: number): number {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error(`Aggressive limit reference price must be positive. Received: ${referencePrice}`);
  }
  if (!Number.isFinite(offsetPct) || offsetPct < 0 || offsetPct > 0.05) {
    throw new Error(`Aggressive limit offset must be between 0 and 5%. Received: ${offsetPct}`);
  }
  const rawPrice = side === "BUY" ? referencePrice * (1 + offsetPct) : referencePrice * (1 - offsetPct);
  return roundToBithumbKrwTick(rawPrice, side === "BUY" ? "UP" : "DOWN");
}

function roundToBithumbKrwTick(price: number, direction: "UP" | "DOWN"): number {
  const tick = getBithumbKrwTick(price);
  const scaled = price / tick;
  const rounded = direction === "UP" ? Math.ceil(scaled) : Math.floor(scaled);
  return Math.max(tick, rounded * tick);
}

function getBithumbKrwTick(price: number): number {
  if (price >= 1_000_000) return 1_000;
  if (price >= 500_000) return 500;
  if (price >= 100_000) return 100;
  if (price >= 50_000) return 50;
  if (price >= 10_000) return 10;
  if (price >= 5_000) return 5;
  if (price >= 1_000) return 1;
  if (price >= 100) return 0.1;
  if (price >= 10) return 0.01;
  return 0.001;
}

export function selectOrderExecutor(params: {
  enableRealOrders: boolean;
  paperExecutor: OrderExecutor;
  realExecutor: OrderExecutor;
}): OrderExecutor {
  return params.enableRealOrders ? params.realExecutor : params.paperExecutor;
}
