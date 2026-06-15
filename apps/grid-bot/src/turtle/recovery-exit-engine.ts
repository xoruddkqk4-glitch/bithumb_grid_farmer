import { randomUUID } from "node:crypto";
import { buildRecoveryPosition, roundKrw, roundQty } from "../../../../packages/shared/src";
import type {
  BotState,
  OrderExecution,
  OrderExecutor,
  RecoveryExitReason,
  RecoveryExitSignalState,
  RecoveryTrailingActivationMode,
  TradeLogRecord,
} from "../../../../packages/shared/src/types";
import { filterConfirmedDayCandles, type BithumbPublicClient, type PriceQuote } from "../bithumb/bithumb-client";
import { sleep } from "../bithumb/rate-limiter";
import type { GridBotConfig } from "../config";
import type { JsonlTradeLogger } from "../storage/logger";
import { calculateTurtleDailyIndicators } from "./turtle-indicators";

export class RecoveryExitEngine {
  constructor(
    private readonly config: GridBotConfig,
    private readonly publicClient: BithumbPublicClient,
    private readonly executor: OrderExecutor,
    private readonly logger: JsonlTradeLogger,
  ) {}

  async tick(
    state: BotState,
    quote: PriceQuote,
    controls?: { enableRecoverySell?: boolean },
  ): Promise<{ state: BotState; sold: boolean; signaled: boolean }> {
    if (!shouldWatchRecoveryExit(state)) {
      return { state, sold: false, signaled: false };
    }

    const recoveryPosition = buildRecoveryPosition({
      gridLayers: state.layers,
      farmerLegs: (state.farmerPositions ?? []).map((position) => ({
        stage: position.stage,
        qty: position.qty,
        costKrw: position.costKrw,
        sourceOrderId: position.orderId,
        openedAt: position.boughtAt,
      })),
      lastPrice: quote.tradePrice,
    });
    if (recoveryPosition.totalQty <= 0 || recoveryPosition.totalCostKrw <= 0) {
      return { state, sold: false, signaled: false };
    }

    const settings = resolveRecoveryTurtleSettings(state, this.config);
    const highestPrice = Math.max(state.highestPrice || quote.tradePrice, quote.tradePrice);
    let nValue: number | null = null;
    let ma5Exit = false;
    let lowBreakout = false;
    let lowBreakoutPrice: number | null = null;
    let indicatorError: string | null = null;
    try {
      const indicators = calculateTurtleDailyIndicators(
        filterConfirmedDayCandles(
          await this.publicClient.getDayCandles(
            state.market,
            Math.max(30, settings.nPeriod + 10, settings.lowBreakoutPeriod + 2),
          ),
        ),
        settings.nPeriod,
        settings.lowBreakoutPeriod,
        quote.tradePrice,
      );
      nValue = indicators.nValue ?? nValue;
      ma5Exit = indicators.ma5Exit;
      lowBreakout = indicators.lowBreakout;
      lowBreakoutPrice = indicators.lowBreakoutPrice;
    } catch (error) {
      indicatorError = error instanceof Error ? error.message : String(error);
    }

    const trailingStopPrice =
      nValue != null ? highestPrice - nValue * settings.nMultiplier : null;
    const trailingExit = trailingStopPrice != null && quote.tradePrice < trailingStopPrice;
    const expected = calculateExpectedNetPnl({
      grossSellKrw: quote.tradePrice * recoveryPosition.totalQty,
      costKrw: recoveryPosition.totalCostKrw,
      feeRate: this.config.feeRate,
    });
    const takeProfitPlan = resolveTakeProfitPlan(state, settings, expected.netPnlPct, expected.profitGateOk);
    const trailingActivationOk = isTrailingActivationActive(settings, expected.netPnlPct);
    const turtleReason: RecoveryExitReason | null = settings.use2NTrailExit && trailingActivationOk && trailingExit
      ? "2N_TRAIL"
      : settings.useMa5Exit && ma5Exit
        ? "MA5_EXIT"
        : settings.useLowBreakoutExit && lowBreakout
          ? "N_DAY_LOW_BREAK"
          : null;
    const reason: RecoveryExitReason | null = takeProfitPlan?.reason ?? turtleReason;
    const plannedSellQty = reason == null
      ? recoveryPosition.totalQty
      : roundQty(recoveryPosition.totalQty * (takeProfitPlan?.sellRatio ?? 1));
    const plannedSellMarketValueKrw = roundKrw(plannedSellQty * quote.tradePrice);
    const blockedReasons: string[] = [];
    if (indicatorError != null && nValue == null) blockedReasons.push("INDICATOR_FETCH_FAILED");
    if (!expected.profitGateOk) blockedReasons.push("PROFIT_GATE");
    if (reason == null) blockedReasons.push("EXIT_TRIGGER_NOT_MET");
    if (plannedSellQty <= 0 || plannedSellMarketValueKrw < settings.minOrderKrw) {
      blockedReasons.push("MIN_ORDER_NOT_MET");
    }

    const signal: RecoveryExitSignalState = {
      checkedAt: new Date().toISOString(),
      triggered: blockedReasons.length === 0,
      reason,
      blockedReasons,
      price: quote.tradePrice,
      highestPrice,
      nValue,
      trailingStopPrice,
      lowBreakoutPrice,
      lowBreakout,
      ma5Exit,
      profitGateOk: expected.profitGateOk,
      expectedNetPnlKrw: expected.netPnlKrw,
      expectedNetPnlPct: expected.netPnlPct,
      recoveryQty: recoveryPosition.totalQty,
      recoveryCostKrw: recoveryPosition.totalCostKrw,
      recoveryMarketValueKrw: recoveryPosition.marketValueKrw,
    };

    let nextState: BotState = {
      ...state,
      highestPrice,
      nValue,
      recoveryExitSignal: signal,
    };

    const shouldLogSignal = shouldAppendSignal(state.recoveryExitSignal ?? null, signal);
    if (shouldLogSignal) {
      const amountKrw = recoveryPosition.marketValueKrw;
      await this.appendLog(nextState, {
        action: "RECOVERY_EXIT_SIGNAL",
        price: quote.tradePrice,
        qty: recoveryPosition.totalQty,
        ...(amountKrw != null ? { amountKrw } : {}),
        realizedPnlKrw: expected.netPnlKrw,
        realizedPnlPct: expected.netPnlPct,
        reason: signal.triggered ? reason : "BLOCKED",
        metadata: {
          blockedReasons,
          highestPrice,
          nValue,
          trailingStopPrice,
          trailingActivationOk,
          takeProfitPlan,
          lowBreakoutPrice,
          lowBreakout,
          settings,
          ma5Exit,
          profitGateOk: expected.profitGateOk,
          recoveryPosition,
          indicatorError,
        },
      });
    }

    if (!signal.triggered || !(controls?.enableRecoverySell ?? this.config.enableRecoveryTurtleSell)) {
      return { state: nextState, sold: false, signaled: shouldLogSignal };
    }

    const executions = await this.sellInSlices(nextState, quote.tradePrice, plannedSellQty, settings);
    const soldQty = roundQty(executions.reduce((sum, execution) => sum + execution.qty, 0));
    const soldAmountKrw = roundKrw(executions.reduce((sum, execution) => sum + execution.amountKrw, 0));
    const sellFeeKrw = roundKrw(executions.reduce((sum, execution) => sum + execution.feeKrw, 0));
    const soldRatio = recoveryPosition.totalQty > 0 ? Math.min(1, soldQty / recoveryPosition.totalQty) : 0;
    const soldCostKrw = roundKrw(recoveryPosition.totalCostKrw * soldRatio);
    const buyFeeEstimateKrw = roundKrw(soldCostKrw * this.config.feeRate);
    const realizedPnlKrw = roundKrw(soldAmountKrw - sellFeeKrw - buyFeeEstimateKrw - soldCostKrw);
    const realizedPnlPct =
      soldCostKrw > 0 ? (realizedPnlKrw / soldCostKrw) * 100 : null;
    const finalExecution = executions[executions.length - 1] ?? null;
    const executedAt = finalExecution?.executedAt ?? new Date().toISOString();
    const fullExit = takeProfitPlan == null || soldRatio >= 0.99999999;
    const reducedState = reduceRecoveryPosition(nextState, soldRatio, fullExit, executedAt, finalExecution?.orderId ?? null);

    nextState = {
      ...reducedState,
      phase: fullExit ? "COOLDOWN" : reducedState.phase,
      lastExitTime: fullExit ? executedAt : reducedState.lastExitTime,
      takeProfit1Done: fullExit ? false : (reason === "TAKE_PROFIT_1" ? true : reducedState.takeProfit1Done ?? false),
      takeProfit2Done: fullExit ? false : (reason === "TAKE_PROFIT_2" ? true : reducedState.takeProfit2Done ?? false),
      recoveryExitSignal: {
        ...signal,
        expectedNetPnlKrw: realizedPnlKrw,
        expectedNetPnlPct: realizedPnlPct,
      },
    };

    await this.appendLog(nextState, {
      action: "RECOVERY_SELL",
      layerType: "FARMER",
      price: soldQty > 0 ? roundKrw(soldAmountKrw / soldQty) : quote.tradePrice,
      qty: soldQty,
      amountKrw: soldAmountKrw,
      feeKrw: sellFeeKrw,
      realizedPnlKrw,
      realizedPnlPct,
      orderId: finalExecution?.orderId ?? null,
      requestId: executions.map((execution) => execution.requestId).join(","),
      reason,
      metadata: {
        sliceCount: executions.length,
        buyFeeEstimateKrw,
        soldCostKrw,
        soldRatio,
        fullExit,
        takeProfitPlan,
        recoveryPosition,
        executions,
      },
    });

    return { state: nextState, sold: true, signaled: true };
  }

