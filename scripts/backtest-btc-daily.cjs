const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");

const EXCHANGE = readExchange("BACKTEST_EXCHANGE", "BITHUMB");
const MARKET = process.env.BACKTEST_MARKET || "KRW-BTC";
const VALIDATION_DAYS = readNumber("BACKTEST_VALIDATION_DAYS", 365);
const WARMUP_DAYS = readNumber("BACKTEST_WARMUP_DAYS", 230);
const BACKTEST_FROM = process.env.BACKTEST_FROM || "";
const BACKTEST_TO = process.env.BACKTEST_TO || "";
const TOTAL_CAPITAL_KRW = readNumber("BACKTEST_TOTAL_CAPITAL_KRW", 10_000_000);
const GRID_RATIO = readNumber("BACKTEST_GRID_RATIO", 0.158);
const GRID_LEVELS = readNumber("BACKTEST_GRID_LEVELS", 20);
const GRID_GAP_PCT = readNumber("BACKTEST_GRID_GAP_PCT", 0.01);
const USE_GRID_TRADING = readBool("BACKTEST_USE_GRID_TRADING", true);
const FARMER_ENTRY_PCT = readNumber("BACKTEST_FARMER_ENTRY_PCT", 0.15);
const FARMER_MAX_STAGES = readNumber("BACKTEST_FARMER_MAX_STAGES", 3);
const FARMER_MAX_3D_DRAWDOWN_PCT = readNumber("BACKTEST_FARMER_MAX_3D_DRAWDOWN_PCT", -0.25);
const FARMER_VOLATILITY_N_MULTIPLIER = readNumber("BACKTEST_FARMER_VOLATILITY_N_MULTIPLIER", 2);
const FARMER_STAGE2_COOLDOWN_DAYS = readNumber("BACKTEST_FARMER_STAGE2_COOLDOWN_DAYS", 3);
const FARMER_STAGE3_COOLDOWN_DAYS = readNumber("BACKTEST_FARMER_STAGE3_COOLDOWN_DAYS", 5);
const TURTLE_N_PERIOD = readNumber("BACKTEST_TURTLE_N_PERIOD", 20);
const TURTLE_LOW_BREAKOUT_PERIOD = readNumber("BACKTEST_TURTLE_LOW_BREAKOUT_PERIOD", 20);
const TURTLE_N_MULTIPLIER = readNumber("BACKTEST_TURTLE_N_MULTIPLIER", 2);
const TAKE_PROFIT_1_RETURN_PCT = readNumber("BACKTEST_TP1_RETURN_PCT", 0.05);
const TAKE_PROFIT_1_SELL_RATIO = readNumber("BACKTEST_TP1_SELL_RATIO", 0.5);
const TAKE_PROFIT_2_RETURN_PCT = readNumber("BACKTEST_TP2_RETURN_PCT", 0.1);
const TAKE_PROFIT_2_SELL_RATIO = readNumber("BACKTEST_TP2_SELL_RATIO", 0.5);
const TRAILING_ACTIVATION_MODE = readTrailingActivationMode("BACKTEST_TRAILING_ACTIVATION_MODE", "TP1");
const OPEN_BELOW_MA5_ACTIVATION_MODE = readTrailingActivationMode("BACKTEST_OPEN_BELOW_MA5_ACTIVATION_MODE", "TP1");
const FEE_RATE = readNumber("BACKTEST_FEE_RATE", 0.0005);
const USE_PRICE_REACHED_FILTER = readBool("BACKTEST_USE_PRICE_REACHED_FILTER", true);
const USE_LONG_TREND_FILTER = readBool("BACKTEST_USE_LONG_TREND_FILTER", true);
const USE_TURNOVER_RATIO_FILTER = readBool("BACKTEST_USE_TURNOVER_RATIO_FILTER", true);
const USE_MA5_TREND_FILTER = readBool("BACKTEST_USE_MA5_TREND_FILTER", true);
const USE_CLOSE_POSITION_FILTER = readBool("BACKTEST_USE_CLOSE_POSITION_FILTER", true);
const USE_BULLISH_DAILY_FILTER = readBool("BACKTEST_USE_BULLISH_DAILY_FILTER", true);
const USE_TWO_BULLISH_DAILY_FILTER = readBool("BACKTEST_USE_TWO_BULLISH_DAILY_FILTER", true);
const USE_VOLATILITY_EXPLOSION_FILTER = readBool("BACKTEST_USE_VOLATILITY_EXPLOSION_FILTER", true);
const USE_TURTLE_2N_TRAIL_EXIT = readBool("BACKTEST_USE_TURTLE_2N_TRAIL_EXIT", true);
const USE_TURTLE_OPEN_BELOW_MA5_EXIT = readBool("BACKTEST_USE_TURTLE_OPEN_BELOW_MA5_EXIT", false);
const BACKTEST_DIR = resolve(process.cwd(), "data", "backtests");
const CANDLE_CACHE_DIR = resolve(BACKTEST_DIR, "candles");
const REPORT_DIR = resolve(BACKTEST_DIR, "reports");

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

async function main() {
  const requiredCandles = VALIDATION_DAYS + WARMUP_DAYS;
  const candles = await readOrFetchDayCandles(MARKET, requiredCandles);
  if (candles.length < requiredCandles) {
    throw new Error(`Not enough candles. Required ${requiredCandles}, received ${candles.length}.`);
  }

  const validationRange = resolveValidationRange(candles);
  const validationStartIndex = validationRange.startIndex;
  const validationEndIndex = validationRange.endIndex;
  const validationCandles = candles.slice(validationStartIndex, validationEndIndex + 1);
  const first = validationCandles[0];
  const last = validationCandles[validationCandles.length - 1];
  const result = runBacktest(candles.slice(0, validationEndIndex + 1), validationStartIndex);

  printReport(result, first, last);
  const artifacts = await writeBacktestArtifacts(result, first, last, candles);
  console.log(`Result JSON: ${artifacts.resultPath}`);
  console.log(`Dashboard HTML: ${artifacts.htmlPath}`);
}

