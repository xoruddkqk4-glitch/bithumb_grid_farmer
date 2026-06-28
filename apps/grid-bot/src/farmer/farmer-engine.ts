import { randomUUID } from "node:crypto";
import { buildRecoveryPosition } from "../../../../packages/shared/src";
import { DEFAULT_FARMER_ENTRY_PCT } from "../../../../packages/shared/src/constants";
import type {
  BotState,
  FarmerDefenseStatus,
  FarmerSignalState,
  OrderExecutor,
  TradeLogRecord,
} from "../../../../packages/shared/src/types";
import type { GridBotConfig } from "../config";
import { filterConfirmedDayCandles, type BithumbPublicClient, type PriceQuote } from "../bithumb/bithumb-client";
import type { JsonlTradeLogger } from "../storage/logger";
import { evaluateFarmerConfirmedFilters } from "./farmer-filters";
import { calculateFarmerSizing } from "./farmer-sizing";
import type { FarmerBlockedReason, FarmerFilterResult } from "./farmer-types";

const DAY_MS = 24 * 60 * 60 * 1000;

export class FarmerEngine {
  constructor(
    private readonly config: GridBotConfig,
    private readonly publicClient: BithumbPublicClient,
    private readonly executor: OrderExecutor,
    private readonly logger: JsonlTradeLogger,
  ) {}

