import { randomUUID } from "node:crypto";
import { buildDefaultGridLevelSettings, normalizeGridLevelSetting, roundKrw, shouldBuyLayer } from "../../../../packages/shared/src";
import type {
  BotState,
  GridDecisionSummary,
  GridLayer,
  OrderExecutor,
  TradeLogRecord,
} from "../../../../packages/shared/src/types";
import type { GridBotConfig } from "../config";
import type { JsonlTradeLogger } from "../storage/logger";
import { filterConfirmedDayCandles, type BithumbPublicClient, type PriceQuote } from "../bithumb/bithumb-client";
import { calculateTurtleDailyIndicators } from "../turtle/turtle-indicators";
import { buildGrid } from "./grid-levels";
import { canBuyGrid, canSellGrid } from "./grid-state-machine";

export class GridEngine {
  constructor(
    private readonly config: GridBotConfig,
    private readonly publicClient: BithumbPublicClient,
    private readonly executor: OrderExecutor,
    private readonly logger: JsonlTradeLogger,
  ) {}

  async tick(
    state: BotState,
    quote: PriceQuote,
    controls?: { enableGridBuy?: boolean; enableGridSell?: boolean },
  ): Promise<{ state: BotState; summary: GridDecisionSummary }> {
    let nextState = await this.ensureGridInitialized(state, quote);
    const summary: GridDecisionSummary = {
      initialized: nextState !== state,
      buys: 0,
      sells: 0,
      phaseChanged: false,
    };

    nextState = {
      ...nextState,
      lastPrice: quote.tradePrice,
      lastLoopAt: new Date().toISOString(),
      lastError: null,
    };

    if (canSellGrid(nextState.phase) && (controls?.enableGridSell ?? this.config.enableGridSell)) {
      const sellResult = await this.processSells(nextState, quote);
      nextState = sellResult.state;
      summary.sells = sellResult.count;
    }

    if (
      canBuyGrid(nextState.phase) &&
      !hasOpenGridPosition(nextState) &&
      shouldRefreshGridFirstBuyBeforeBuy(nextState)
    ) {
      nextState = await this.reanchorGridBeforeFirstBuy(nextState, quote);
    }

    if (canBuyGrid(nextState.phase) && (controls?.enableGridBuy ?? this.config.enableGridBuy)) {
      const buyResult = await this.processBuys(nextState, quote);
      nextState = buyResult.state;
      summary.buys = buyResult.count;
    }

    if (summary.buys === 0 && canBuyGrid(nextState.phase) && !hasOpenGridPosition(nextState)) {
      nextState = await this.reanchorGridBeforeFirstBuy(nextState, quote);
    }

    return { state: nextState, summary };
  }

  async resetOpenGridPositions(state: BotState, quote: PriceQuote): Promise<{ state: BotState; count: number }> {
    let nextState: BotState = {
      ...state,
      lastPrice: quote.tradePrice,
      lastLoopAt: new Date().toISOString(),
      lastError: null,
    };
    let count = 0;

    for (const layer of nextState.layers) {
      if (layer.status !== "OPEN" || layer.qty <= 0) continue;

      const requestId = randomUUID();
      const execution = await this.executor.sellMarket({
        market: nextState.market,
        price: quote.tradePrice,
        qty: layer.qty,
        requestId,
      });
      const realizedPnlKrw = roundKrw(execution.amountKrw - execution.feeKrw - layer.amountKrw);
      const realizedPnlPct = layer.amountKrw > 0 ? (realizedPnlKrw / layer.amountKrw) * 100 : null;

      nextState = {
        ...nextState,
        gridEntryReferencePrice: null,
        layers: nextState.layers.map((item) =>
          item.idx === layer.idx
            ? {
                ...item,
                qty: 0,
                status: "SOLD",
                trailingActive: false,
                trailingHighPrice: null,
                sellCount: item.sellCount + 1,
                soldAt: execution.executedAt,
                sellOrderId: execution.orderId,
              }
            : item,
        ),
      };
      count += 1;

      await this.appendLog(nextState, {
        action: "GRID_SELL",
        layerType: "GRID",
        stage: layer.idx,
        price: execution.price,
        qty: execution.qty,
        amountKrw: execution.amountKrw,
        feeKrw: execution.feeKrw,
        realizedPnlKrw,
        realizedPnlPct,
        orderId: execution.orderId,
        requestId: execution.requestId,
        reason: "GRID_RESET",
      });
    }

    return {
      state: {
        ...nextState,
        gridResetRequestedAt: null,
        gridResetCompletedAt: new Date().toISOString(),
        gridResetLastError: null,
      },
      count,
    };
  }