function runBacktest(candles, validationStartIndex) {
  const baseFarmerCapitalKrw = Math.round(TOTAL_CAPITAL_KRW * GRID_RATIO);
  const events = [];
  let cycle = 1;
  let state = createBacktestCycle(candles[validationStartIndex].tradePrice, baseFarmerCapitalKrw, cycle);
  let recoverySell = null;
  const recoverySells = [];

  for (let index = validationStartIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    const history = candles.slice(0, index + 1);

    if (state.phase === "FARMING") {
      if (state.farmerStage === 0 && state.farmerPositions.length === 0 && candle.tradePrice > state.farmerLastBuyPrice) {
        state.farmerLastBuyPrice = candle.tradePrice;
        state.entryPrice = candle.tradePrice;
      }
      const nextFarmerEntry = state.farmerLastBuyPrice == null ? null : state.farmerLastBuyPrice * (1 - FARMER_ENTRY_PCT);
      const nextStage = state.farmerStage + 1;
      const priceTriggered = nextFarmerEntry != null && candle.lowPrice <= nextFarmerEntry;
      const priceFilterOk = !USE_PRICE_REACHED_FILTER || priceTriggered;
      const cooldownOk = isCooldownOk(nextStage, state.farmerLastBuyIndex, index);
      const filter = evaluateFarmerFilters(history);
      const farmerBuyPrice = priceTriggered && nextFarmerEntry != null ? nextFarmerEntry : candle.tradePrice;
      const sizing = calculateFarmerSizing(state, farmerBuyPrice);
      const canBuy =
        nextStage <= FARMER_MAX_STAGES &&
        priceFilterOk &&
        cooldownOk &&
        filter.ok &&
        sizing.orderKrw >= 5_000;

      if (priceTriggered || filter.blockedReasons.length > 0 || !priceFilterOk) {
        events.push({
          date: candle.candleDateTimeKst,
          type: "FARMER_SIGNAL",
          cycle: state.cycle,
          stage: nextStage,
          price: candle.tradePrice,
          nextFarmerEntry,
          blockedReasons: [
            ...(priceFilterOk ? [] : ["PRICE_NOT_REACHED"]),
            ...(cooldownOk ? [] : ["STAGE_COOLDOWN"]),
            ...filter.blockedReasons,
          ],
        });
      }

      if (canBuy) {
        state.farmerStage = nextStage;
        state.farmerLastBuyPrice = farmerBuyPrice;
        state.farmerLastBuyIndex = index;
        const qty = sizing.orderKrw / farmerBuyPrice;
        state.farmerPositions.push({
          stage: state.farmerStage,
          price: farmerBuyPrice,
          qty,
          costKrw: sizing.orderKrw,
          boughtAt: candle.candleDateTimeKst,
        });
        state.highestPrice = Math.max(state.highestPrice, farmerBuyPrice);
        events.push({
          date: candle.candleDateTimeKst,
          type: "FARMER_BUY",
          cycle: state.cycle,
          stage: state.farmerStage,
          price: farmerBuyPrice,
          amountKrw: sizing.orderKrw,
        });
      }
    }

    if ((state.phase === "FARMING" || state.phase === "HOLDING") && state.farmerPositions.length > 0) {
      state.highestPrice = Math.max(state.highestPrice || candle.tradePrice, candle.highPrice);
      let recovery = buildRecoveryPosition(state.gridLayers, state.farmerPositions, candle.tradePrice);
      let expected = calculateExpectedNetPnl(recovery.marketValueKrw, recovery.totalCostKrw);
      const tp1Triggered = !state.takeProfit1Done && expected.netPnlPct != null && expected.netPnlPct >= TAKE_PROFIT_1_RETURN_PCT * 100;
      const tp2Triggered = state.takeProfit1Done && !state.takeProfit2Done && expected.netPnlPct != null && expected.netPnlPct >= TAKE_PROFIT_2_RETURN_PCT * 100;

      if (tp1Triggered && expected.netPnlKrw > 0) {
        const takeProfitSell = sellRecoverySlice(state, TAKE_PROFIT_1_SELL_RATIO, candle.tradePrice, candle.candleDateTimeKst, "TAKE_PROFIT_1");
        state.takeProfit1Done = true;
        recoverySells.push(takeProfitSell);
        recoverySell = takeProfitSell;
        events.push({ type: "RECOVERY_SELL", ...takeProfitSell });
      }

      recovery = buildRecoveryPosition(state.gridLayers, state.farmerPositions, candle.tradePrice);
      expected = calculateExpectedNetPnl(recovery.marketValueKrw, recovery.totalCostKrw);
      const tp2TriggeredAfterTp1 = state.takeProfit1Done && !state.takeProfit2Done && expected.netPnlPct != null && expected.netPnlPct >= TAKE_PROFIT_2_RETURN_PCT * 100;

      if ((tp2Triggered || tp2TriggeredAfterTp1) && expected.netPnlKrw > 0) {
        const takeProfitSell = sellRecoverySlice(state, TAKE_PROFIT_2_SELL_RATIO, candle.tradePrice, candle.candleDateTimeKst, "TAKE_PROFIT_2");
        state.takeProfit2Done = true;
        recoverySells.push(takeProfitSell);
        recoverySell = takeProfitSell;
        events.push({ type: "RECOVERY_SELL", ...takeProfitSell });
      }

      recovery = buildRecoveryPosition(state.gridLayers, state.farmerPositions, candle.tradePrice);
      expected = calculateExpectedNetPnl(recovery.marketValueKrw, recovery.totalCostKrw);
      const turtle = evaluateTurtleExit(history, state.highestPrice);
      const trailingActive = isExitActivationActive(TRAILING_ACTIVATION_MODE, state, expected);
      const openBelowMa5Active = isExitActivationActive(OPEN_BELOW_MA5_ACTIVATION_MODE, state, expected);
      const reason = trailingActive && USE_TURTLE_2N_TRAIL_EXIT && turtle.trailingExit
        ? "2N_TRAIL"
        : openBelowMa5Active && USE_TURTLE_OPEN_BELOW_MA5_EXIT && turtle.openBelowYesterdayMa5
          ? "OPEN_BELOW_MA5"
          : null;
      if (reason != null && expected.netPnlKrw > 0 && recovery.totalQty > 0) {
        events.push({
          date: candle.candleDateTimeKst,
          type: "RECOVERY_EXIT_SIGNAL",
          cycle: state.cycle,
          reason,
          price: candle.tradePrice,
          expectedNetPnlKrw: expected.netPnlKrw,
          expectedNetPnlPct: expected.netPnlPct,
          profitGateOk: expected.netPnlKrw > 0,
        });
      }
      if (reason != null && expected.netPnlKrw > 0 && recovery.totalQty > 0) {
        recoverySell = sellRecoverySlice(state, 1, candle.tradePrice, candle.candleDateTimeKst, reason);
        recoverySells.push(recoverySell);
        events.push({ type: "RECOVERY_SELL", ...recoverySell });
        cycle += 1;
        state = createBacktestCycle(candle.tradePrice, baseFarmerCapitalKrw, cycle);
        events.push({
          date: candle.candleDateTimeKst,
          type: "START_FARMER_CYCLE",
          cycle: state.cycle,
          price: candle.tradePrice,
        });
      }
    }
  }

  const lastCandle = candles[candles.length - 1];
  const finalRecovery = buildRecoveryPosition(state.gridLayers, state.farmerPositions, lastCandle.tradePrice);
  const finalExpected = calculateExpectedNetPnl(finalRecovery.marketValueKrw, finalRecovery.totalCostKrw);
  return {
    entryPrice: candles[validationStartIndex].tradePrice,
    gridOrderAmountKrw: 0,
    baseFarmerCapitalKrw,
    currentBasePrice: state.farmerLastBuyPrice,
    gridLayers: state.gridLayers,
    farmerPositions: state.farmerPositions,
    recoverySell,
    recoverySells,
    cycles: cycle,
    validationDays: candles.length - validationStartIndex,
    finalRecovery,
    finalExpected,
    events,
  };
}

function createBacktestCycle(entryPrice, gridOrderAmountKrw, cycle) {
  return {
    cycle,
    entryPrice,
    phase: "FARMING",
    baseFarmerCapitalKrw: gridOrderAmountKrw,
    gridLayers: [],
    farmerPositions: [],
    farmerStage: 0,
    farmerLastBuyPrice: entryPrice,
    farmerLastBuyIndex: null,
    highestPrice: 0,
    takeProfit1Done: false,
    takeProfit2Done: false,
  };
}

function resolveValidationRange(candles) {
  if (BACKTEST_FROM || BACKTEST_TO) {
    const startDate = BACKTEST_FROM || candles[Math.max(0, candles.length - VALIDATION_DAYS)]?.candleDateTimeKst?.slice(0, 10);
    const endDate = BACKTEST_TO || candles[candles.length - 1]?.candleDateTimeKst?.slice(0, 10);
    const startIndex = candles.findIndex((candle) => candle.candleDateTimeKst.slice(0, 10) >= startDate);
    const endIndex = findLastIndex(candles, (candle) => candle.candleDateTimeKst.slice(0, 10) <= endDate);
    if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
      throw new Error(`Invalid backtest range. BACKTEST_FROM=${BACKTEST_FROM || "-"} BACKTEST_TO=${BACKTEST_TO || "-"}`);
    }
    if (startIndex < WARMUP_DAYS) {
      throw new Error(`Backtest range needs at least ${WARMUP_DAYS} warmup candles before ${startDate}.`);
    }
    return { startIndex, endIndex };
  }
  return {
    startIndex: candles.length - VALIDATION_DAYS,
    endIndex: candles.length - 1,
  };
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}

function evaluateFarmerFilters(candles) {
  if (candles.length < 220) {
    return { ok: false, blockedReasons: ["INSUFFICIENT_CANDLES"] };
  }
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const close3dAgo = candles[candles.length - 4]?.tradePrice;
  const ma5Today = average(candles.slice(-5).map((candle) => candle.tradePrice));
  const ma5Yesterday = average(candles.slice(-6, -1).map((candle) => candle.tradePrice));
  const ma200Today = average(candles.slice(-200).map((candle) => candle.tradePrice));
  const ma200Lookback = average(candles.slice(-220, -20).map((candle) => candle.tradePrice));
  const avg20Turnover = average(candles.slice(-20).map((candle) => candle.candleAccTradePrice));
  const avg5Turnover = average(candles.slice(-5).map((candle) => candle.candleAccTradePrice));
  const closePosition = calculateClosePosition(last);
  const drawdown3dPct = close3dAgo == null ? 0 : last.tradePrice / close3dAgo - 1;
  const trueRange = calculateTrueRange(last, previous.tradePrice);
  const nValue = calculateAverageTrueRange(candles.slice(-20));
  const blockedReasons = [];
  if (drawdown3dPct <= FARMER_MAX_3D_DRAWDOWN_PCT) blockedReasons.push("FREEFALL_3D_DRAWDOWN");
  if (USE_VOLATILITY_EXPLOSION_FILTER && trueRange > nValue * FARMER_VOLATILITY_N_MULTIPLIER) blockedReasons.push("VOLATILITY_EXPLOSION");
  if (USE_LONG_TREND_FILTER && ma200Today < ma200Lookback) blockedReasons.push("LONG_TREND_BLOCKED");
  if (USE_MA5_TREND_FILTER && (last.tradePrice <= ma5Today || ma5Today < ma5Yesterday)) blockedReasons.push("MA5_TREND_BLOCKED");
  if (USE_TURNOVER_RATIO_FILTER && (last.candleAccTradePrice < avg20Turnover * 1.5 || last.candleAccTradePrice < avg5Turnover * 1.2)) {
    blockedReasons.push("TURNOVER_RATIO_BLOCKED");
  }
  if (USE_CLOSE_POSITION_FILTER && closePosition < 0.6) blockedReasons.push("CLOSE_POSITION_BLOCKED");
  if (USE_BULLISH_DAILY_FILTER && last.tradePrice <= last.openingPrice) blockedReasons.push("BULLISH_DAILY_BLOCKED");
  if (USE_TWO_BULLISH_DAILY_FILTER && (last.tradePrice <= last.openingPrice || previous.tradePrice <= previous.openingPrice)) {
    blockedReasons.push("TWO_BULLISH_DAILY_BLOCKED");
  }
  if (last.candleAccTradePrice >= avg20Turnover * 3.5 && closePosition < 0.6) {
    blockedReasons.push("CAPITULATION_BLOCKED");
  }
  return { ok: blockedReasons.length === 0, blockedReasons };
}

