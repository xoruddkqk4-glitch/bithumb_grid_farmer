export type BotPhase = "GRID" | "FARMING" | "HOLDING" | "COOLDOWN";

export type GridLayerStatus = "WAITING" | "OPEN" | "SOLD";

export type TradeAction =
  | "GRID_BUY"
  | "GRID_SELL"
  | "FARMER_BUY"
  | "FARMER_SIGNAL"
  | "RECOVERY_EXIT_SIGNAL"
  | "RECOVERY_SELL"
  | "PHASE_CHANGE"
  | "BOT_ERROR";

export type FarmerDefenseStatus = "FULL_DEFENSE" | "PARTIAL_DEFENSE" | "CASH_SHORTAGE";

export interface FarmerPositionLeg {
  stage: number;
  qty: number;
  costKrw: number;
  orderId: string | null;
  boughtAt: string | null;
}

export interface FarmerSignalState {
  checkedAt: string;
  stage: number;
  priceTriggered: boolean;
  confirmedFiltersOk: boolean;
  strictMa200Ok: boolean;
  relaxedMa200Ok: boolean;
  blockedReasons: string[];
  signalQualityScore: number;
  indicators?: {
    ma200Today: number;
    ma200Slope: number;
    turnover20dMultiple: number;
    turnover5dMultiple: number;
    closePosition: number;
    twoBullishDailyOk?: boolean;
  } | null;
}

export type RecoveryExitReason = "2N_TRAIL" | "MA5_EXIT" | "N_DAY_LOW_BREAK" | "TAKE_PROFIT_1" | "TAKE_PROFIT_2";
export type RecoveryTrailingActivationMode = "PROFIT_POSITIVE" | "TP1" | "TP2";

export interface RecoveryExitSignalState {
  checkedAt: string;
  triggered: boolean;
  reason: RecoveryExitReason | null;
  blockedReasons: string[];
  price: number;
  highestPrice: number;
  nValue: number | null;
  trailingStopPrice: number | null;
  lowBreakoutPrice?: number | null;
  lowBreakout?: boolean;
  ma5Exit: boolean;
  profitGateOk: boolean;
  expectedNetPnlKrw: number | null;
  expectedNetPnlPct: number | null;
  recoveryQty: number;
  recoveryCostKrw: number;
  recoveryMarketValueKrw: number | null;
}

export interface GridLayer {
  idx: number;
  extensionRound?: number;
  extensionIdx?: number;
  buyPrice: number;
  sellPrice: number;
  amountKrw: number;
  buyGapPct?: number;
  buyAmountMultiplier?: number;
  takeProfitPct?: number;
  trailingPullbackPct?: number;
  trailingActive?: boolean;
  trailingHighPrice?: number | null;
  qty: number;
  status: GridLayerStatus;
  buyCount: number;
  sellCount: number;
  boughtAt: string | null;
  soldAt: string | null;
  buyOrderId: string | null;
  sellOrderId: string | null;
}

export interface GridLevelSetting {
  level: number;
  buyGapPct: number;
  buyAmountMultiplier: number;
  takeProfitPct: number;
  trailingPullbackPct: number;
}

export interface BotState {
  schemaVersion: number;
  strategyVersion: string;
  botId: string;
  market: string;
  phase: BotPhase;
  cycleId: string;
  gridEntryPrice: number | null;
  gridEntryReferencePrice?: number | null;
  gridEntryNValue?: number | null;
  gridEntryNCalculatedForKstDate?: string | null;
  gridInvestmentKrw: number;
  gridOrderAmountKrw: number;
  gridLevelSettings?: GridLevelSetting[];
  totalCapitalKrw: number;
  layers: GridLayer[];
  farmerStage: number;
  maxFarmerStages?: number;
  farmerEntryPct?: number;
  farmerMax3dDrawdownPct?: number;
  farmerStage2CooldownDays?: number;
  farmerStage3CooldownDays?: number;
  farmerUsePriceReachedFilter?: boolean;
  farmerUseLongTrendFilter?: boolean;
  farmerUseTurnoverRatioFilter?: boolean;
  farmerUseMa5TrendFilter?: boolean;
  farmerUseClosePositionFilter?: boolean;
  farmerUseBullishDailyFilter?: boolean;
  farmerUseTwoBullishDailyFilter?: boolean;
  farmerUseVolatilityExplosionFilter?: boolean;
  farmerAnchorPrice: number | null;
  farmerLastBuyAt?: string | null;
  farmerLastBuyPrice?: number | null;
  farmerDefenseStatus?: FarmerDefenseStatus | null;
  farmerSignal?: FarmerSignalState | null;
  farmerPositions?: FarmerPositionLeg[];
  gridLoopIntervalMs?: number;
  farmingLoopIntervalMs?: number;
  recoveryExitSignal?: RecoveryExitSignalState | null;
  enableRecoveryTurtleSell?: boolean;
  recoveryTurtleNPeriod?: number;
  recoveryTurtleLowBreakoutPeriod?: number;
  recoveryTurtleNMultiplier?: number;
  recoveryTurtleMinOrderKrw?: number;
  recoveryUseSliceOrder?: boolean;
  recoveryTurtleSliceOrderKrw?: number;
  recoveryTurtleSliceIntervalSeconds?: number;
  recoveryUse2NTrailExit?: boolean;
  recoveryUseMa5Exit?: boolean;
  recoveryUseLowBreakoutExit?: boolean;
  recoveryTrailingActivationMode?: RecoveryTrailingActivationMode;
  partialTakeProfitEnabled?: boolean;
  takeProfit1ReturnPct?: number;
  takeProfit1SellRatio?: number;
  takeProfit1Done?: boolean;
  takeProfit2ReturnPct?: number;
  takeProfit2SellRatio?: number;
  takeProfit2Done?: boolean;
  gridResetRequestedAt?: string | null;
  gridResetCompletedAt?: string | null;
  gridResetLastError?: string | null;
  highestPrice: number;
  nValue: number | null;
  cooldownUntil: string | null;
  lastExitTime: string | null;
  lastPrice: number | null;
  lastLoopAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradeLogRecord {
  id: string;
  timestamp: string;
  botId: string;
  market: string;
  cycleId: string;
  action: TradeAction;
  layerType?: "GRID" | "FARMER";
  stage?: number;
  price?: number;
  qty?: number;
  amountKrw?: number;
  feeKrw?: number;
  avgPriceAfter?: number | null;
  positionQtyAfter?: number | null;
  realizedPnlKrw?: number | null;
  realizedPnlPct?: number | null;
  reason?: string | null;
  orderId?: string | null;
  requestId?: string | null;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface OrderExecution {
  orderId: string;
  requestId: string;
  market: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  amountKrw: number;
  feeKrw: number;
  executedAt: string;
  isPaper: boolean;
}

export interface OrderExecutor {
  buyMarket(params: {
    market: string;
    price: number;
    amountKrw: number;
    requestId: string;
  }): Promise<OrderExecution>;
  sellMarket(params: {
    market: string;
    price: number;
    qty: number;
    requestId: string;
  }): Promise<OrderExecution>;
}

export interface GridDecisionSummary {
  initialized: boolean;
  buys: number;
  sells: number;
  phaseChanged: boolean;
}