  private async ensureGridInitialized(state: BotState, quote: PriceQuote): Promise<BotState> {
    if (state.gridEntryPrice != null && state.layers.length > 0) {
      return state;
    }

    const entryPlan = state.phase === "GRID"
      ? await this.resolveGridFirstBuyPlan(state, quote)
      : null;
    const entryPrice = entryPlan?.entryPrice ?? quote.tradePrice;
    const levels = this.config.gridLevels;
    const gapPct = this.config.gridGapPct;
    const gridLevelSettings =
      state.gridLevelSettings ?? buildDefaultGridLevelSettings(levels, gapPct);
    const grid = buildGrid({
      entryPrice,
      totalCapitalKrw: state.totalCapitalKrw || this.config.totalCapitalKrw,
      gridRatio: this.config.gridRatio,
      levels,
      gapPct,
      levelSettings: gridLevelSettings,
    });

    return {
      ...state,
      phase: "GRID",
      gridEntryPrice: entryPrice,
      gridEntryReferencePrice: entryPlan?.referencePrice ?? state.gridEntryReferencePrice ?? null,
      gridEntryNValue: entryPlan?.nValue ?? state.gridEntryNValue ?? null,
      gridEntryNCalculatedForKstDate: entryPlan?.calculatedForKstDate ?? state.gridEntryNCalculatedForKstDate ?? null,
      gridInvestmentKrw: grid.layers.reduce((sum, layer) => sum + layer.amountKrw, 0),
      gridOrderAmountKrw: grid.sizing.orderAmountKrw,
      gridLevelSettings,
      layers: grid.layers,
      highestPrice: entryPrice,
    };
  }

  private async reanchorGridBeforeFirstBuy(state: BotState, quote: PriceQuote): Promise<BotState> {
    if (state.phase !== "GRID" || state.gridEntryPrice == null || state.layers.length === 0) {
      return state;
    }
    if (hasOpenGridPosition(state)) {
      return state;
    }

    const entryPlan = await this.resolveGridFirstBuyPlan(state, quote);
    if (entryPlan == null) return state;
    const entryPrice = entryPlan.entryPrice;
    const currentFirstLayer = state.layers.find((layer) => layer.idx === 1);
    if (currentFirstLayer != null && currentFirstLayer.buyPrice === entryPlan.firstBuyPrice) {
      return {
        ...state,
        gridEntryReferencePrice: entryPlan.referencePrice,
        gridEntryNValue: entryPlan.nValue,
        gridEntryNCalculatedForKstDate: entryPlan.calculatedForKstDate,
      };
    }

    const gapPct = this.inferGridGapPct(state) ?? this.config.gridGapPct;
    const orderAmountKrw = state.gridOrderAmountKrw || state.layers[0]?.amountKrw || 0;
    const grid = buildGrid({
      entryPrice,
      totalCapitalKrw: state.totalCapitalKrw || this.config.totalCapitalKrw,
      gridRatio: this.config.gridRatio,
      levels: state.layers.length || this.config.gridLevels,
      gapPct,
      levelSettings: state.gridLevelSettings,
    });
    const layers = grid.layers.map((layer) => {
      const existing = state.layers.find((item) => item.idx === layer.idx);
      const multiplier = layer.buyAmountMultiplier ?? 1;
      return {
        ...layer,
        amountKrw: orderAmountKrw > 0 ? roundKrw(orderAmountKrw * multiplier) : layer.amountKrw,
        buyCount: existing?.buyCount ?? layer.buyCount,
        sellCount: existing?.sellCount ?? layer.sellCount,
      };
    });

    console.log(
      `[grid-bot] reanchored grid first buy ${currentFirstLayer?.buyPrice ?? "-"} -> ${entryPlan.firstBuyPrice} reference=${entryPlan.referencePrice} n=${entryPlan.nValue} levels=${layers.length} orderAmountKrw=${layers[0]?.amountKrw ?? grid.sizing.orderAmountKrw}`,
    );

    return {
      ...state,
      gridEntryPrice: entryPrice,
      gridEntryReferencePrice: entryPlan.referencePrice,
      gridEntryNValue: entryPlan.nValue,
      gridEntryNCalculatedForKstDate: entryPlan.calculatedForKstDate,
      gridInvestmentKrw: layers.reduce((sum, layer) => sum + layer.amountKrw, 0),
      gridOrderAmountKrw: orderAmountKrw > 0 ? orderAmountKrw : grid.sizing.orderAmountKrw,
      gridLevelSettings: state.gridLevelSettings ?? buildDefaultGridLevelSettings(layers.length, gapPct),
      layers,
      highestPrice: Math.max(state.highestPrice, entryPrice),
    };
  }

