const { mkdir, writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");

const EXCHANGE = readExchange("CANDLE_EXCHANGE", "BITHUMB");
const MARKET = process.env.CANDLE_MARKET || "KRW-BTC";
const PAGE_SIZE = readNumber("CANDLE_PAGE_SIZE", 200);
const MAX_PAGES = readNumber("CANDLE_MAX_PAGES", 200);
const PAUSE_MS = readNumber("CANDLE_FETCH_PAUSE_MS", 200);
const OUT_DIR = resolve(process.cwd(), "data", "backtests", "candles");

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const candlesByDate = new Map();
  let nextTo = null;
  let pageIndex = 0;

  while (pageIndex < MAX_PAGES) {
    pageIndex += 1;
    const page = await fetchDayCandlePage(MARKET, PAGE_SIZE, nextTo);
    if (page.length === 0) break;

    let added = 0;
    for (const candle of page) {
      if (!candlesByDate.has(candle.candleDateTimeKst)) added += 1;
      candlesByDate.set(candle.candleDateTimeKst, candle);
    }

    const sortedPage = [...page].sort((left, right) => left.candleDateTimeKst.localeCompare(right.candleDateTimeKst));
    const oldest = sortedPage[0];
    const newest = sortedPage[sortedPage.length - 1];
    console.log(
      `page=${pageIndex} size=${page.length} added=${added} oldest=${oldest?.candleDateTimeKst ?? "-"} newest=${newest?.candleDateTimeKst ?? "-"} total=${candlesByDate.size}`,
    );

    if (oldest == null || oldest.candleDateTimeKst === nextTo || added === 0) break;
    nextTo = oldest.candleDateTimeKst;
    await sleep(PAUSE_MS);
  }

  const candles = Array.from(candlesByDate.values()).sort((left, right) =>
    left.candleDateTimeKst.localeCompare(right.candleDateTimeKst),
  );
  if (candles.length === 0) {
    throw new Error("No candles fetched.");
  }

  const safeMarket = `${EXCHANGE}_${MARKET.replace(/[^A-Z0-9-]/gi, "_")}`;
  const allPath = resolve(OUT_DIR, `${safeMarket}_days_all.json`);
  const countPath = resolve(OUT_DIR, `${safeMarket}_days_${candles.length}.json`);
  await writeFile(allPath, `${JSON.stringify(candles, null, 2)}\n`, "utf8");
  await writeFile(countPath, `${JSON.stringify(candles, null, 2)}\n`, "utf8");

  console.log("[Daily Candle Fetch Complete]");
  console.log(`Exchange: ${EXCHANGE}`);
  console.log(`Market: ${MARKET}`);
  console.log(`Candles: ${candles.length}`);
  console.log(`Range: ${candles[0].candleDateTimeKst} ~ ${candles[candles.length - 1].candleDateTimeKst}`);
  console.log(`Saved: ${allPath}`);
  console.log(`Saved: ${countPath}`);
}

async function fetchDayCandlePage(market, count, to) {
  const params = new URLSearchParams({ market, count: String(count) });
  if (to != null) params.set("to", to);
  const url = `${getCandleApiBaseUrl(EXCHANGE)}/v1/candles/days?${params.toString()}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${EXCHANGE} day candles HTTP ${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  if (!Array.isArray(json)) {
    throw new Error("Bithumb day candles response is not an array.");
  }
  return json
    .map((item) => ({
      market: item.market || market,
      candleDateTimeKst: item.candle_date_time_kst,
      openingPrice: item.opening_price,
      highPrice: item.high_price,
      lowPrice: item.low_price,
      tradePrice: item.trade_price,
      candleAccTradePrice: item.candle_acc_trade_price,
      timestamp: new Date(item.timestamp || Date.now()).toISOString(),
    }))
    .filter((candle) => typeof candle.candleDateTimeKst === "string" && Number.isFinite(candle.tradePrice));
}

function readNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive numeric. Received: ${raw}`);
  }
  return value;
}

function readExchange(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = String(raw).toUpperCase();
  if (value === "BITHUMB" || value === "UPBIT") return value;
  throw new Error(`${name} must be BITHUMB or UPBIT. Received: ${raw}`);
}

function getCandleApiBaseUrl(exchange) {
  if (exchange === "UPBIT") return "https://api.upbit.com";
  return "https://api.bithumb.com";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