  async tick(state: BotState, quote: PriceQuote): Promise<{ state: BotState; bought: boolean; signaled: boolean }> {
    if (!shouldWatchFarmer(state)) {
      return { state, bought: false, signaled: false };
    }

    const stage = state.farmerStage + 1;
    const maxStages = state.maxFarmerStages ?? 3;
    const blockedReasons: FarmerBlockedReason[] = [];
    const usePriceReachedFilter = state.farmerUsePriceReachedFilter ?? this.config.farmerUsePriceReachedFilter;

    if (stage > maxStages) {
      blockedReasons.push("MAX_STAGE_REACHED");
    }
    if (usePriceReachedFilter && !this.isPriceTriggered(state, quote.tradePrice)) {
      blockedReasons.push("PRICE_NOT_REACHED");
    }
    if (!this.isCooldownSatisfied(state, stage)) {
      blockedReasons.push("STAGE_COOLDOWN");
    }

    const sizing = calculateFarmerSizing({ state, price: quote.tradePrice, config: this.config });
    if (sizing.cappedOrderKrw < this.config.farmerMinOrderKrw) {
      blockedReasons.push("MIN_ORDER_NOT_MET");
    }
    if (sizing.defenseStatus === "CASH_SHORTAGE") {
      blockedReasons.push("CASH_SHORTAGE");
    }

    let filterResult: FarmerFilterResult;
      try {
        const filterConfig = {
          ...this.config,
          farmerMax3dDrawdownPct: state.farmerMax3dDrawdownPct ?? this.config.farmerMax3dDrawdownPct,
          farmerUseLongTrendFilter: state.farmerUseLongTrendFilter ?? this.config.farmerUseLongTrendFilter,
          farmerUseTurnoverRatioFilter: state.farmerUseTurnoverRatioFilter ?? this.config.farmerUseTurnoverRatioFilter,
          farmerUseMa5TrendFilter: state.farmerUseMa5TrendFilter ?? this.config.farmerUseMa5TrendFilter,
          farmerUseClosePositionFilter: state.farmerUseClosePositionFilter ?? this.config.farmerUseClosePositionFilter,
          farmerUseBullishDailyFilter: state.farmerUseBullishDailyFilter ?? this.config.farmerUseBullishDailyFilter,
          farmerUseTwoBullishDailyFilter:
            state.farmerUseTwoBullishDailyFilter ?? this.config.farmerUseTwoBullishDailyFilter,
          farmerUseVolatilityExplosionFilter:
            state.farmerUseVolatilityExplosionFilter ?? this.config.farmerUseVolatilityExplosionFilter,
        };
        filterResult = evaluateFarmerConfirmedFilters({
          candles: filterConfirmedDayCandles(await this.publicClient.getDayCandles(state.market, 230)),
          currentPrice: quote.tradePrice,
          config: filterConfig,
        });
    } catch {
      filterResult = {
        ok: false,
        blockedReasons: ["CANDLE_FETCH_FAILED" as const],
        indicators: null,
      };
    }
    blockedReasons.push(...filterResult.blockedReasons);

    const signal: FarmerSignalState = {
      checkedAt: new Date().toISOString(),
      stage,
      priceTriggered: !blockedReasons.includes("PRICE_NOT_REACHED"),
      confirmedFiltersOk: blockedReasons.length === 0,
      strictMa200Ok: filterResult.indicators?.strictMa200Ok ?? false,
      relaxedMa200Ok: filterResult.indicators?.relaxedMa200Ok ?? false,
      blockedReasons,
      signalQualityScore: filterResult.indicators?.signalQualityScore ?? 0,
      indicators: filterResult.indicators == null
        ? null
        : {
            ma200Today: filterResult.indicators.ma200Today,
            ma200Slope: filterResult.indicators.ma200Slope,
            turnover20dMultiple:
              filterResult.indicators.avg20Turnover > 0
                ? filterResult.indicators.lastDailyCandle.candleAccTradePrice /
                  filterResult.indicators.avg20Turnover
                : 0,
            turnover5dMultiple:
              filterResult.indicators.avg5Turnover > 0
                ? filterResult.indicators.lastDailyCandle.candleAccTradePrice /
                  filterResult.indicators.avg5Turnover
                : 0,
            closePosition: filterResult.indicators.closePosition,
            twoBullishDailyOk: filterResult.indicators.twoBullishDailyOk,
          },
    };

    let nextState: BotState = {
      ...state,
      farmerAnchorPrice: state.farmerStage === 0 ? getLastGridBuyPrice(state) : state.farmerAnchorPrice,
      farmerDefenseStatus: sizing.defenseStatus as FarmerDefenseStatus,
      farmerSignal: signal,
    };

    const shouldLogSignal = shouldAppendSignal(state.farmerSignal ?? null, signal);
    if (shouldLogSignal) {
      await this.appendSignalLog(nextState, quote, sizing, signal, filterResult.indicators);
    }

    if (!signal.confirmedFiltersOk || !this.config.enableFarmerConfirmedBuy) {
      return { state: nextState, bought: false, signaled: shouldLogSignal };
    }

    const requestId = randomUUID();
    const execution = await this.executor.buyMarket({
      market: nextState.market,
      price: quote.tradePrice,
      amountKrw: sizing.cappedOrderKrw,
      requestId,
    });
    const isFirstFarmerBuy = nextState.farmerStage === 0;
    const previousPhase = nextState.phase;
    const nextPhase = stage >= maxStages ? "HOLDING" : "FARMING";
    nextState = {
      ...nextState,
      farmerStage: stage,
      phase: nextPhase,
      farmerAnchorPrice: execution.price,
      farmerLastBuyAt: execution.executedAt,
      farmerLastBuyPrice: execution.price,
      farmerPositions: [
        ...(nextState.farmerPositions ?? []),
        {
          stage,
          qty: execution.qty,
          costKrw: execution.amountKrw,
          orderId: execution.orderId,
          boughtAt: execution.executedAt,
        },
      ],
      highestPrice: isFirstFarmerBuy ? execution.price : Math.max(nextState.highestPrice, execution.price),
    };

    if (previousPhase !== nextPhase) {
      await this.logger.append({
        timestamp: new Date().toISOString(),
        botId: nextState.botId,
        market: nextState.market,
        cycleId: nextState.cycleId,
        action: "PHASE_CHANGE",
        message: `${previousPhase} -> ${nextPhase}`,
        reason: "FARMER_BUY_CONFIRMED",
        metadata: {
          stage,
          farmerOrderId: execution.orderId,
        },
      });
    }

    await this.logger.append({
      timestamp: new Date().toISOString(),
      botId: nextState.botId,
      market: nextState.market,
      cycleId: nextState.cycleId,
      action: "FARMER_BUY",
      layerType: "FARMER",
      stage,
      price: execution.price,
      qty: execution.qty,
      amountKrw: execution.amountKrw,
      feeKrw: execution.feeKrw,
      orderId: execution.orderId,
      requestId: execution.requestId,
      reason: quote.source,
      metadata: {
        targetOrderKrw: sizing.targetOrderKrw,
        cappedOrderKrw: sizing.cappedOrderKrw,
        defenseStatus: sizing.defenseStatus,
        recoveryPosition: buildRecoveryPosition({
          gridLayers: nextState.layers,
          farmerLegs: (nextState.farmerPositions ?? []).map((position) => ({
            stage: position.stage,
            qty: position.qty,
            costKrw: position.costKrw,
            sourceOrderId: position.orderId,
            openedAt: position.boughtAt,
          })),
          lastPrice: quote.tradePrice,
        }),
      },
    });

    return { state: nextState, bought: true, signaled: true };
  }

