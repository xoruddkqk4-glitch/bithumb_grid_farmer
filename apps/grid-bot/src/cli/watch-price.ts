import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DEFAULT_LOOP_INTERVAL_MS, DEFAULT_MARKET } from "../../../../packages/shared/src";
import { sleep } from "../bithumb/rate-limiter";
import { BithumbPublicClient, type PriceQuote } from "../bithumb/bithumb-client";

interface PriceWatcherConfig {
  market: string;
  intervalMs: number;
  maxLoops: number | null;
  logPath: string;
  latestPath: string;
}

function loadPriceWatcherConfig(): PriceWatcherConfig {
  const market = process.env.PRICE_WATCH_MARKET || process.env.GRID_BOT_MARKET || DEFAULT_MARKET;
  const intervalMs = readNumber("PRICE_WATCH_INTERVAL_MS", DEFAULT_LOOP_INTERVAL_MS);
  const maxLoops = readOptionalPositiveInt("PRICE_WATCH_MAX_LOOPS");
  const safeMarket = market.replace(/[^A-Z0-9-]/g, "_");

  return {
    market,
    intervalMs,
    maxLoops,
    logPath: resolve(process.cwd(), process.env.PRICE_WATCH_LOG_PATH || `data/price_ticks/${safeMarket}.jsonl`),
    latestPath: resolve(
      process.cwd(),
      process.env.PRICE_WATCH_LATEST_PATH || `data/price_ticks/${safeMarket}.latest.json`,
    ),
  };
}

async function main(): Promise<void> {
  const config = loadPriceWatcherConfig();
  const client = new BithumbPublicClient({ mockPrice: null });

  console.log(`[price-watch] started market=${config.market} intervalMs=${config.intervalMs}`);

  let loops = 0;
  while (true) {
    loops += 1;
    try {
      const quote = await client.getCurrentPrice(config.market);
      await writeQuote(config, quote);
      console.log(`[price-watch] loop=${loops} market=${quote.market} price=${quote.tradePrice} ts=${quote.timestamp}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = {
        timestamp: new Date().toISOString(),
        market: config.market,
        action: "PRICE_WATCH_ERROR",
        message,
      };
      await appendJsonLine(config.logPath, record);
      console.error(`[price-watch] ${message}`);
    }

    if (config.maxLoops != null && loops >= config.maxLoops) {
      console.log(`[price-watch] stopped after PRICE_WATCH_MAX_LOOPS=${config.maxLoops}`);
      break;
    }

    await sleep(config.intervalMs);
  }
}

async function writeQuote(config: PriceWatcherConfig, quote: PriceQuote): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    market: quote.market,
    tradePrice: quote.tradePrice,
    exchangeTimestamp: quote.timestamp,
    source: quote.source,
  };

  await appendJsonLine(config.logPath, record);
  await mkdir(dirname(config.latestPath), { recursive: true });
  await writeFile(config.latestPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function appendJsonLine(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

function readNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number. Received: ${raw}`);
  }
  return value;
}

function readOptionalPositiveInt(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