  private inferGridGapPct(state: BotState): number | null {
    const firstLayer = state.layers.find((layer) => layer.idx === 1);
    if (state.gridEntryPrice == null || firstLayer == null) {
      return null;
    }
    const gapPct = (state.gridEntryPrice - firstLayer.buyPrice) / state.gridEntryPrice;
    return Number.isFinite(gapPct) && gapPct > 0 ? gapPct : null;
  }

  private async resolveGridFirstBuyPlan(
    state: BotState,
    quote: PriceQuote,
  ): Promise<{
    entryPrice: number;
    firstBuyPrice: number;
    referencePrice: number;
    nValue: number;
    calculatedForKstDate: string;
  } | null> {
    const nState = await this.refreshGridEntryNIfNeeded(state);
    const nValue = nState.gridEntryNValue;
    if (nValue == null || !Number.isFinite(nValue) || nValue <= 0) {
      return null;
    }

    const referencePrice =
      nState.gridEntryReferencePrice != null && nState.gridEntryReferencePrice > 0
        ? nState.gridEntryReferencePrice
        : quote.tradePrice;
    const firstBuyPrice = roundKrw(Math.max(1, referencePrice - nValue * 0.5));
    const gapPct = this.inferGridGapPct(nState) ?? this.config.gridGapPct;
    const levelSettings =
      nState.gridLevelSettings ?? buildDefaultGridLevelSettings(nState.layers.length || this.config.gridLevels, gapPct);
    const firstLevelSetting = normalizeGridLevelSetting(levelSettings.find((setting) => setting.level === 1), 1, gapPct);
    const entryPrice = firstBuyPrice / (1 - firstLevelSetting.buyGapPct);
    return {
      entryPrice,
      firstBuyPrice,
      referencePrice,
      nValue,
      calculatedForKstDate: nState.gridEntryNCalculatedForKstDate ?? currentKstDateKey(),
    };
  }

  private async refreshGridEntryNIfNeeded(state: BotState): Promise<BotState> {
    const todayKst = currentKstDateKey();
    if (state.gridEntryNValue != null && state.gridEntryNCalculatedForKstDate === todayKst) {
      return state;
    }

    const candles = filterConfirmedDayCandles(
      await this.publicClient.getDayCandles(
        state.market,
        Math.max(30, this.config.recoveryTurtleNPeriod + 10),
      ),
    );
    const indicators = calculateTurtleDailyIndicators(candles, this.config.recoveryTurtleNPeriod);
    return {
      ...state,
      gridEntryNValue: indicators.nValue,
      gridEntryNCalculatedForKstDate: todayKst,
      nValue: indicators.nValue ?? state.nValue,
    };
  }

  private async processBuys(state: BotState, quote: PriceQuote): Promise<{ state: BotState; count: number }> {
    let nextState = state;
    let count = 0;

    for (const layer of nextState.layers) {
      if (!shouldBuyLayer(quote.tradePrice, layer)) continue;

      const requestId = randomUUID();
      const execution = await this.executor.buyMarket({
        market: nextState.market,
        price: quote.tradePrice,
        amountKrw: layer.amountKrw,
        requestId,
      });

      nextState = {
        ...nextState,
        gridEntryReferencePrice: null,
        layers: nextState.layers.map((item) =>
          item.idx === layer.idx
            ? {
                ...item,
                qty: execution.qty,
                status: "OPEN",
                trailingActive: false,
                trailingHighPrice: null,
                buyCount: item.buyCount + 1,
                boughtAt: execution.executedAt,
                buyOrderId: execution.orderId,
              }
            : item,
        ),
      };
      count += 1;

      await this.appendLog(nextState, {
        action: "GRID_BUY",
        layerType: "GRID",
        stage: layer.idx,
        price: execution.price,
        qty: execution.qty,
        amountKrw: execution.amountKrw,
        feeKrw: execution.feeKrw,
        orderId: execution.orderId,
        requestId: execution.requestId,
        reason: quote.source,
      });
    }

    return { state: nextState, count };
  }

