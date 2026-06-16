import { randomUUID } from "node:crypto";
import type { BithumbPublicClient, PriceQuote } from "./bithumb-client";
import { createWebSocket, type WebSocketLike } from "./node-websocket";

const BITHUMB_PUBLIC_WS_URL = "wss://ws-api.bithumb.com/websocket/v1";

export interface BithumbTickerWebSocketPriceSourceOptions {
  market: string;
  staleAfterMs: number;
  firstQuoteTimeoutMs: number;
  reconnectDelayMs?: number;
}

export class BithumbTickerWebSocketPriceSource {
  private socket: WebSocketLike | null = null;
  private latestQuote: PriceQuote | null = null;
  private reconnectTimer: unknown | null = null;
  private readonly waiters: Array<{ resolve: (quote: PriceQuote | null) => void }> = [];
  private closed = false;

  constructor(
    private readonly restClient: BithumbPublicClient,
    private readonly options: BithumbTickerWebSocketPriceSourceOptions,
  ) {}

  start(): void {
    if (this.options.market.length === 0 || this.closed) return;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer as number);
      this.reconnectTimer = null;
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(null);
    }
    if (this.socket != null) {
      this.socket.close();
      this.socket = null;
    }
  }

  async getCurrentPrice(market: string): Promise<PriceQuote> {
    if (market !== this.options.market) {
      return await this.restClient.getCurrentPrice(market);
    }
    this.start();

    const latest = this.getFreshQuote();
    if (latest != null) return latest;

    const quote = await this.waitForQuote(this.options.firstQuoteTimeoutMs);
    if (quote != null) return quote;

    return await this.restClient.getCurrentPrice(market);
  }

  async waitForNextQuote(
    market: string,
    timeoutMs: number,
    afterTimestamp?: string | null,
  ): Promise<PriceQuote | null> {
    if (market !== this.options.market) {
      await sleep(timeoutMs);
      return null;
    }
    this.start();

    const latest = this.getFreshQuote();
    if (latest != null && isAfterQuote(latest, afterTimestamp)) {
      return latest;
    }

    return await this.waitForQuote(timeoutMs);
  }

  private getFreshQuote(): PriceQuote | null {
    if (this.latestQuote == null) return null;
    const ageMs = Date.now() - new Date(this.latestQuote.timestamp).getTime();
    return ageMs <= this.options.staleAfterMs ? this.latestQuote : null;
  }

  private connect(): void {
    if (this.closed || this.socket != null) return;

    const socket = createWebSocket(BITHUMB_PUBLIC_WS_URL);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify([
          { ticket: `bithumb-grid-farmer-${randomUUID()}` },
          {
            type: "ticker",
            codes: [this.options.market.toUpperCase()],
            isOnlyRealtime: false,
          },
          { format: "DEFAULT" },
        ]),
      );
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data).catch((error) => {
        console.error(`[grid-bot] failed to parse Bithumb websocket ticker: ${String(error)}`);
      });
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        socket.close();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer != null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectDelayMs ?? 2_000);
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = await readMessageText(data);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const type = parsed.type;
    if (type !== "ticker") return;

    const market = readString(parsed, "code");
    if (market !== this.options.market) return;

    const tradePrice = readNumber(parsed, "trade_price");
    const timestampMs = readOptionalNumber(parsed, "trade_timestamp") ?? readOptionalNumber(parsed, "timestamp") ?? Date.now();
    this.publish({
      market,
      tradePrice,
      timestamp: new Date(timestampMs).toISOString(),
      source: "BITHUMB_WS",
    });
  }

  private publish(quote: PriceQuote): void {
    this.latestQuote = quote;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(quote);
    }
  }

  private async waitForQuote(timeoutMs: number): Promise<PriceQuote | null> {
    return await new Promise<PriceQuote | null>((resolve) => {
      const waiter: { resolve: (quote: PriceQuote | null) => void } = { resolve };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      waiter.resolve = (quote) => {
        clearTimeout(timer as number);
        resolve(quote);
      };
      this.waiters.push(waiter);
    });
  }
}

async function readMessageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
    return new TextDecoder().decode(bytes);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  throw new Error(`Unsupported websocket message payload: ${typeof data}`);
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Bithumb websocket ticker missing ${key}.`);
  }
  return field;
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Bithumb websocket ticker field ${key} is not numeric.`);
  }
  return field;
}

function readOptionalNumber(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isAfterQuote(quote: PriceQuote, afterTimestamp?: string | null): boolean {
  if (afterTimestamp == null) return true;
  return new Date(quote.timestamp).getTime() > new Date(afterTimestamp).getTime();
}