function evaluateTurtleExit(candles, highestPrice) {
  const nValue = calculateWilderAtr(candles, TURTLE_N_PERIOD);
  const last = candles[candles.length - 1];
  const lastClose = last.tradePrice;
  const yesterdayMa5Candles = candles.slice(-6, -1);
  const yesterdayMa5 = yesterdayMa5Candles.length >= 5
    ? average(yesterdayMa5Candles.map((candle) => candle.tradePrice))
    : null;
  const trailingStopPrice = nValue == null ? null : highestPrice - nValue * TURTLE_N_MULTIPLIER;
  return {
    nValue,
    yesterdayMa5,
    trailingStopPrice,
    trailingExit: trailingStopPrice != null && lastClose < trailingStopPrice,
    openBelowYesterdayMa5: yesterdayMa5 != null && last.openingPrice < yesterdayMa5,
  };
}

function isExitActivationActive(mode, state, expected) {
  if (mode === "PROFIT_POSITIVE") return expected.netPnlKrw > 0;
  if (mode === "TP2") return state.takeProfit2Done;
  return state.takeProfit1Done;
}

function sellRecoverySlice(state, ratio, price, date, reason) {
  const boundedRatio = Math.max(0, Math.min(1, ratio));
  const recoveryBeforeSell = buildRecoveryPosition(state.gridLayers, state.farmerPositions, price);
  const soldMarketValueKrw = recoveryBeforeSell.marketValueKrw * boundedRatio;
  const soldCostKrw = recoveryBeforeSell.totalCostKrw * boundedRatio;
  const expected = calculateExpectedNetPnl(soldMarketValueKrw, soldCostKrw);

  for (const position of state.farmerPositions) {
    position.qty *= 1 - boundedRatio;
    position.costKrw *= 1 - boundedRatio;
  }
  state.farmerPositions = state.farmerPositions.filter((position) => position.qty * price >= 1);

  return {
    date,
    cycle: state.cycle,
    reason,
    price,
    sellRatio: boundedRatio,
    amountKrw: soldMarketValueKrw,
    expectedNetPnlKrw: expected.netPnlKrw,
    expectedNetPnlPct: expected.netPnlPct,
  };
}

function calculateFarmerSizing(state, price) {
  const recovery = buildRecoveryPosition(state.gridLayers, state.farmerPositions, price);
  const investedFarmerKrw = state.farmerPositions.reduce((sum, position) => sum + position.costKrw, 0);
  const targetOrderKrw = state.farmerPositions.length === 0
    ? state.baseFarmerCapitalKrw
    : recovery.marketValueKrw;
  const availableKrw = Math.max(0, TOTAL_CAPITAL_KRW - investedFarmerKrw);
  return { orderKrw: Math.round(Math.min(targetOrderKrw, availableKrw)) };
}

function buildRecoveryPosition(gridLayers, farmerPositions, lastPrice) {
  const gridCost = gridLayers
    .filter((layer) => layer.status === "OPEN" && layer.qty > 0)
    .reduce((sum, layer) => sum + layer.amountKrw, 0);
  const gridQty = gridLayers
    .filter((layer) => layer.status === "OPEN" && layer.qty > 0)
    .reduce((sum, layer) => sum + layer.qty, 0);
  const farmerCost = farmerPositions.reduce((sum, position) => sum + position.costKrw, 0);
  const farmerQty = farmerPositions.reduce((sum, position) => sum + position.qty, 0);
  const totalQty = gridQty + farmerQty;
  const totalCostKrw = gridCost + farmerCost;
  return {
    totalQty,
    totalCostKrw,
    marketValueKrw: totalQty * lastPrice,
  };
}

function calculateExpectedNetPnl(marketValueKrw, costKrw) {
  const sellFeeKrw = marketValueKrw * FEE_RATE;
  const buyFeeEstimateKrw = costKrw * FEE_RATE;
  const netPnlKrw = marketValueKrw - sellFeeKrw - buyFeeEstimateKrw - costKrw;
  return {
    netPnlKrw,
    netPnlPct: costKrw > 0 ? (netPnlKrw / costKrw) * 100 : null,
  };
}

function isCooldownOk(nextStage, farmerLastBuyIndex, currentIndex) {
  if (nextStage <= 1 || farmerLastBuyIndex == null) return true;
  const elapsedDays = currentIndex - farmerLastBuyIndex;
  const requiredDays = nextStage === 2 ? FARMER_STAGE2_COOLDOWN_DAYS : FARMER_STAGE3_COOLDOWN_DAYS;
  return elapsedDays >= requiredDays;
}

function getLastGridBuyPrice(gridLayers) {
  const lastLayer = [...gridLayers].sort((a, b) => b.idx - a.idx)[0];
  if (lastLayer == null) return null;
  return lastLayer.qty > 0 && lastLayer.amountKrw > 0 ? lastLayer.amountKrw / lastLayer.qty : lastLayer.buyPrice;
}

async function readOrFetchDayCandles(market, count) {
  await mkdir(CANDLE_CACHE_DIR, { recursive: true });
  const cachePrefix = `${EXCHANGE}_${market.replace(/[^A-Z0-9-]/gi, "_")}`;
  const allCachePath = resolve(CANDLE_CACHE_DIR, `${cachePrefix}_days_all.json`);
  const allCached = await readJsonFile(allCachePath);
  if (Array.isArray(allCached) && allCached.length >= count) {
    const sorted = allCached.sort((a, b) => a.candleDateTimeKst.localeCompare(b.candleDateTimeKst));
    return BACKTEST_FROM || BACKTEST_TO ? sorted : sorted.slice(-count);
  }
  const legacyBithumbAllCachePath = resolve(CANDLE_CACHE_DIR, `${market.replace(/[^A-Z0-9-]/gi, "_")}_days_all.json`);
  const legacyBithumbAllCached = EXCHANGE === "BITHUMB" ? await readJsonFile(legacyBithumbAllCachePath) : null;
  if (Array.isArray(legacyBithumbAllCached) && legacyBithumbAllCached.length >= count) {
    const sorted = legacyBithumbAllCached.sort((a, b) => a.candleDateTimeKst.localeCompare(b.candleDateTimeKst));
    await writeFile(allCachePath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
    return BACKTEST_FROM || BACKTEST_TO ? sorted : sorted.slice(-count);
  }
  const cachePath = resolve(CANDLE_CACHE_DIR, `${cachePrefix}_days_${count}.json`);
  const cached = await readJsonFile(cachePath);
  if (Array.isArray(cached) && cached.length >= count) {
    return cached
      .sort((a, b) => a.candleDateTimeKst.localeCompare(b.candleDateTimeKst))
      .slice(-count);
  }
  const candles = await fetchDayCandles(market, count);
  await writeFile(cachePath, `${JSON.stringify(candles, null, 2)}\n`, "utf8");
  return candles;
}

async function fetchDayCandles(market, count) {
  const pageSize = 200;
  const candlesByDate = new Map();
  let nextTo = null;
  while (candlesByDate.size < count) {
    const params = new URLSearchParams({ market, count: String(Math.min(pageSize, count)) });
    if (nextTo != null) params.set("to", nextTo);
    const url = `${getCandleApiBaseUrl(EXCHANGE)}/v1/candles/days?${params.toString()}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${EXCHANGE} day candles HTTP ${response.status} ${response.statusText}`);
    const json = await response.json();
    if (!Array.isArray(json) || json.length === 0) break;
    const page = json.map((item) => ({
      market: item.market || market,
      candleDateTimeKst: item.candle_date_time_kst,
      openingPrice: item.opening_price,
      highPrice: item.high_price,
      lowPrice: item.low_price,
      tradePrice: item.trade_price,
      candleAccTradePrice: item.candle_acc_trade_price,
      timestamp: new Date(item.timestamp || Date.now()).toISOString(),
    }));
    for (const candle of page) candlesByDate.set(candle.candleDateTimeKst, candle);
    const oldest = page.sort((a, b) => a.candleDateTimeKst.localeCompare(b.candleDateTimeKst))[0];
    if (oldest == null || oldest.candleDateTimeKst === nextTo) break;
    nextTo = oldest.candleDateTimeKst;
    await sleep(200);
  }
  return Array.from(candlesByDate.values())
    .sort((a, b) => a.candleDateTimeKst.localeCompare(b.candleDateTimeKst))
    .slice(-count);
}