  private async processSells(state: BotState, quote: PriceQuote): Promise<{ state: BotState; count: number }> {
    let nextState = state;
    let count = 0;

    for (const layer of nextState.layers) {
      if (layer.status !== "OPEN" || layer.qty <= 0) continue;
      const sellDecision = evaluateGridSell(layer, quote.tradePrice);
      if (sellDecision.layer !== layer) {
        nextState = {
          ...nextState,
          layers: nextState.layers.map((item) => (item.idx === layer.idx ? sellDecision.layer : item)),
        };
      }
      if (!sellDecision.shouldSell) continue;

      const requestId = randomUUID();
      const execution = await this.executor.sellMarket({
        market: nextState.market,
        price: quote.tradePrice,
        qty: layer.qty,
        requestId,
      });
      const realizedPnlKrw = roundKrw(execution.amountKrw - execution.feeKrw - layer.amountKrw);
      const realizedPnlPct = layer.amountKrw > 0 ? (realizedPnlKrw / layer.amountKrw) * 100 : null;

      nextState = {
        ...nextState,
        layers: nextState.layers.map((item) =>
          item.idx === layer.idx
            ? {
                ...item,
                qty: 0,
                status: "SOLD",
                trailingActive: false,
                trailingHighPrice: null,
                sellCount: item.sellCount + 1,
                soldAt: execution.executedAt,
                sellOrderId: execution.orderId,
              }
            : item,
        ),
        gridEntryReferencePrice: null,
      };
      count += 1;

      await this.appendLog(nextState, {
        action: "GRID_SELL",
        layerType: "GRID",
        stage: layer.idx,
        price: execution.price,
        qty: execution.qty,
        amountKrw: execution.amountKrw,
        feeKrw: execution.feeKrw,
        realizedPnlKrw,
        realizedPnlPct,
        orderId: execution.orderId,
        requestId: execution.requestId,
        reason: quote.source,
      });
    }

    return { state: nextState, count };
  }

  private async appendLog(
    state: BotState,
    record: Omit<TradeLogRecord, "id" | "timestamp" | "botId" | "market" | "cycleId">,
  ): Promise<void> {
    await this.logger.append({
      timestamp: new Date().toISOString(),
      botId: state.botId,
      market: state.market,
      cycleId: state.cycleId,
      ...record,
    });
  }
}

function hasOpenGridPosition(state: BotState): boolean {
  return state.layers.some((layer) => layer.status === "OPEN" || layer.qty > 0);
}

function shouldRefreshGridFirstBuyBeforeBuy(state: BotState): boolean {
  return state.gridEntryReferencePrice == null || state.gridEntryNCalculatedForKstDate !== currentKstDateKey();
}

function currentKstDateKey(value = new Date()): string {
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

function evaluateGridSell(layer: GridLayer, currentPrice: number): { layer: GridLayer; shouldSell: boolean } {
  const pullbackPct = layer.trailingPullbackPct ?? 0;
  if (pullbackPct <= 0) {
    return { layer, shouldSell: currentPrice >= layer.sellPrice };
  }

  const trailingActive = layer.trailingActive === true || currentPrice >= layer.sellPrice;
  if (!trailingActive) {
    return { layer, shouldSell: false };
  }

  const trailingHighPrice = Math.max(layer.trailingHighPrice ?? layer.sellPrice, currentPrice);
  const nextLayer = {
    ...layer,
    trailingActive: true,
    trailingHighPrice,
  };
  const stopPrice = roundKrw(trailingHighPrice * (1 - pullbackPct));
  return {
    layer: nextLayer,
    shouldSell: currentPrice <= stopPrice,
  };
}
