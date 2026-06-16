import { createHash, createHmac, randomUUID } from "node:crypto";
import { sleep, withRetry } from "./rate-limiter";
import { calculateBuyQty, roundKrw } from "../../../../packages/shared/src";
import type { OrderExecution } from "../../../../packages/shared/src/types";

export interface PriceQuote {
  market: string;
  tradePrice: number;
  timestamp: string;
  source: "BITHUMB_REST" | "BITHUMB_WS" | "MOCK";
}

export interface DayCandle {
  market: string;
  candleDateTimeKst: string;
  openingPrice: number;
  highPrice: number;
  lowPrice: number;
  tradePrice: number;
  candleAccTradePrice: number;
  timestamp: string;
}

export function filterConfirmedDayCandles(candles: DayCandle[], now = new Date()): DayCandle[] {
  const todayKst = formatKstDateKey(now);
  return candles.filter((candle) => candle.candleDateTimeKst.slice(0, 10) < todayKst);
}

function formatKstDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export class BithumbPublicClient {
  constructor(private readonly options: { mockPrice: number | null }) {}

  async getCurrentPrice(market: string): Promise<PriceQuote> {
    if (this.options.mockPrice != null) {
      return this.mockQuote(market, this.options.mockPrice);
    }

    try {
      return await withRetry(() => this.fetchTicker(market), {
        attempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 2_000,
      });
    } catch (error) {
      throw new Error(
        `Failed to fetch Bithumb ticker for ${market}. Set GRID_BOT_MOCK_PRICE for offline paper runs. ${String(
          error,
        )}`,
      );
    }
  }

  async getDayCandles(market: string, count: number): Promise<DayCandle[]> {
    if (this.options.mockPrice != null) {
      return this.mockDayCandles(market, this.options.mockPrice, count);
    }

    try {
      return await withRetry(() => this.fetchDayCandles(market, count), {
        attempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 2_000,
      });
    } catch (error) {
      throw new Error(`Failed to fetch Bithumb day candles for ${market}. ${String(error)}`);
    }
  }

  private async fetchTicker(market: string): Promise<PriceQuote> {
    const url = `https://api.bithumb.com/v1/ticker?markets=${encodeURIComponent(market)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Bithumb ticker HTTP ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    const first = Array.isArray(json) ? json[0] : null;
    const tradePrice = readNumberField(first, "trade_price");
    const timestampMs = readOptionalNumberField(first, "timestamp") ?? Date.now();

    return {
      market,
      tradePrice,
      timestamp: new Date(timestampMs).toISOString(),
      source: "BITHUMB_REST",
    };
  }

  private mockQuote(market: string, price: number): PriceQuote {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`GRID_BOT_MOCK_PRICE must be positive. Received: ${price}`);
    }
    return {
      market,
      tradePrice: price,
      timestamp: new Date().toISOString(),
      source: "MOCK",
    };
  }

  private async fetchDayCandles(market: string, count: number): Promise<DayCandle[]> {
    const targetCount = Math.max(1, Math.floor(count));
    const pageSize = 200;
    const candlesByDate = new Map<string, DayCandle>();
    let nextTo: string | null = null;
    let guard = 0;

    while (candlesByDate.size < targetCount) {
      guard += 1;
      if (guard > 10) break;

      const pageCount = Math.min(pageSize, targetCount);
      const page = await this.fetchDayCandlePage(market, pageCount, nextTo);
      if (page.length === 0) break;

      for (const candle of page) {
        candlesByDate.set(candle.candleDateTimeKst, candle);
      }

      const sortedPage = page.sort((left, right) => left.candleDateTimeKst.localeCompare(right.candleDateTimeKst));
      const oldest = sortedPage[0];
      if (oldest == null || oldest.candleDateTimeKst === nextTo) break;
      nextTo = oldest.candleDateTimeKst;

      if (candlesByDate.size < targetCount) {
        await sleep(200);
      }
    }

    return Array.from(candlesByDate.values())
      .sort((left, right) => left.candleDateTimeKst.localeCompare(right.candleDateTimeKst))
      .slice(-targetCount);
  }

  private async fetchDayCandlePage(market: string, count: number, to: string | null): Promise<DayCandle[]> {
    const params = new URLSearchParams({
      market,
      count: String(count),
    });
    if (to != null) {
      params.set("to", to);
    }
    const url = `https://api.bithumb.com/v1/candles/days?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Bithumb day candles HTTP ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    if (!Array.isArray(json)) {
      throw new Error("Bithumb day candles response is not an array.");
    }

    return json
      .map((item) => this.parseDayCandle(item, market))
      .sort((left, right) => left.candleDateTimeKst.localeCompare(right.candleDateTimeKst));
  }

  private parseDayCandle(value: unknown, market: string): DayCandle {
    return {
      market: readOptionalStringFromUnknown(value, "market") ?? market,
      candleDateTimeKst: readStringFromUnknown(value, "candle_date_time_kst"),
      openingPrice: readNumberField(value, "opening_price"),
      highPrice: readNumberField(value, "high_price"),
      lowPrice: readNumberField(value, "low_price"),
      tradePrice: readNumberField(value, "trade_price"),
      candleAccTradePrice: readNumberField(value, "candle_acc_trade_price"),
      timestamp: new Date(readOptionalNumberField(value, "timestamp") ?? Date.now()).toISOString(),
    };
  }

  private mockDayCandles(market: string, price: number, count: number): DayCandle[] {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`GRID_BOT_MOCK_PRICE must be positive. Received: ${price}`);
    }
    const now = new Date();
    return Array.from({ length: count }, (_, index) => {
      const age = count - index - 1;
      const date = new Date(now);
      date.setUTCDate(now.getUTCDate() - age);
      const drift = 1 - age * 0.0005;
      const close = price * drift;
      return {
        market,
        candleDateTimeKst: date.toISOString().slice(0, 10),
        openingPrice: close * 0.995,
        highPrice: close * 1.01,
        lowPrice: close * 0.99,
        tradePrice: close,
        candleAccTradePrice: 100_000_000_000,
        timestamp: date.toISOString(),
      };
    });
  }
}