async function writeBacktestArtifacts(result, first, last, candles) {
  await mkdir(REPORT_DIR, { recursive: true });
  const generatedKey = new Date().toISOString().replace(/[:.]/g, "-");
  const reportId = `${EXCHANGE}_${MARKET.replace(/[^A-Z0-9-]/gi, "_")}_${first.candleDateTimeKst.slice(0, 10)}_${last.candleDateTimeKst.slice(0, 10)}_${generatedKey}`;
  const resultPath = resolve(REPORT_DIR, `${reportId}.json`);
  const htmlPath = resolve(REPORT_DIR, `${reportId}.html`);
  const latestResultPath = resolve(REPORT_DIR, "latest.json");
  const latestHtmlPath = resolve(REPORT_DIR, "latest.html");
  const farmerSignals = result.events.filter((event) => event.type === "FARMER_SIGNAL");
  const farmerBuys = result.events.filter((event) => event.type === "FARMER_BUY");
  const recoverySignals = result.events.filter((event) => event.type === "RECOVERY_EXIT_SIGNAL");
  const recoverySells = result.events.filter((event) => event.type === "RECOVERY_SELL");
  const recoveryRealizedPnlKrw = sumEventPnl(recoverySells);
  const totalRealizedPnlKrw = recoveryRealizedPnlKrw;
  const payload = {
    generatedAt: new Date().toISOString(),
    exchange: EXCHANGE,
    market: MARKET,
    validation: {
      from: first.candleDateTimeKst,
      to: last.candleDateTimeKst,
      days: result.validationDays,
      warmupDays: WARMUP_DAYS,
    },
    settings: {
      totalCapitalKrw: TOTAL_CAPITAL_KRW,
      gridRatio: GRID_RATIO,
      gridLevels: GRID_LEVELS,
      gridGapPct: GRID_GAP_PCT,
      gridTrading: USE_GRID_TRADING,
      farmerEntryPct: FARMER_ENTRY_PCT,
      farmerMaxStages: FARMER_MAX_STAGES,
      farmerMax3dDrawdownPct: FARMER_MAX_3D_DRAWDOWN_PCT,
      farmerStage2CooldownDays: FARMER_STAGE2_COOLDOWN_DAYS,
      farmerStage3CooldownDays: FARMER_STAGE3_COOLDOWN_DAYS,
      turtleNPeriod: TURTLE_N_PERIOD,
      turtleLowBreakoutPeriod: TURTLE_LOW_BREAKOUT_PERIOD,
      turtleNMultiplier: TURTLE_N_MULTIPLIER,
      takeProfit1ReturnPct: TAKE_PROFIT_1_RETURN_PCT,
      takeProfit1SellRatio: TAKE_PROFIT_1_SELL_RATIO,
      takeProfit2ReturnPct: TAKE_PROFIT_2_RETURN_PCT,
      takeProfit2SellRatio: TAKE_PROFIT_2_SELL_RATIO,
      trailingActivationMode: TRAILING_ACTIVATION_MODE,
      openBelowMa5ActivationMode: OPEN_BELOW_MA5_ACTIVATION_MODE,
      feeRate: FEE_RATE,
      filterToggles: {
        priceReached: USE_PRICE_REACHED_FILTER,
        longTrend: USE_LONG_TREND_FILTER,
        turnoverRatio: USE_TURNOVER_RATIO_FILTER,
        ma5Trend: USE_MA5_TREND_FILTER,
        closePosition: USE_CLOSE_POSITION_FILTER,
        bullishDaily: USE_BULLISH_DAILY_FILTER,
        twoBullishDaily: USE_TWO_BULLISH_DAILY_FILTER,
        volatilityExplosion: USE_VOLATILITY_EXPLOSION_FILTER,
      },
      turtleExitToggles: {
        twoNTrail: USE_TURTLE_2N_TRAIL_EXIT,
        openBelowMa5: USE_TURTLE_OPEN_BELOW_MA5_EXIT,
      },
    },
    summary: {
      entryPrice: result.entryPrice,
      currentBasePrice: result.currentBasePrice,
      cycles: result.cycles,
      gridOrderAmountKrw: result.gridOrderAmountKrw,
      baseFarmerCapitalKrw: result.baseFarmerCapitalKrw,
      gridBuys: 0,
      gridSells: 0,
      farmingEntries: result.cycles,
      farmerSignals: farmerSignals.length,
      farmerBuys: farmerBuys.length,
      recoveryExitSignals: recoverySignals.length,
      recoverySell: result.recoverySell,
      recoverySells: result.recoverySells,
      gridRealizedPnlKrw: 0,
      recoveryRealizedPnlKrw,
      totalRealizedPnlKrw,
      totalPnlKrw: totalRealizedPnlKrw + result.finalExpected.netPnlKrw,
      finalRecovery: result.finalRecovery,
      finalExpected: result.finalExpected,
      farmerBlockedReasons: countBlockedReasons(farmerSignals),
    },
    events: result.events,
    candles,
  };
  const resultJson = `${JSON.stringify(payload, null, 2)}\n`;
  const html = renderKoreanBacktestHtml(payload);
  await writeFile(resultPath, resultJson, "utf8");
  await writeFile(htmlPath, html, "utf8");
  await writeFile(latestResultPath, resultJson, "utf8");
  await writeFile(latestHtmlPath, html, "utf8");
  return { resultPath, htmlPath };
}

function printReport(result, first, last) {
  const farmerSignals = result.events.filter((event) => event.type === "FARMER_SIGNAL");
  const farmerBuys = result.events.filter((event) => event.type === "FARMER_BUY");
  const recoverySignals = result.events.filter((event) => event.type === "RECOVERY_EXIT_SIGNAL");
  const farmingEntries = result.events.filter((event) => event.type === "ENTER_FARMING");
  const gridBuys = result.events.filter((event) => event.type === "GRID_BUY");
  const gridSells = result.events.filter((event) => event.type === "GRID_SELL");
  const recoverySells = result.events.filter((event) => event.type === "RECOVERY_SELL");
  const gridRealizedPnlKrw = sumEventPnl(gridSells);
  const recoveryRealizedPnlKrw = sumEventPnl(recoverySells);
  console.log("[BTC Daily Backtest]");
  console.log(`Exchange: ${EXCHANGE}`);
  console.log(`Market: ${MARKET}`);
  console.log(`Validation: ${first.candleDateTimeKst} ~ ${last.candleDateTimeKst} (${result.validationDays} days)`);
  console.log(`Entry Price: ${formatKrw(result.entryPrice)}`);
  console.log(`Farmer Cycles: ${result.cycles}`);
  console.log(`Stage 1 Base Capital: ${formatKrw(result.baseFarmerCapitalKrw)}`);
  console.log(`Farmer Signals: ${farmerSignals.length}`);
  const farmerBlockedReasonCounts = countBlockedReasons(farmerSignals);
  if (Object.keys(farmerBlockedReasonCounts).length > 0) {
    console.log("Farmer Blocked Reasons:");
    for (const [reason, count] of Object.entries(farmerBlockedReasonCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${reason}: ${count}`);
    }
  }
  console.log(`Farmer Buys: ${farmerBuys.length}`);
  for (const buy of farmerBuys) {
    console.log(`  - ${buy.date} stage ${buy.stage} ${formatKrw(buy.price)} amount ${formatKrw(buy.amountKrw)}`);
  }
  console.log(`Recovery Exit Signals: ${recoverySignals.length}`);
  if (result.recoverySell != null) {
    console.log(
      `Recovery Sell: ${result.recoverySell.date} ${result.recoverySell.reason} ${formatKrw(result.recoverySell.price)} net ${formatKrw(result.recoverySell.expectedNetPnlKrw)} (${formatPct(result.recoverySell.expectedNetPnlPct)})`,
    );
  } else {
    console.log("Recovery Sell: none");
  }
  console.log(`Recovery Sell Count: ${result.recoverySells.length}`);
  console.log(`Farmer+Turtle Realized PnL: ${formatKrw(recoveryRealizedPnlKrw)}`);
  console.log(`Total Realized PnL: ${formatKrw(recoveryRealizedPnlKrw)}`);
  console.log(
    `Final Recovery Position: cost ${formatKrw(result.finalRecovery.totalCostKrw)}, value ${formatKrw(result.finalRecovery.marketValueKrw)}, net ${formatKrw(result.finalExpected.netPnlKrw)} (${formatPct(result.finalExpected.netPnlPct)})`,
  );
}

function countBlockedReasons(events) {
  const counts = {};
  for (const event of events) {
    for (const reason of event.blockedReasons || []) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
  }
  return counts;
}

function sumEventPnl(events) {
  return events.reduce((sum, event) => sum + (Number(event.expectedNetPnlKrw) || 0), 0);
}

const REASON_LABELS_KO = {
  LONG_TREND_BLOCKED: "장기 추세 조건 미충족",
  TURNOVER_RATIO_BLOCKED: "거래대금 증가 조건 미충족",
  PRICE_NOT_REACHED: "농부 진입 가격 미도달",
  MA5_TREND_BLOCKED: "MA5 단기 추세 조건 미충족",
  CLOSE_POSITION_BLOCKED: "종가 위치 조건 미충족",
  BULLISH_DAILY_BLOCKED: "일봉 양봉 조건 미충족",
  TWO_BULLISH_DAILY_BLOCKED: "2일 연속 양봉 조건 미충족",
  VOLATILITY_EXPLOSION: "변동성 폭발 구간",
  FREEFALL_3D_DRAWDOWN: "최근 3일 급락 구간",
  CAPITULATION_BLOCKED: "투매성 거래 회피",
  INSUFFICIENT_CANDLES: "지표 계산용 일봉 부족",
  "2N_TRAIL": "2N 트레일링 이탈",
  TRAILING_2N: "2N 트레일링 이탈",
  TAKE_PROFIT_1: "1차 부분 익절",
  TAKE_PROFIT_2: "2차 부분 익절",
  OPEN_BELOW_MA5: "당일 시가 MA5 하회",
  MA5_EXIT: "MA5 이탈",
  N_DAY_LOW_BREAK: "N일 최저가 이탈",
};

function formatReasonKo(reason) {
  if (reason == null || reason === "") return "-";
  return REASON_LABELS_KO[reason] || reason;
}

function formatReasonsKo(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return "-";
  return reasons.map((reason) => formatReasonKo(reason)).join(", ");
}

function formatTrailingActivationModeKo(mode) {
  if (mode === "PROFIT_POSITIVE") return "수익률 양수부터";
  if (mode === "TP2") return "2차 익절 수익률 이상부터";
  return "1차 익절 수익률 이상부터";
}

function buildPositiveRealizedPnlTrend(recoverySells) {
  const byDate = new Map();
  for (const sell of recoverySells) {
    const pnl = Number(sell.expectedNetPnlKrw) || 0;
    if (pnl <= 0) continue;
    const date = String(sell.date || "").slice(0, 10);
    if (!date) continue;
    byDate.set(date, (byDate.get(date) || 0) + pnl);
  }

  let cumulativePnlKrw = 0;
  return Array.from(byDate.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, realizedPnlKrw]) => {
      cumulativePnlKrw += realizedPnlKrw;
      return { date, realizedPnlKrw, cumulativePnlKrw };
    });
}

function renderRealizedPnlTrendChart(points) {
  if (points.length === 0) {
    return `<div class="label">Realized PNL Trend</div><div class="value">-</div><div class="muted">수익이 확정된 실제 터틀 매도 내역이 없습니다.</div>`;
  }

  const width = Math.max(760, points.length * 82);
  const height = 320;
  const left = 72;
  const right = 24;
  const top = 24;
  const bottom = 82;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const maxValue = Math.max(...points.map((point) => Math.max(point.realizedPnlKrw, point.cumulativePnlKrw)), 1);
  const xStep = points.length > 1 ? chartWidth / (points.length - 1) : 0;
  const barWidth = Math.min(42, Math.max(16, chartWidth / Math.max(points.length, 1) * 0.48));
  const y = (value) => top + chartHeight - (value / maxValue) * chartHeight;
  const x = (index) => points.length > 1 ? left + xStep * index : left + chartWidth / 2;
  const barRects = points.map((point, index) => {
    const barX = x(index) - barWidth / 2;
    const barY = y(point.realizedPnlKrw);
    const barHeight = top + chartHeight - barY;
    const attrs = trendPointAttrs(point);
    return `<rect class="trend-point" ${attrs} x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3" fill="#9fd8b2"><title>${escapeHtml(point.date)} ${escapeHtml(formatKrw(point.realizedPnlKrw))}</title></rect>`;
  }).join("");
  const linePoints = points.map((point, index) => `${x(index).toFixed(1)},${y(point.cumulativePnlKrw).toFixed(1)}`).join(" ");
  const dotCircles = points.map((point, index) => `<circle class="trend-point" ${trendPointAttrs(point)} cx="${x(index).toFixed(1)}" cy="${y(point.cumulativePnlKrw).toFixed(1)}" r="4" fill="#2563eb"><title>${escapeHtml(point.date)} 누적 ${escapeHtml(formatKrw(point.cumulativePnlKrw))}</title></circle>`).join("");
  const xLabels = points.map((point, index) => `<text x="${x(index).toFixed(1)}" y="${height - 42}" text-anchor="end" transform="rotate(-45 ${x(index).toFixed(1)} ${height - 42})" font-size="11" fill="#52657a">${escapeHtml(point.date.slice(5))}</text>`).join("");
  const yLabels = [0, 0.5, 1].map((ratio) => {
    const value = maxValue * ratio;
    const yPos = y(value);
    return `<g><line x1="${left}" x2="${width - right}" y1="${yPos.toFixed(1)}" y2="${yPos.toFixed(1)}" stroke="#e5ebf2"/><text x="${left - 10}" y="${(yPos + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#52657a">${escapeHtml(formatCompactKrw(value))}</text></g>`;
  }).join("");
  const total = points[points.length - 1].cumulativePnlKrw;

  return `
    <div class="label">Realized PNL Trend</div>
    <div class="value">${escapeHtml(formatKrw(total))}</div>
    <div class="muted">수익이 난 실제 터틀 매도일만 x축에 표시합니다.</div>
    <div class="legend"><span class="bar">일별 확정 손익</span><span class="line">누적 확정 손익</span></div>
    <div class="trend-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Realized PNL Trend">
        ${yLabels}
        <line x1="${left}" x2="${width - right}" y1="${top + chartHeight}" y2="${top + chartHeight}" stroke="#cad5e2"/>
        <line x1="${left}" x2="${left}" y1="${top}" y2="${top + chartHeight}" stroke="#cad5e2"/>
        ${barRects}
        <polyline points="${linePoints}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
        ${dotCircles}
        ${xLabels}
      </svg>
    </div>`;
}

function trendPointAttrs(point) {
  return [
    'data-trend-point="true"',
    `data-date="${escapeHtml(point.date)}"`,
    `data-realized="${escapeHtml(formatKrw(point.realizedPnlKrw))}"`,
    `data-cumulative="${escapeHtml(formatKrw(point.cumulativePnlKrw))}"`,
    'tabindex="0"',
  ].join(" ");
}

function formatCompactKrw(value) {
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}억`;
  if (abs >= 10_000) return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만`;
  return Math.round(value).toLocaleString("ko-KR");
}

