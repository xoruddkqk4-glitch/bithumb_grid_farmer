import { randomUUID } from "node:crypto";
import { roundKrw, shouldBuyLayer, shouldSellLayer } from "../../../../packages/shared/src";
import type {
  BotState,
  GridDecisionSummary,
  OrderExecutor,
  TradeLogRecord,
} from "../../../../packages/shared/src/types";
import type { GridBotConfig } from "../config";
import type { JsonlTradeLogger } from "../storage/logger";
import type { PriceQuote } from "../bithumb/bithumb-client";
import { buildGrid } from "./grid-levels";
import { canBuyGrid, canSellGrid } from "./grid-state-machine";

export class GridEngine {
  constructor(
    private readonly config: GridBotConfig,
    private readonly executor: OrderExecutor,
    private readonly logger: JsonlTradeLogger,
  ) {}

  async tick(
    state: BotState,
    quote: PriceQuote,
    controls?: { enableGridBuy?: boolean; enableGridSell?: boolean },
  ): Promise<{ state: BotState; summary: GridDecisionSummary }> {
    let nextState = this.reanchorGridBeforeFirstBuy(this.ensureGridInitialized(state, quote.tradePrice), quote.tradePrice);
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

    if (canBuyGrid(nextState.phase) && (controls?.enableGridBuy ?? this.config.enableGridBuy)) {
      const buyResult = await this.processBuys(nextState, quote);
      nextState = buyResult.state;
      summary.buys = buyResult.count;
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
        layers: nextState.layers.map((item) =>
          item.idx === layer.idx
            ? {
                ...item,
                qty: 0,
                status: "SOLD",
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

  private ensureGridInitialized(state: BotState, entryPrice: number): BotState {
    if (state.gridEntryPrice != null && state.layers.length > 0) {
      return state;
    }

    const grid = buildGrid({
      entryPrice,
      totalCapitalKrw: state.totalCapitalKrw || this.config.totalCapitalKrw,
      gridRatio: this.config.gridRatio,
      levels: this.config.gridLevels,
      gapPct: this.config.gridGapPct,
    });

    return {
      ...state,
      phase: "GRID",
      gridEntryPrice: entryPrice,
      gridInvestmentKrw: grid.sizing.gridInvestmentKrw,
      gridOrderAmountKrw: grid.sizing.orderAmountKrw,
      layers: grid.layers,
      highestPrice: entryPrice,
    };
  }

  private reanchorGridBeforeFirstBuy(state: BotState, entryPrice: number): BotState {
    if (state.phase !== "GRID" || state.gridEntryPrice == null || state.layers.length === 0) {
      return state;
    }
    if (entryPrice <= state.gridEntryPrice) {
      return state;
    }
    if (state.layers.some((layer) => layer.status === "OPEN" || layer.qty > 0)) {
      return state;
    }

    const gapPct = this.inferGridGapPct(state) ?? this.config.gridGapPct;
    const orderAmountKrw = state.gridOrderAmountKrw || state.layers[0]?.amountKrw || 0;
    const grid = buildGrid({
      entryPrice,
      totalCapitalKrw: state.totalCapitalKrw || this.config.totalCapitalKrw,
      gridRatio: this.config.gridRatio,
      levels: state.layers.length || this.config.gridLevels,
      gapPct,
    });
    const layers = orderAmountKrw > 0
      ? grid.layers.map((layer) => ({ ...layer, amountKrw: orderAmountKrw }))
      : grid.layers;

    console.log(
      `[grid-bot] reanchored grid entry ${state.gridEntryPrice} -> ${entryPrice} levels=${layers.length} orderAmountKrw=${layers[0]?.amountKrw ?? grid.sizing.orderAmountKrw}`,
    );

    return {
      ...state,
      gridEntryPrice: entryPrice,
      gridInvestmentKrw: layers.reduce((sum, layer) => sum + layer.amountKrw, 0),
      gridOrderAmountKrw: layers[0]?.amountKrw ?? grid.sizing.orderAmountKrw,
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
        layers: nextState.layers.map((item) =>
          item.idx === layer.idx
            ? {
                ...item,
                qty: execution.qty,
                status: "OPEN",
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
      if (!shouldSellLayer(quote.tradePrice, layer)) continue;

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