export interface BithumbPrivateClientOptions {
  accessKey: string;
  secretKey: string;
  feeRate: number;
}

export interface BithumbAccountBalance {
  currency: string;
  balance: number;
  locked: number;
  avgBuyPrice: number;
  unitCurrency: string;
}

export class BithumbPrivateClient {
  private readonly apiUrl = "https://api.bithumb.com";

  constructor(private readonly options: BithumbPrivateClientOptions) {}

  async getAccounts(): Promise<BithumbAccountBalance[]> {
    const response = await this.authenticatedRequest("GET", "/v1/accounts");
    if (!Array.isArray(response)) {
      throw new Error("Bithumb accounts response is not an array.");
    }
    return response.map((account) => ({
      currency: readStringField(asRecord(account), "currency"),
      balance: readNumericStringField(asRecord(account), "balance"),
      locked: readNumericStringField(asRecord(account), "locked"),
      avgBuyPrice: readOptionalNumericStringField(asRecord(account), "avg_buy_price") ?? 0,
      unitCurrency: readOptionalStringField(asRecord(account), "unit_currency") ?? "KRW",
    }));
  }

  async getAvailableBalance(currency: string): Promise<number> {
    const accounts = await this.getAccounts();
    const account = accounts.find((item) => item.currency.toUpperCase() === currency.toUpperCase());
    return account?.balance ?? 0;
  }

  async buyMarket(params: {
    market: string;
    price: number;
    amountKrw: number;
    requestId: string;
  }): Promise<OrderExecution> {
    const body = {
      market: params.market,
      side: "bid",
      price: String(Math.round(params.amountKrw)),
      ord_type: "price",
    };
    const response = await this.postOrder(body);
    const order = await this.tryGetOrder(readStringField(response, "uuid"));
    const qty = readOptionalNumericStringField(order, "executed_volume") ?? calculateBuyQty(params.amountKrw, params.price);
    const feeKrw = readOptionalNumericStringField(order, "paid_fee") ?? roundKrw(params.amountKrw * this.options.feeRate);
    return {
      orderId: readStringField(response, "uuid"),
      requestId: params.requestId,
      market: params.market,
      side: "BUY",
      price: params.price,
      qty,
      amountKrw: params.amountKrw,
      feeKrw,
      executedAt: readOptionalStringField(response, "created_at") ?? new Date().toISOString(),
      isPaper: false,
    };
  }

  async buyLimit(params: {
    market: string;
    price: number;
    amountKrw: number;
    requestId: string;
    waitMs?: number;
  }): Promise<OrderExecution> {
    const qty = calculateBuyQty(params.amountKrw, params.price);
    const body = {
      market: params.market,
      side: "bid",
      price: String(params.price),
      volume: String(qty),
      ord_type: "limit",
    };
    const response = await this.postOrder(body);
    const orderId = readOrderId(response);
    const order = await this.tryGetOrder(orderId, params.waitMs);
    const executedQty = readOptionalNumericStringField(order, "executed_volume") ?? qty;
    const amountKrw = roundKrw(params.price * executedQty);
    const feeKrw = readOptionalNumericStringField(order, "paid_fee") ?? roundKrw(amountKrw * this.options.feeRate);
    return {
      orderId,
      requestId: params.requestId,
      market: params.market,
      side: "BUY",
      price: params.price,
      qty: executedQty,
      amountKrw,
      feeKrw,
      executedAt: readOptionalStringField(response, "created_at") ?? new Date().toISOString(),
      isPaper: false,
    };
  }