function renderKoreanBacktestHtml(payload) {
  const summary = payload.summary;
  const events = payload.events;
  const farmerBuys = events.filter((event) => event.type === "FARMER_BUY");
  const recoverySignals = events.filter((event) => event.type === "RECOVERY_EXIT_SIGNAL");
  const recoverySells = events.filter((event) => event.type === "RECOVERY_SELL");
  const recentEvents = events.slice(-80);
  const blockedRows = Object.entries(summary.farmerBlockedReasons)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `<tr><td>${escapeHtml(formatReasonKo(reason))}</td><td>${count}</td></tr>`)
    .join("");
  const farmerBuyRows = farmerBuys
    .map((buy) => `<tr><td>${escapeHtml(buy.date)}</td><td>${buy.stage}</td><td>${formatKrw(buy.price)}</td><td>${formatKrw(buy.amountKrw)}</td></tr>`)
    .join("");
  const recoveryRows = recoverySignals
    .map((signal) => `<tr><td>${escapeHtml(signal.date)}</td><td>${escapeHtml(formatReasonKo(signal.reason))}</td><td>${formatKrw(signal.price)}</td><td>${formatKrw(signal.expectedNetPnlKrw)} (${formatPct(signal.expectedNetPnlPct)})</td><td>${signal.profitGateOk ? "통과" : "차단"}</td></tr>`)
    .join("");
  const recoverySellRows = recoverySells
    .map((sell) => `<tr><td>${escapeHtml(sell.date)}</td><td>${sell.cycle ?? "-"}</td><td>${escapeHtml(formatReasonKo(sell.reason))}</td><td>${formatKrw(sell.price)}</td><td>${formatKrw(sell.expectedNetPnlKrw)} (${formatPct(sell.expectedNetPnlPct)})</td></tr>`)
    .join("");
  const realizedPnlTrend = buildPositiveRealizedPnlTrend(recoverySells);
  const realizedPnlTrendChart = renderRealizedPnlTrendChart(realizedPnlTrend);
  const eventRows = recentEvents
    .map((event) => `<tr><td>${escapeHtml(event.date || "-")}</td><td><span class="badge">${escapeHtml(event.type)}</span></td><td>${event.stage ?? "-"}</td><td>${formatKrwOptional(event.price)}</td><td>${formatKrwOptional(event.amountKrw)}</td><td>${escapeHtml(event.reason ? formatReasonKo(event.reason) : formatReasonsKo(event.blockedReasons))}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BTC 일봉 백테스트</title>
  <style>
    :root { color-scheme: light; --line:#d8e0ea; --text:#1f2933; --muted:#52657a; --panel:#fff; --bg:#f4f7fa; --ok:#e8f6ed; --bad:#fdecec; }
    body { margin:0; font-family: Arial, "Noto Sans KR", sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1280px; margin:0 auto; padding:24px; }
    h1 { margin:0 0 4px; font-size:24px; }
    h2 { margin:28px 0 12px; font-size:16px; color:var(--muted); }
    .meta { color:var(--muted); margin-bottom:18px; }
    .grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; min-height:84px; }
    .label { color:var(--muted); font-size:13px; margin-bottom:10px; }
    .value { font-size:24px; font-weight:700; overflow-wrap:anywhere; }
    .muted { color:var(--muted); font-size:13px; margin-top:6px; }
    .profit { background:var(--ok); border-color:#9fd8b2; }
    .loss { background:var(--bad); border-color:#efb4b4; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; font-size:13px; vertical-align:top; }
    th { color:var(--muted); background:#f8fafc; }
    .badge { display:inline-block; padding:3px 7px; border-radius:999px; background:#eef3f8; font-size:12px; }
    .range-form { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; align-items:end; }
    .field label { display:block; color:var(--muted); font-size:13px; margin-bottom:6px; }
    .field input, .field select { width:100%; height:38px; box-sizing:border-box; border:1px solid var(--line); border-radius:6px; padding:0 10px; font-size:14px; background:#fff; }
    .check-field { min-height:38px; display:flex; align-items:center; gap:8px; border:1px solid var(--line); border-radius:6px; background:#fff; padding:0 10px; }
    .check-field input { width:16px; height:16px; }
    .check-field span { font-size:13px; font-weight:700; color:var(--text); }
    .settings-section { grid-column:1 / -1; margin-top:6px; padding-top:10px; border-top:1px solid var(--line); }
    .settings-section h3 { margin:0 0 10px; font-size:14px; color:var(--muted); }
    .form-actions { grid-column:1 / -1; display:flex; gap:10px; align-items:center; justify-content:flex-end; margin-top:8px; }
    .run-button { height:40px; border:0; border-radius:6px; background:#18202a; color:#fff; padding:0 18px; font-weight:700; cursor:pointer; }
    .trend-card { min-height:320px; }
    .trend-chart { width:100%; overflow-x:auto; }
    .trend-chart svg { display:block; min-width:720px; width:100%; height:auto; }
    .trend-point { cursor:pointer; outline:none; transition:opacity .12s ease, stroke-width .12s ease; }
    .trend-point:hover, .trend-point:focus { opacity:.82; stroke:#18202a; stroke-width:2; }
    .trend-tooltip { position:fixed; z-index:30; pointer-events:none; opacity:0; transform:translate(14px, 14px); background:#18202a; color:#fff; border-radius:6px; padding:10px 12px; box-shadow:0 10px 24px rgba(15,23,42,.18); font-size:13px; line-height:1.55; min-width:190px; transition:opacity .08s ease; }
    .trend-tooltip strong { display:block; font-size:13px; margin-bottom:4px; }
    .trend-tooltip .tooltip-muted { color:#cbd5e1; }
    .legend { display:flex; gap:16px; align-items:center; color:var(--muted); font-size:13px; margin:8px 0 0; }
    .legend span::before { content:""; display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
    .legend .bar::before { background:#9fd8b2; }
    .legend .line::before { background:#2563eb; }
    @media (max-width:900px) { .grid, .range-form { grid-template-columns:1fr; } main { padding:14px; } }
  </style>
</head>
<body>
  <main>
    <div style="text-align:right;margin-bottom:12px;"><a href="http://localhost:3000/" style="display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:6px;background:#18202a;color:#fff;text-decoration:none;font-weight:700;">운영 대시보드로 이동</a></div>
    <h1>BTC 일봉 백테스트</h1>
    <div class="meta">${escapeHtml(payload.exchange)} · ${escapeHtml(payload.market)} · ${escapeHtml(payload.validation.from)} ~ ${escapeHtml(payload.validation.to)} · 생성 ${escapeHtml(payload.generatedAt)}</div>

    <section class="panel">
      <h2 style="margin-top:0;">기간 설정</h2>
      <div class="range-form">
        <div class="settings-section"><h3>기본 백테스트 설정</h3></div>
        <div class="field"><label for="backtest-from">시작일</label><input id="backtest-from" type="date" value="${escapeHtml(payload.validation.from.slice(0, 10))}"></div>
        <div class="field"><label for="backtest-to">종료일</label><input id="backtest-to" type="date" value="${escapeHtml(payload.validation.to.slice(0, 10))}"></div>
        <div class="field"><label for="backtest-exchange">거래소</label><select id="backtest-exchange" data-env="BACKTEST_EXCHANGE"><option value="BITHUMB" ${payload.exchange === "BITHUMB" ? "selected" : ""}>Bithumb</option><option value="UPBIT" ${payload.exchange === "UPBIT" ? "selected" : ""}>Upbit</option></select></div>
        <div class="field"><label for="warmup-days">워밍업 일수</label><input id="warmup-days" type="number" min="230" step="1" value="${payload.validation.warmupDays}"></div>
        <div class="field"><label for="total-capital">총 운용 자금(KRW)</label><input id="total-capital" data-env="BACKTEST_TOTAL_CAPITAL_KRW" type="number" min="0" step="10000" value="${payload.settings.totalCapitalKrw}"></div>
        <div class="field"><label for="grid-ratio">1차 기준 투자금 비율(%)</label><input id="grid-ratio" data-env="BACKTEST_GRID_RATIO" data-scale="percent" type="number" min="0" max="100" step="0.1" value="${(payload.settings.gridRatio * 100).toFixed(2)}"></div>
        <div class="field"><label for="farmer-entry">농부 진입 하락률(%)</label><input id="farmer-entry" data-env="BACKTEST_FARMER_ENTRY_PCT" data-scale="percent" type="number" min="0" max="100" step="0.1" value="${(payload.settings.farmerEntryPct * 100).toFixed(2)}"></div>
        <div class="field"><label for="farmer-max-stages">농부 최대 매수 차수</label><input id="farmer-max-stages" data-env="BACKTEST_FARMER_MAX_STAGES" type="number" min="1" max="20" step="1" value="${payload.settings.farmerMaxStages}"></div>
        <div class="field"><label for="farmer-drawdown">3일 급락 제한(%)</label><input id="farmer-drawdown" data-env="BACKTEST_FARMER_MAX_3D_DRAWDOWN_PCT" data-scale="negative-percent" type="number" min="0" max="100" step="0.1" value="${Math.abs(payload.settings.farmerMax3dDrawdownPct * 100).toFixed(2)}"></div>
        <div class="field"><label for="farmer-stage2-cooldown">2차 쿨다운(일)</label><input id="farmer-stage2-cooldown" data-env="BACKTEST_FARMER_STAGE2_COOLDOWN_DAYS" type="number" min="0" step="1" value="${payload.settings.farmerStage2CooldownDays}"></div>
        <div class="field"><label for="farmer-stage3-cooldown">3차 쿨다운(일)</label><input id="farmer-stage3-cooldown" data-env="BACKTEST_FARMER_STAGE3_COOLDOWN_DAYS" type="number" min="0" step="1" value="${payload.settings.farmerStage3CooldownDays}"></div>
        <div class="field"><label for="turtle-n">터틀 N 기간(일)</label><input id="turtle-n" data-env="BACKTEST_TURTLE_N_PERIOD" type="number" min="1" step="1" value="${payload.settings.turtleNPeriod}"></div>
        <div class="field"><label for="turtle-multiplier">트레일링 N 배수</label><input id="turtle-multiplier" data-env="BACKTEST_TURTLE_N_MULTIPLIER" type="number" min="0.1" step="0.1" value="${payload.settings.turtleNMultiplier}"></div>
        <div class="field"><label for="tp1-return">1차 익절 수익률(%)</label><input id="tp1-return" data-env="BACKTEST_TP1_RETURN_PCT" data-scale="percent" type="number" min="0" max="1000" step="0.1" value="${(payload.settings.takeProfit1ReturnPct * 100).toFixed(2)}"></div>
        <div class="field"><label for="tp1-ratio">1차 익절 매도 비율(%)</label><input id="tp1-ratio" data-env="BACKTEST_TP1_SELL_RATIO" data-scale="percent" type="number" min="0" max="100" step="1" value="${(payload.settings.takeProfit1SellRatio * 100).toFixed(0)}"></div>
        <div class="field"><label for="tp2-return">2차 익절 수익률(%)</label><input id="tp2-return" data-env="BACKTEST_TP2_RETURN_PCT" data-scale="percent" type="number" min="0" max="1000" step="0.1" value="${(payload.settings.takeProfit2ReturnPct * 100).toFixed(2)}"></div>
        <div class="field"><label for="tp2-ratio">2차 익절 매도 비율(%)</label><input id="tp2-ratio" data-env="BACKTEST_TP2_SELL_RATIO" data-scale="percent" type="number" min="0" max="100" step="1" value="${(payload.settings.takeProfit2SellRatio * 100).toFixed(0)}"></div>
        <div class="settings-section"><h3>농부 매수 조건</h3></div>
        <div class="field"><label>농부 진입 가격 미도달</label><label class="check-field"><input data-env="BACKTEST_USE_PRICE_REACHED_FILTER" type="checkbox" ${payload.settings.filterToggles.priceReached ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="field"><label>장기 추세 조건 미충족</label><label class="check-field"><input data-env="BACKTEST_USE_LONG_TREND_FILTER" type="checkbox" ${payload.settings.filterToggles.longTrend ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="field"><label>거래대금 증가 조건 미충족</label><label class="check-field"><input data-env="BACKTEST_USE_TURNOVER_RATIO_FILTER" type="checkbox" ${payload.settings.filterToggles.turnoverRatio ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="field"><label>MA5 단기 추세 조건 미충족</label><label class="check-field"><input data-env="BACKTEST_USE_MA5_TREND_FILTER" type="checkbox" ${payload.settings.filterToggles.ma5Trend ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="field"><label>종가 위치 조건 미충족</label><label class="check-field"><input data-env="BACKTEST_USE_CLOSE_POSITION_FILTER" type="checkbox" ${payload.settings.filterToggles.closePosition ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="field"><label>일봉 양봉 조건 미충족</label><label class="check-field"><input data-env="BACKTEST_USE_BULLISH_DAILY_FILTER" type="checkbox" ${payload.settings.filterToggles.bullishDaily ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="field"><label>2일 연속 양봉 조건 미충족</label><label class="check-field"><input data-env="BACKTEST_USE_TWO_BULLISH_DAILY_FILTER" type="checkbox" ${payload.settings.filterToggles.twoBullishDaily ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="field"><label>변동성 폭발 구간</label><label class="check-field"><input data-env="BACKTEST_USE_VOLATILITY_EXPLOSION_FILTER" type="checkbox" ${payload.settings.filterToggles.volatilityExplosion ? "checked" : ""}><span>매수 필터 적용</span></label></div>
        <div class="settings-section"><h3>터틀 매도 조건</h3></div>
        <div class="field"><label>2N 트레일링 이탈</label><label class="check-field"><input data-env="BACKTEST_USE_TURTLE_2N_TRAIL_EXIT" type="checkbox" ${payload.settings.turtleExitToggles.twoNTrail ? "checked" : ""}><span>매도 조건 사용</span></label></div>
        <div class="field"><label for="trailing-activation">2N 트레일링 시작 조건</label><select id="trailing-activation" data-env="BACKTEST_TRAILING_ACTIVATION_MODE"><option value="PROFIT_POSITIVE" ${payload.settings.trailingActivationMode === "PROFIT_POSITIVE" ? "selected" : ""}>수익률이 양수일 때</option><option value="TP1" ${payload.settings.trailingActivationMode === "TP1" ? "selected" : ""}>1차 익절 수익률(T1%) 이상</option><option value="TP2" ${payload.settings.trailingActivationMode === "TP2" ? "selected" : ""}>2차 익절 수익률(T2%) 이상</option></select></div>
        <div class="field"><label>당일 시가가 전일 MA5 하회</label><label class="check-field"><input data-env="BACKTEST_USE_TURTLE_OPEN_BELOW_MA5_EXIT" type="checkbox" ${payload.settings.turtleExitToggles.openBelowMa5 ? "checked" : ""}><span>매도 조건 사용</span></label></div>
        <div class="field"><label for="open-below-ma5-activation">MA5 하회 매도 시작 조건</label><select id="open-below-ma5-activation" data-env="BACKTEST_OPEN_BELOW_MA5_ACTIVATION_MODE"><option value="PROFIT_POSITIVE" ${payload.settings.openBelowMa5ActivationMode === "PROFIT_POSITIVE" ? "selected" : ""}>수익률이 양수일 때</option><option value="TP1" ${payload.settings.openBelowMa5ActivationMode === "TP1" ? "selected" : ""}>1차 익절 수익률(T1%) 이상</option><option value="TP2" ${payload.settings.openBelowMa5ActivationMode === "TP2" ? "selected" : ""}>2차 익절 수익률(T2%) 이상</option></select></div>
        <div class="form-actions"><button id="run-backtest" class="run-button" type="button">실행</button></div>
      </div>
    </section>

    <section class="grid">
      ${metric("거래소", payload.exchange)}
      ${metric("시작 기준가", formatKrw(summary.entryPrice))}
      ${metric("농부 사이클", `${summary.cycles}회`, `터틀 매도 ${summary.recoverySells.length}회`)}
      ${metric("1차 기준 투자금", formatKrw(summary.baseFarmerCapitalKrw), "총 운용 자금 × 기준 비율")}
      ${metric("농부/터틀 확정 손익", formatKrw(summary.recoveryRealizedPnlKrw), "매도 완료된 농부/터틀 손익", summary.recoveryRealizedPnlKrw >= 0 ? "profit" : "loss")}
      ${metric("전체 확정 손익", formatKrw(summary.totalRealizedPnlKrw), "현재는 농부/터틀 기준", summary.totalRealizedPnlKrw >= 0 ? "profit" : "loss")}
      ${metric("최종 총 손익", formatKrw(summary.totalPnlKrw), "확정 손익 + 미실현 예상 손익", summary.totalPnlKrw >= 0 ? "profit" : "loss")}
      ${metric("현재 기준가", formatKrw(summary.currentBasePrice), "1차 전 최고 종가 / 이후 직전 농부 매수가")}
      ${metric("농부 매수", String(summary.farmerBuys), `신호 ${summary.farmerSignals}회`)}
      ${metric("회복 매도", summary.recoverySell ? formatReasonKo(summary.recoverySell.reason) : "없음")}
      ${metric("최종 투입금", formatKrw(summary.finalRecovery.totalCostKrw))}
      ${metric("최종 평가금", formatKrw(summary.finalRecovery.marketValueKrw))}
      ${metric("미실현 예상 손익", formatKrw(summary.finalExpected.netPnlKrw), formatPct(summary.finalExpected.netPnlPct), summary.finalExpected.netPnlKrw >= 0 ? "profit" : "loss")}
      ${metric("터틀 매도 신호", String(summary.recoveryExitSignals))}
    </section>

    <h2>실제 터틀 매도 실현손익 추세</h2>
    <section class="panel trend-card">
      ${realizedPnlTrendChart}
      <div id="realized-pnl-tooltip" class="trend-tooltip" aria-hidden="true"></div>
    </section>

    <h2>전략 설정</h2>
    <section class="grid">
      ${metric("농부 진입 하락률", `${(payload.settings.farmerEntryPct * 100).toFixed(2)}%`)}
      ${metric("농부 최대 매수 차수", `${payload.settings.farmerMaxStages}차`)}
      ${metric("3일 누적 하락 제한", `${(payload.settings.farmerMax3dDrawdownPct * 100).toFixed(2)}%`)}
      ${metric("농부 쿨다운", `${payload.settings.farmerStage2CooldownDays}일 / ${payload.settings.farmerStage3CooldownDays}일`, "2차 / 3차")}
      ${metric("2N 트레일링 설정", `N ${payload.settings.turtleNPeriod}`, `${formatTrailingActivationModeKo(payload.settings.trailingActivationMode)} · ${payload.settings.turtleNMultiplier}N`)}
      ${metric("MA5 하회 매도 설정", formatTrailingActivationModeKo(payload.settings.openBelowMa5ActivationMode), "당일 시가 < 전일 MA5")}
      ${metric("부분 익절 1차", `${(payload.settings.takeProfit1ReturnPct * 100).toFixed(2)}%`, `${(payload.settings.takeProfit1SellRatio * 100).toFixed(0)}% 매도`)}
      ${metric("부분 익절 2차", `${(payload.settings.takeProfit2ReturnPct * 100).toFixed(2)}%`, `남은 물량의 ${(payload.settings.takeProfit2SellRatio * 100).toFixed(0)}% 매도`)}
    </section>

    <h2>농부 매수 차단 사유</h2>
    <table><thead><tr><th>사유</th><th>횟수</th></tr></thead><tbody>${blockedRows || '<tr><td colspan="2">차단 사유가 없습니다.</td></tr>'}</tbody></table>

    <h2>농부 매수 내역</h2>
    <table><thead><tr><th>날짜</th><th>차수</th><th>가격</th><th>금액</th></tr></thead><tbody>${farmerBuyRows || '<tr><td colspan="4">농부 매수가 없습니다.</td></tr>'}</tbody></table>

    <h2>실제 터틀 매도 내역</h2>
    <table><thead><tr><th>날짜</th><th>사이클</th><th>사유</th><th>가격</th><th>순손익</th></tr></thead><tbody>${recoverySellRows || '<tr><td colspan="5">실제 터틀 매도가 없습니다.</td></tr>'}</tbody></table>

    <h2>최근 이벤트</h2>
    <table><thead><tr><th>날짜</th><th>종류</th><th>차수</th><th>가격</th><th>금액</th><th>사유</th></tr></thead><tbody>${eventRows || '<tr><td colspan="6">이벤트가 없습니다.</td></tr>'}</tbody></table>

    <script>
      const fromInput = document.getElementById("backtest-from");
      const toInput = document.getElementById("backtest-to");
      const warmupInput = document.getElementById("warmup-days");
      const settingInputs = Array.from(document.querySelectorAll("[data-env]"));
      const runButton = document.getElementById("run-backtest");
      const trendTooltip = document.getElementById("realized-pnl-tooltip");
      const scrollStorageKey = "btcBacktestScrollY";
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      const savedScrollY = Number(sessionStorage.getItem(scrollStorageKey) || "NaN");
      if (Number.isFinite(savedScrollY)) {
        sessionStorage.removeItem(scrollStorageKey);
        restoreScrollY(savedScrollY);
      }
      function restoreScrollY(scrollY) {
        const targetY = Math.max(0, scrollY);
        const restore = () => window.scrollTo({ top: targetY, left: 0, behavior: "auto" });
        restore();
        requestAnimationFrame(() => {
          restore();
          requestAnimationFrame(restore);
        });
        window.setTimeout(restore, 80);
        window.setTimeout(restore, 240);
      }
      function buildBacktestParams() {
        const params = new URLSearchParams();
        params.set("BACKTEST_FROM", fromInput.value);
        params.set("BACKTEST_TO", toInput.value);
        params.set("BACKTEST_WARMUP_DAYS", warmupInput.value || "230");
        for (const input of settingInputs) {
          const scale = input.dataset.scale;
          let value = input.type === "checkbox" ? (input.checked ? "true" : "false") : input.value || "0";
          if (scale === "percent") value = String(Number(value) / 100);
          if (scale === "negative-percent") value = String(-Math.abs(Number(value) / 100));
          params.set(input.dataset.env, value);
        }
        return params;
      }
      runButton.addEventListener("click", () => {
        const scrollY = window.scrollY;
        sessionStorage.setItem(scrollStorageKey, String(scrollY));
        runButton.disabled = true;
        runButton.textContent = "실행 중...";
        window.location.assign("/backtests/run?" + buildBacktestParams().toString());
      });
      function moveTrendTooltip(event) {
        if (!trendTooltip) return;
        let left = event.clientX + 16;
        let top = event.clientY + 16;
        trendTooltip.style.left = left + "px";
        trendTooltip.style.top = top + "px";
        const rect = trendTooltip.getBoundingClientRect();
        if (rect.right > window.innerWidth - 12) left = event.clientX - rect.width - 16;
        if (rect.bottom > window.innerHeight - 12) top = event.clientY - rect.height - 16;
        trendTooltip.style.left = Math.max(12, left) + "px";
        trendTooltip.style.top = Math.max(12, top) + "px";
      }
      function showTrendTooltip(event) {
        if (!trendTooltip) return;
        const point = event.currentTarget;
        trendTooltip.innerHTML =
          "<strong>" + point.dataset.date + "</strong>" +
          "<div>일별 확정 손익: " + point.dataset.realized + "</div>" +
          "<div class=\\"tooltip-muted\\">누적 확정 손익: " + point.dataset.cumulative + "</div>";
        trendTooltip.style.opacity = "1";
        trendTooltip.setAttribute("aria-hidden", "false");
        if ("clientX" in event) moveTrendTooltip(event);
      }
      function hideTrendTooltip() {
        if (!trendTooltip) return;
        trendTooltip.style.opacity = "0";
        trendTooltip.setAttribute("aria-hidden", "true");
      }
      for (const point of document.querySelectorAll("[data-trend-point]")) {
        point.addEventListener("mouseenter", showTrendTooltip);
        point.addEventListener("mousemove", moveTrendTooltip);
        point.addEventListener("mouseleave", hideTrendTooltip);
        point.addEventListener("focus", showTrendTooltip);
        point.addEventListener("blur", hideTrendTooltip);
      }
    </script>
  </main>
</body>
</html>`;
}

