import type { DayCandle } from "../bithumb/bithumb-client";

export interface TurtleDailyIndicators {
  nValue: number | null;
  ma5: number | null;
  lastClose: number | null;
  ma5Exit: boolean;
  lowBreakoutPrice: number | null;
  lowBreakout: boolean;
}

export function calculateTurtleDailyIndicators(
  candles: DayCandle[],
  nPeriod: number,
  lowBreakoutPeriod = nPeriod,
): TurtleDailyIndicators {
  const safePeriod = Math.max(1, Math.floor(nPeriod));
  const safeLowBreakoutPeriod = Math.max(1, Math.floor(lowBreakoutPeriod));
  const last = candles[candles.length - 1] ?? null;
  const ma5 = candles.length >= 5 ? average(candles.slice(-5).map((candle) => candle.tradePrice)) : null;
  const nValue = calculateWilderAtr(candles, safePeriod);
  const lastClose = last?.tradePrice ?? null;
  const previousCandles = candles.slice(-(safeLowBreakoutPeriod + 1), -1);
  const lowBreakoutPrice =
    previousCandles.length >= safeLowBreakoutPeriod
      ? Math.min(...previousCandles.map((candle) => candle.lowPrice))
      : null;

  return {
    nValue,
    ma5,
    lastClose,
    ma5Exit: lastClose != null && ma5 != null ? lastClose < ma5 : false,
    lowBreakoutPrice,
    lowBreakout: lastClose != null && lowBreakoutPrice != null ? lastClose < lowBreakoutPrice : false,
  };
}

function calculateWilderAtr(candles: DayCandle[], period: number): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const trueRanges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (candle == null || previous == null) continue;
    trueRanges.push(calculateTrueRange(candle, previous.tradePrice));
  }

  if (trueRanges.length < period) {
    return null;
  }

  let atr = average(trueRanges.slice(0, period));
  for (const trueRange of trueRanges.slice(period)) {
    atr = (atr * (period - 1) + trueRange) / period;
  }
  return atr;
}

function calculateTrueRange(candle: DayCandle, previousClose: number): number {
  return Math.max(
    candle.highPrice - candle.lowPrice,
    Math.abs(candle.highPrice - previousClose),
    Math.abs(candle.lowPrice - previousClose),
  );
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
