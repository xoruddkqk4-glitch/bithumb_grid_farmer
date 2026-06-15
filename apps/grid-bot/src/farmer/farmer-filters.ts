import type { GridBotConfig } from "../config";
import type { DayCandle } from "../bithumb/bithumb-client";
import type { FarmerBlockedReason, FarmerFilterResult, FarmerIndicators } from "./farmer-types";

const MA200_SLOPE_LOOKBACK = 20;

export function evaluateFarmerConfirmedFilters(params: {
  candles: DayCandle[];
  currentPrice: number;
  config: GridBotConfig;
}): FarmerFilterResult {
  const candles = params.candles;
  const currentPrice = params.currentPrice;
  if (candles.length < 220) {
    return { ok: false, blockedReasons: ["INSUFFICIENT_CANDLES"], indicators: null };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const close3dAgo = candles[candles.length - 4]?.tradePrice;
  if (last == null || previous == null || close3dAgo == null) {
    return { ok: false, blockedReasons: ["INSUFFICIENT_CANDLES"], indicators: null };
  }

  const ma5Today = average(candles.slice(-5).map((candle) => candle.tradePrice));
  const ma5Yesterday = average(candles.slice(-6, -1).map((candle) => candle.tradePrice));
  const ma200Today = average(candles.slice(-200).map((candle) => candle.tradePrice));
  const ma200Lookback = average(
    candles.slice(-(200 + MA200_SLOPE_LOOKBACK), -MA200_SLOPE_LOOKBACK).map((candle) => candle.tradePrice),
  );
  const avg20Turnover = average(candles.slice(-20).map((candle) => candle.candleAccTradePrice));
  const avg5Turnover = average(candles.slice(-5).map((candle) => candle.candleAccTradePrice));
  const closePosition = calculateClosePosition(last);
  const drawdown3dPct = currentPrice / close3dAgo - 1;
  const trueRange = calculateTrueRange(last, previous.tradePrice);
  const nValue = calculateAverageTrueRange(candles.slice(-20));
  const strictMa200Ok = currentPrice > ma200Today;
  const relaxedMa200Ok = ma200Today >= ma200Lookback;
  const twoBullishDailyOk = last.tradePrice > last.openingPrice && previous.tradePrice > previous.openingPrice;
  const capitulation = last.candleAccTradePrice >= avg20Turnover * 3.5 && closePosition < 0.6;
  const blockedReasons: FarmerBlockedReason[] = [];

  if (params.config.farmerUseVolatilityExplosionFilter && drawdown3dPct <= params.config.farmerMax3dDrawdownPct) {
    blockedReasons.push("FREEFALL_3D_DRAWDOWN");
  }
  if (params.config.farmerUseVolatilityExplosionFilter && trueRange > nValue * params.config.farmerVolatilityNMultiplier) {
    blockedReasons.push("VOLATILITY_EXPLOSION");
  }
  if (
    params.config.farmerUseLongTrendFilter &&
    (params.config.farmerLongTrendMode === "strict" ? !strictMa200Ok : !relaxedMa200Ok)
  ) {
    blockedReasons.push("LONG_TREND_BLOCKED");
  }
  if (params.config.farmerUseMa5TrendFilter && (currentPrice <= ma5Today || ma5Today < ma5Yesterday)) {
    blockedReasons.push("MA5_TREND_BLOCKED");
  }
  if (
    params.config.farmerUseTurnoverRatioFilter &&
    (last.candleAccTradePrice < avg20Turnover * 1.5 || last.candleAccTradePrice < avg5Turnover * 1.2)
  ) {
    blockedReasons.push("TURNOVER_RATIO_BLOCKED");
  }
  if (params.config.farmerUseTurnoverRatioFilter && last.candleAccTradePrice < params.config.farmerMinDailyTurnoverKrw) {
    blockedReasons.push("TURNOVER_ABSOLUTE_BLOCKED");
  }
  if (params.config.farmerUseClosePositionFilter && closePosition < 0.6) {
    blockedReasons.push("CLOSE_POSITION_BLOCKED");
  }
  if (params.config.farmerUseBullishDailyFilter && last.tradePrice <= last.openingPrice) {
    blockedReasons.push("BULLISH_DAILY_BLOCKED");
  }
  if (params.config.farmerUseTwoBullishDailyFilter && !twoBullishDailyOk) {
    blockedReasons.push("TWO_BULLISH_DAILY_BLOCKED");
  }
  if (params.config.farmerUseVolatilityExplosionFilter && capitulation) {
    blockedReasons.push("CAPITULATION_BLOCKED");
  }

  const indicators: FarmerIndicators = {
    lastDailyCandle: last,
    currentPrice,
    ma5Today,
    ma5Yesterday,
    ma200Today,
    ma200Lookback,
    ma200Slope: ma200Today - ma200Lookback,
    avg20Turnover,
    avg5Turnover,
    closePosition,
    drawdown3dPct,
    trueRange,
    nValue,
    strictMa200Ok,
    relaxedMa200Ok,
    twoBullishDailyOk,
    signalQualityScore: 0,
  };

  return {
    ok: blockedReasons.length === 0,
    blockedReasons,
    indicators,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateClosePosition(candle: DayCandle): number {
  const range = candle.highPrice - candle.lowPrice;
  return range > 0 ? (candle.tradePrice - candle.lowPrice) / range : 0;
}

function calculateTrueRange(candle: DayCandle, previousClose: number): number {
  return Math.max(
    candle.highPrice - candle.lowPrice,
    Math.abs(candle.highPrice - previousClose),
    Math.abs(candle.lowPrice - previousClose),
  );
}

function calculateAverageTrueRange(candles: DayCandle[]): number {
  let previousClose = candles[0]?.tradePrice ?? 0;
  const ranges: number[] = [];
  for (const candle of candles.slice(1)) {
    ranges.push(calculateTrueRange(candle, previousClose));
    previousClose = candle.tradePrice;
  }
  return ranges.length > 0 ? average(ranges) : 0;
}
