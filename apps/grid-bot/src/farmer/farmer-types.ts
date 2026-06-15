import type { DayCandle } from "../bithumb/bithumb-client";

export type FarmerBlockedReason =
  | "NOT_FARMING_PHASE"
  | "MAX_STAGE_REACHED"
  | "PRICE_NOT_REACHED"
  | "STAGE_COOLDOWN"
  | "INSUFFICIENT_CANDLES"
  | "FREEFALL_3D_DRAWDOWN"
  | "VOLATILITY_EXPLOSION"
  | "LONG_TREND_BLOCKED"
  | "MA5_TREND_BLOCKED"
  | "TURNOVER_RATIO_BLOCKED"
  | "TURNOVER_ABSOLUTE_BLOCKED"
  | "CLOSE_POSITION_BLOCKED"
  | "BULLISH_DAILY_BLOCKED"
  | "TWO_BULLISH_DAILY_BLOCKED"
  | "CAPITULATION_BLOCKED"
  | "CASH_SHORTAGE"
  | "MIN_ORDER_NOT_MET"
  | "CANDLE_FETCH_FAILED";

export interface FarmerIndicators {
  lastDailyCandle: DayCandle;
  currentPrice: number;
  ma5Today: number;
  ma5Yesterday: number;
  ma200Today: number;
  ma200Lookback: number;
  ma200Slope: number;
  avg20Turnover: number;
  avg5Turnover: number;
  closePosition: number;
  drawdown3dPct: number;
  trueRange: number;
  nValue: number;
  strictMa200Ok: boolean;
  relaxedMa200Ok: boolean;
  twoBullishDailyOk: boolean;
  signalQualityScore: number;
}

export interface FarmerFilterResult {
  ok: boolean;
  blockedReasons: FarmerBlockedReason[];
  indicators: FarmerIndicators | null;
}

export interface FarmerSizingResult {
  targetOrderKrw: number;
  cappedOrderKrw: number;
  defenseStatus: "FULL_DEFENSE" | "PARTIAL_DEFENSE" | "CASH_SHORTAGE";
  recoveryPositionValueKrw: number;
}