  async sellMarket(params: {
    market: string;
    price: number;
    qty: number;
    requestId: string;
  }): Promise<OrderExecution> {
    const body = {
      market: params.market,
      side: "ask",
      volume: String(params.qty),
      ord_type: "market",
    };
    const response = await this.postOrder(body);
    const order = await this.tryGetOrder(readStringField(response, "uuid"));
    const qty = readOptionalNumericStringField(order, "executed_volume") ?? params.qty;
    const amountKrw = roundKrw(params.price * qty);
    const feeKrw = readOptionalNumericStringField(order, "paid_fee") ?? roundKrw(amountKrw * this.options.feeRate);
    return {
      orderId: readStringField(response, "uuid"),
      requestId: params.requestId,
      market: params.market,
      side: "SELL",
      price: params.price,
      qty,
      amountKrw,
      feeKrw,
      executedAt: readOptionalStringField(response, "created_at") ?? new Date().toISOString(),
      isPaper: false,
    };
  }

  async sellLimit(params: {
    market: string;
    price: number;
    qty: number;
    requestId: string;
    waitMs?: number;
  }): Promise<OrderExecution> {
    const body = {
      market: params.market,
      side: "ask",
      price: String(params.price),
      volume: String(params.qty),
      ord_type: "limit",
    };
    const response = await this.postOrder(body);
    const orderId = readOrderId(response);
    const order = await this.tryGetOrder(orderId, params.waitMs);
    const qty = readOptionalNumericStringField(order, "executed_volume") ?? params.qty;
    const amountKrw = roundKrw(params.price * qty);
    const feeKrw = readOptionalNumericStringField(order, "paid_fee") ?? roundKrw(amountKrw * this.options.feeRate);
    return {
      orderId,
      requestId: params.requestId,
      market: params.market,
      side: "SELL",
      price: params.price,
      qty,
      amountKrw,
      feeKrw,
      executedAt: readOptionalStringField(response, "created_at") ?? new Date().toISOString(),
      isPaper: false,
    };
  }

  private async postOrder(body: Record<string, string>): Promise<Record<string, unknown>> {
    return asRecord(await this.authenticatedRequest("POST", "/v1/orders", body));
  }

  private async tryGetOrder(uuid: string, waitMs = 1_000): Promise<Record<string, unknown>> {
    await sleep(waitMs);
    try {
      return asRecord(await this.authenticatedRequest("GET", "/v1/order", { uuid }));
    } catch {
      return {};
    }
  }

  private async authenticatedRequest(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    const url = method === "GET" && query.length > 0 ? `${this.apiUrl}${path}?${query}` : `${this.apiUrl}${path}`;
    const init: {
      method: "GET" | "POST";
      headers: Record<string, string>;
      body?: string;
    } = {
      method,
      headers: {
        Authorization: `Bearer ${this.createJwt(params)}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
    };
    if (method === "POST") {
      init.body = JSON.stringify(params);
    }
    const response = await fetch(url, init);
    const json = await response.json();
    if (!response.ok) {
      throw new Error(`Bithumb ${path} HTTP ${response.status} ${response.statusText}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  private createJwt(params: Record<string, string>): string {
    if (this.options.accessKey.length === 0 || this.options.secretKey.length === 0) {
      throw new Error("Bithumb API keys are required. Set BITHUMB_ACCESS_KEY and BITHUMB_SECRET_KEY.");
    }
    const header = { alg: "HS256", typ: "JWT" };
    const payload: Record<string, string | number> = {
      access_key: this.options.accessKey,
      nonce: randomUUID(),
      timestamp: Date.now(),
    };
    const query = new URLSearchParams(params).toString();
    if (query.length > 0) {
      payload.query_hash = createHash("sha512").update(query).digest("hex");
      payload.query_hash_alg = "SHA512";
    }
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
    const signature = createHmac("sha256", this.options.secretKey).update(signingInput).digest("base64url");
    return `${signingInput}.${signature}`;
  }
}

function readNumberField(value: unknown, key: string): number {
  if (!value || typeof value !== "object" || !(key in value)) {
    throw new Error(`Bithumb ticker response missing ${key}.`);
  }
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Bithumb ticker field ${key} is not numeric.`);
  }
  return field;
}

function readStringFromUnknown(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || !(key in value)) {
    throw new Error(`Bithumb response missing ${key}.`);
  }
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Bithumb response field ${key} is not a string.`);
  }
  return field;
}

function readOptionalStringFromUnknown(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function readOptionalNumberField(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function readStringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Bithumb order response missing ${key}.`);
  }
  return field;
}

function readOrderId(value: Record<string, unknown>): string {
  const uuid = typeof value.uuid === "string" && value.uuid.length > 0 ? value.uuid : null;
  const orderId = typeof value.order_id === "string" && value.order_id.length > 0 ? value.order_id : null;
  const id = uuid ?? orderId;
  if (id == null) {
    throw new Error("Bithumb order response missing uuid/order_id.");
  }
  return id;
}

function readOptionalStringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function readNumericStringField(value: Record<string, unknown>, key: string): number {
  const result = readOptionalNumericStringField(value, key);
  if (result == null) {
    throw new Error(`Bithumb response field ${key} is not numeric.`);
  }
  return result;
}

function readOptionalNumericStringField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  const valueToParse = typeof field === "string" || typeof field === "number" ? Number(field) : null;
  return valueToParse != null && Number.isFinite(valueToParse) ? valueToParse : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bithumb response is not an object.");
  }
  return value as Record<string, unknown>;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