  private async sellInSlices(
    state: BotState,
    price: number,
    totalQty: number,
    settings: RecoveryTurtleRuntimeSettings,
  ): Promise<OrderExecution[]> {
    const executions: OrderExecution[] = [];
    let remainingQty = totalQty;
    const sliceOrderKrw = settings.useSliceOrder ? settings.sliceOrderKrw : 0;
    while (remainingQty > 0) {
      const sliceQty =
        sliceOrderKrw > 0 ? Math.min(remainingQty, roundQty(sliceOrderKrw / price)) : remainingQty;
      if (sliceQty <= 0) break;
      const execution = await this.executor.sellMarket({
        market: state.market,
        price,
        qty: sliceQty,
        requestId: randomUUID(),
      });
      executions.push(execution);
      remainingQty = roundQty(remainingQty - execution.qty);
      if (remainingQty > 0 && settings.sliceIntervalSeconds > 0) {
        await sleep(settings.sliceIntervalSeconds * 1000);
      }
    }
    return executions;
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

interface RecoveryTurtleRuntimeSettings {
  nPeriod: number;
  lowBreakoutPeriod: number;
  nMultiplier: number;
  minOrderKrw: number;
  useSliceOrder: boolean;
  sliceOrderKrw: number;
  sliceIntervalSeconds: number;
  use2NTrailExit: boolean;
  useMa5Exit: boolean;
  useLowBreakoutExit: boolean;
  trailingActivationMode: RecoveryTrailingActivationMode;
  takeProfit1ReturnPct: number;
  takeProfit1SellRatio: number;
  takeProfit2ReturnPct: number;
  takeProfit2SellRatio: number;
}

function resolveRecoveryTurtleSettings(state: BotState, config: GridBotConfig): RecoveryTurtleRuntimeSettings {
  return {
    nPeriod: state.recoveryTurtleNPeriod ?? config.recoveryTurtleNPeriod,
    lowBreakoutPeriod: state.recoveryTurtleLowBreakoutPeriod ?? config.recoveryTurtleLowBreakoutPeriod,
    nMultiplier: state.recoveryTurtleNMultiplier ?? config.recoveryTurtleNMultiplier,
    minOrderKrw: state.recoveryTurtleMinOrderKrw ?? config.recoveryTurtleMinOrderKrw,
    useSliceOrder: state.recoveryUseSliceOrder ?? config.recoveryUseSliceOrder,
    sliceOrderKrw: state.recoveryTurtleSliceOrderKrw ?? config.recoveryTurtleSliceOrderKrw,
    sliceIntervalSeconds: state.recoveryTurtleSliceIntervalSeconds ?? config.recoveryTurtleSliceIntervalSeconds,
    use2NTrailExit: state.recoveryUse2NTrailExit ?? config.recoveryUse2NTrailExit,
    useMa5Exit: state.recoveryUseMa5Exit ?? config.recoveryUseMa5Exit,
    useLowBreakoutExit: state.recoveryUseLowBreakoutExit ?? config.recoveryUseLowBreakoutExit,
    trailingActivationMode: state.recoveryTrailingActivationMode ?? config.recoveryTrailingActivationMode,
    takeProfit1ReturnPct: state.takeProfit1ReturnPct ?? 0.1,
    takeProfit1SellRatio: state.takeProfit1SellRatio ?? 0.33,
    takeProfit2ReturnPct: state.takeProfit2ReturnPct ?? 0.2,
    takeProfit2SellRatio: state.takeProfit2SellRatio ?? 0.33,
  };
}

function resolveTakeProfitPlan(
  state: BotState,
  settings: RecoveryTurtleRuntimeSettings,
  expectedNetPnlPct: number | null,
  profitGateOk: boolean,
): { reason: Extract<RecoveryExitReason, "TAKE_PROFIT_1" | "TAKE_PROFIT_2">; sellRatio: number } | null {
  if (state.partialTakeProfitEnabled !== true || !profitGateOk || expectedNetPnlPct == null) {
    return null;
  }
  if (state.takeProfit1Done !== true && expectedNetPnlPct >= settings.takeProfit1ReturnPct * 100) {
    return { reason: "TAKE_PROFIT_1", sellRatio: clampRatio(settings.takeProfit1SellRatio) };
  }
  if (
    state.takeProfit1Done === true &&
    state.takeProfit2Done !== true &&
    expectedNetPnlPct >= settings.takeProfit2ReturnPct * 100
  ) {
    return { reason: "TAKE_PROFIT_2", sellRatio: clampRatio(settings.takeProfit2SellRatio) };
  }
  return null;
}

function reduceRecoveryPosition(
  state: BotState,
  soldRatio: number,
  fullExit: boolean,
  soldAt: string,
  sellOrderId: string | null,
): BotState {
  if (fullExit) {
    return {
      ...state,
      layers: state.layers.map((layer) =>
        layer.status === "OPEN" && layer.qty > 0
          ? {
              ...layer,
              amountKrw: state.gridOrderAmountKrw > 0 ? state.gridOrderAmountKrw : layer.amountKrw,
              qty: 0,
              status: "SOLD",
              sellCount: layer.sellCount + 1,
              soldAt,
              sellOrderId: sellOrderId ?? layer.sellOrderId,
            }
          : layer,
      ),
      farmerPositions: [],
    };
  }

  const remainingRatio = Math.max(0, 1 - soldRatio);
  return {
    ...state,
    layers: state.layers.map((layer) => {
      if (layer.status !== "OPEN" || layer.qty <= 0) return layer;
      const qty = roundQty(layer.qty * remainingRatio);
      const amountKrw = roundKrw(layer.amountKrw * remainingRatio);
      if (qty <= 0 || amountKrw <= 0) {
        return {
          ...layer,
          qty: 0,
          status: "SOLD",
          sellCount: layer.sellCount + 1,
          soldAt,
          sellOrderId: sellOrderId ?? layer.sellOrderId,
        };
      }
      return {
        ...layer,
        qty,
        amountKrw,
      };
    }),
    farmerPositions: (state.farmerPositions ?? [])
      .map((position) => ({
        ...position,
        qty: roundQty(position.qty * remainingRatio),
        costKrw: roundKrw(position.costKrw * remainingRatio),
      }))
      .filter((position) => position.qty > 0 && position.costKrw > 0),
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isTrailingActivationActive(
  settings: Pick<RecoveryTurtleRuntimeSettings, "trailingActivationMode" | "takeProfit1ReturnPct" | "takeProfit2ReturnPct">,
  expectedNetPnlPct: number | null,
): boolean {
  if (expectedNetPnlPct == null) return false;
  if (settings.trailingActivationMode === "PROFIT_POSITIVE") return expectedNetPnlPct > 0;
  if (settings.trailingActivationMode === "TP2") return expectedNetPnlPct >= settings.takeProfit2ReturnPct * 100;
  return expectedNetPnlPct >= settings.takeProfit1ReturnPct * 100;
}

function shouldWatchRecoveryExit(state: BotState): boolean {
  if (state.phase !== "FARMING" && state.phase !== "HOLDING") return false;
  return state.farmerStage > 0 || (state.farmerPositions ?? []).some((position) => position.qty > 0);
}

function calculateExpectedNetPnl(params: {
  grossSellKrw: number;
  costKrw: number;
  feeRate: number;
}): { netPnlKrw: number; netPnlPct: number | null; profitGateOk: boolean } {
  const grossSellKrw = roundKrw(params.grossSellKrw);
  const sellFeeKrw = roundKrw(grossSellKrw * params.feeRate);
  const buyFeeEstimateKrw = roundKrw(params.costKrw * params.feeRate);
  const netPnlKrw = roundKrw(grossSellKrw - sellFeeKrw - buyFeeEstimateKrw - params.costKrw);
  return {
    netPnlKrw,
    netPnlPct: params.costKrw > 0 ? (netPnlKrw / params.costKrw) * 100 : null,
    profitGateOk: netPnlKrw > 0,
  };
}

function shouldAppendSignal(previous: RecoveryExitSignalState | null, next: RecoveryExitSignalState): boolean {
  if (previous == null) return true;
  if (previous.triggered !== next.triggered) return true;
  if (previous.reason !== next.reason) return true;
  if (previous.profitGateOk !== next.profitGateOk) return true;
  if (previous.ma5Exit !== next.ma5Exit) return true;
  if (previous.lowBreakout !== next.lowBreakout) return true;
  if (previous.blockedReasons.join("|") !== next.blockedReasons.join("|")) return true;
  return previous.trailingStopPrice !== next.trailingStopPrice || previous.lowBreakoutPrice !== next.lowBreakoutPrice;
}