function renderBacktestHtml(payload) {
  const summary = payload.summary;
  const events = payload.events;
  const farmerBuys = events.filter((event) => event.type === "FARMER_BUY");
  const recoverySignals = events.filter((event) => event.type === "RECOVERY_EXIT_SIGNAL");
  const recentEvents = events.slice(-80);
  const blockedRows = Object.entries(summary.farmerBlockedReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `<tr><td>${escapeHtml(formatReasonKo(reason))}</td><td>${count}</td></tr>`)
    .join("");
  const eventRows = recentEvents
    .map((event) => `
      <tr>
        <td>${escapeHtml(event.date || "-")}</td>
        <td><span class="badge">${escapeHtml(event.type)}</span></td>
        <td>${event.stage ?? "-"}</td>
        <td>${formatKrwOptional(event.price)}</td>
        <td>${formatKrwOptional(event.amountKrw)}</td>
        <td>${escapeHtml(event.reason ? formatReasonKo(event.reason) : formatReasonsKo(event.blockedReasons))}</td>
      </tr>`)
    .join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BTC Daily Backtest</title>
  <style>
    :root { color-scheme: light; --line:#d8e0ea; --text:#1f2933; --muted:#52657a; --panel:#fff; --bg:#f4f7fa; --ok:#e8f6ed; --bad:#fdecec; }
    body { margin:0; font-family: Arial, "Noto Sans KR", sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1280px; margin:0 auto; padding:24px; }
    h1 { margin:0 0 4px; font-size:24px; }
    h2 { margin:28px 0 12px; font-size:16px; text-transform:uppercase; color:var(--muted); letter-spacing:.04em; }
    .meta { color:var(--muted); margin-bottom:18px; }
    .grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; min-height:84px; }
    .label { color:var(--muted); font-size:13px; margin-bottom:10px; }
    .value { font-size:24px; font-weight:700; overflow-wrap:anywhere; }
    .muted { color:var(--muted); font-size:13px; margin-top:6px; }
    .profit { background:var(--ok); border-color:#9fd8b2; }
    .loss { background:var(--bad); border-color:#efb4b4; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; font-size:13px; vertical-align:top; }
    th { color:var(--muted); background:#f8fafc; }
    .badge { display:inline-block; padding:3px 7px; border-radius:999px; background:#eef3f8; font-size:12px; }
    .two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media (max-width:900px) { .grid, .two { grid-template-columns:1fr; } main { padding:14px; } }
  </style>
</head>
<body>
  <main>
    <h1>BTC Daily Backtest</h1>
    <div class="meta">${escapeHtml(payload.market)} · ${escapeHtml(payload.validation.from)} ~ ${escapeHtml(payload.validation.to)} · generated ${escapeHtml(payload.generatedAt)}</div>

    <section class="grid">
      ${metric("Entry Price", formatKrw(summary.entryPrice))}
      ${metric("Grid Buys", `${summary.gridBuys} / ${payload.settings.gridLevels}`, `${formatKrw(summary.gridOrderAmountKrw)} per level`)}
      ${metric("Farmer Buys", String(summary.farmerBuys), `${summary.farmerSignals} signals`)}
      ${metric("Recovery Sell", summary.recoverySell ? formatReasonKo(summary.recoverySell.reason) : "None")}
      ${metric("Final Cost", formatKrw(summary.finalRecovery.totalCostKrw))}
      ${metric("Final Value", formatKrw(summary.finalRecovery.marketValueKrw))}
      ${metric("Final Net PnL", formatKrw(summary.finalExpected.netPnlKrw), formatPct(summary.finalExpected.netPnlPct), summary.finalExpected.netPnlKrw >= 0 ? "profit" : "loss")}
      ${metric("Exit Signals", String(summary.recoveryExitSignals))}
    </section>

    <h2>Settings</h2>
    <section class="grid">
      ${metric("Farmer Entry", `${(payload.settings.farmerEntryPct * 100).toFixed(2)}%`)}
      ${metric("Farmer Max 3D Drawdown", `${(payload.settings.farmerMax3dDrawdownPct * 100).toFixed(2)}%`)}
      ${metric("Cooldown", `${payload.settings.farmerStage2CooldownDays}D / ${payload.settings.farmerStage3CooldownDays}D`, "Stage 2 / Stage 3")}
      ${metric("Turtle", `N ${payload.settings.turtleNPeriod}`, `Low ${payload.settings.turtleLowBreakoutPeriod}D · ${payload.settings.turtleNMultiplier}N`)}
    </section>

    <h2>Farmer Blocked Reasons</h2>
    <table>
      <thead><tr><th>Reason</th><th>Count</th></tr></thead>
      <tbody>${blockedRows || '<tr><td colspan="2">No blocked reasons.</td></tr>'}</tbody>
    </table>

    <h2>Farmer Buys</h2>
    <table>
      <thead><tr><th>Date</th><th>Stage</th><th>Price</th><th>Amount</th></tr></thead>
      <tbody>${farmerBuys.map((buy) => `<tr><td>${escapeHtml(buy.date)}</td><td>${buy.stage}</td><td>${formatKrw(buy.price)}</td><td>${formatKrw(buy.amountKrw)}</td></tr>`).join("") || '<tr><td colspan="4">No farmer buys.</td></tr>'}</tbody>
    </table>

    <h2>Recovery Exit Signals</h2>
    <table>
      <thead><tr><th>Date</th><th>Reason</th><th>Price</th><th>Expected Net PnL</th><th>Gate</th></tr></thead>
      <tbody>${recoverySignals.map((signal) => `<tr><td>${escapeHtml(signal.date)}</td><td>${escapeHtml(formatReasonKo(signal.reason))}</td><td>${formatKrw(signal.price)}</td><td>${formatKrw(signal.expectedNetPnlKrw)} (${formatPct(signal.expectedNetPnlPct)})</td><td>${signal.profitGateOk ? "PASS" : "BLOCKED"}</td></tr>`).join("") || '<tr><td colspan="5">No recovery exit signals.</td></tr>'}</tbody>
    </table>

    <h2>Recent Events</h2>
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Stage</th><th>Price</th><th>Amount</th><th>Reason</th></tr></thead>
      <tbody>${eventRows || '<tr><td colspan="6">No events.</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function metric(label, value, muted = "", tone = "") {
  return `<div class="panel ${tone}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div>${muted ? `<div class="muted">${escapeHtml(muted)}</div>` : ""}</div>`;
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatKrwOptional(value) {
  return typeof value === "number" && Number.isFinite(value) ? formatKrw(value) : "-";
}

function calculateClosePosition(candle) {
  const range = candle.highPrice - candle.lowPrice;
  return range > 0 ? (candle.tradePrice - candle.lowPrice) / range : 0;
}

function calculateAverageTrueRange(candles) {
  let previousClose = candles[0]?.tradePrice || 0;
  const ranges = [];
  for (const candle of candles.slice(1)) {
    ranges.push(calculateTrueRange(candle, previousClose));
    previousClose = candle.tradePrice;
  }
  return ranges.length > 0 ? average(ranges) : 0;
}

function calculateWilderAtr(candles, period) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let index = 1; index < candles.length; index += 1) {
    trueRanges.push(calculateTrueRange(candles[index], candles[index - 1].tradePrice));
  }
  if (trueRanges.length < period) return null;
  let atr = average(trueRanges.slice(0, period));
  for (const trueRange of trueRanges.slice(period)) {
    atr = (atr * (period - 1) + trueRange) / period;
  }
  return atr;
}

function calculateTrueRange(candle, previousClose) {
  return Math.max(
    candle.highPrice - candle.lowPrice,
    Math.abs(candle.highPrice - previousClose),
    Math.abs(candle.lowPrice - previousClose),
  );
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function readNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric. Received: ${raw}`);
  return value;
}

function readBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
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

function readTrailingActivationMode(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = String(raw).toUpperCase();
  if (value === "PROFIT_POSITIVE" || value === "TP1" || value === "TP2") return value;
  throw new Error(`${name} must be PROFIT_POSITIVE, TP1, or TP2. Received: ${raw}`);
}

function formatKrw(value) {
  return `${Math.round(value).toLocaleString("ko-KR")} KRW`;
}

function formatPct(value) {
  return value == null ? "-" : `${value.toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