  private isPriceTriggered(state: BotState, price: number): boolean {
    const nextEntryPrice = getNextFarmerEntryPrice(state);
    return nextEntryPrice != null && price <= nextEntryPrice;
  }

  private isCooldownSatisfied(state: BotState, stage: number): boolean {
    if (stage <= 1 || state.farmerLastBuyAt == null) {
      return true;
    }
    const elapsedDays = (Date.now() - new Date(state.farmerLastBuyAt).getTime()) / DAY_MS;
    const requiredDays =
      stage === 2
        ? state.farmerStage2CooldownDays ?? this.config.farmerStage2CooldownDays
        : state.farmerStage3CooldownDays ?? this.config.farmerStage3CooldownDays;
    return elapsedDays >= requiredDays;
  }

  private async appendSignalLog(
    state: BotState,
    quote: PriceQuote,
    sizing: ReturnType<typeof calculateFarmerSizing>,
    signal: FarmerSignalState,
    indicators: unknown,
  ): Promise<void> {
    const record: Omit<TradeLogRecord, "id"> = {
      timestamp: new Date().toISOString(),
      botId: state.botId,
      market: state.market,
      cycleId: state.cycleId,
      action: "FARMER_SIGNAL",
      layerType: "FARMER",
      stage: signal.stage,
      price: quote.tradePrice,
      reason: signal.confirmedFiltersOk ? "CONFIRMED_FILTERS_OK" : "BLOCKED",
      metadata: {
        priceTriggered: signal.priceTriggered,
        confirmedFiltersOk: signal.confirmedFiltersOk,
        strictMa200Ok: signal.strictMa200Ok,
        relaxedMa200Ok: signal.relaxedMa200Ok,
        blockedReasons: signal.blockedReasons,
        defenseStatus: sizing.defenseStatus,
        targetOrderKrw: sizing.targetOrderKrw,
        cappedOrderKrw: sizing.cappedOrderKrw,
        recoveryPositionValueKrw: sizing.recoveryPositionValueKrw,
        lastBuyPrice: getFarmerLastBuyPrice(state),
        farmerBasePrice: getFarmerLastBuyPrice(state),
        farmerEntryPct: getFarmerEntryPctForStage(state, signal.stage),
        nextFarmerEntryPrice: getNextFarmerEntryPrice(state),
        indicators,
      },
    };
    await this.logger.append(record);
  }
}

function shouldWatchFarmer(state: BotState): boolean {
  if (state.phase === "FARMING") {
    return true;
  }
  if (state.phase !== "GRID") {
    return false;
  }
  if (state.farmerStage !== 0 || (state.farmerPositions ?? []).some((position) => position.qty > 0)) {
    return false;
  }
  return state.layers.length > 0 && state.layers.every((layer) => layer.status === "OPEN" && layer.qty > 0);
}

function getLastGridBuyPrice(state: BotState): number | null {
  const lastLayer =
    [...state.layers]
      .sort((left, right) => right.idx - left.idx)[0] ??
    null;
  if (lastLayer == null) return null;
  return lastLayer.buyPrice > 0 ? lastLayer.buyPrice : null;
}

function getFarmerLastBuyPrice(state: BotState): number | null {
  if (state.farmerStage === 0) {
    return getLastGridBuyPrice(state);
  }
  return state.farmerAnchorPrice ?? state.farmerLastBuyPrice ?? null;
}

function getNextFarmerEntryPrice(state: BotState): number | null {
  const lastBuyPrice = getFarmerLastBuyPrice(state);
  if (lastBuyPrice == null) return null;
  const stage = state.farmerStage + 1;
  const entryPct = getFarmerEntryPctForStage(state, stage);
  return lastBuyPrice * (1 - entryPct);
}

function getFarmerEntryPctForStage(state: BotState, stage: number): number {
  const stageEntryPct = state.farmerEntryPcts?.[stage - 1];
  if (stageEntryPct != null && Number.isFinite(stageEntryPct) && stageEntryPct > 0) {
    return stageEntryPct;
  }
  return state.farmerEntryPct ?? DEFAULT_FARMER_ENTRY_PCT;
}

function shouldAppendSignal(previous: FarmerSignalState | null, next: FarmerSignalState): boolean {
  if (previous == null) return true;
  if (previous.stage !== next.stage) return true;
  return false;
}
