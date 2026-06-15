import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_GRID_GAP_PCT,
  DEFAULT_GRID_LEVELS,
  DEFAULT_GRID_RATIO,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_MARKET,
  DEFAULT_TOTAL_CAPITAL_KRW,
  DEFAULT_BITHUMB_FEE_RATE,
} from "../../../packages/shared/src/constants";
import type { RecoveryTrailingActivationMode } from "../../../packages/shared/src/types";

export interface GridBotConfig {
  botId: string;
  market: string;
  statePath: string;
  logPath: string;
  loopIntervalMs: number;
  farmingLoopIntervalMs: number;
  maxLoops: number | null;
  totalCapitalKrw: number;
  gridRatio: number;
  gridLevels: number;
  gridGapPct: number;
  feeRate: number;
  mockPrice: number | null;
  enableRealOrders: boolean;
  realOrdersConfirm: string;
  maxRealOrderKrw: number;
  maxRealTotalCapitalKrw: number;
  bithumbAccessKey: string;
  bithumbSecretKey: string;
  enableGridBuy: boolean;
  enableGridSell: boolean;
  enableFarmerConfirmedBuy: boolean;
  farmerLongTrendMode: "strict" | "relaxed";
  farmerMinDailyTurnoverKrw: number;
  farmerMax3dDrawdownPct: number;
  farmerVolatilityNMultiplier: number;
  farmerStage2CooldownDays: number;
  farmerStage3CooldownDays: number;
  farmerUsePriceReachedFilter: boolean;
  farmerUseLongTrendFilter: boolean;
  farmerUseTurnoverRatioFilter: boolean;
  farmerUseMa5TrendFilter: boolean;
  farmerUseClosePositionFilter: boolean;
  farmerUseBullishDailyFilter: boolean;
  farmerUseTwoBullishDailyFilter: boolean;
  farmerUseVolatilityExplosionFilter: boolean;
  farmerAllowFinalCapBuy: boolean;
  farmerMinOrderKrw: number;
  farmerMinDefenseCashAfterBuyKrw: number;
  enableRecoveryTurtleSell: boolean;
  recoveryTurtleNPeriod: number;
  recoveryTurtleLowBreakoutPeriod: number;
  recoveryTurtleNMultiplier: number;
  recoveryTurtleMinOrderKrw: number;
  recoveryUseSliceOrder: boolean;
  recoveryTurtleSliceOrderKrw: number;
  recoveryTurtleSliceIntervalSeconds: number;
  recoveryUse2NTrailExit: boolean;
  recoveryUseMa5Exit: boolean;
  recoveryUseLowBreakoutExit: boolean;
  recoveryTrailingActivationMode: RecoveryTrailingActivationMode;
}

export const REAL_ORDERS_CONFIRM_PHRASE = "I_UNDERSTAND_REAL_BITHUMB_ORDERS";

interface StoredBithumbSettings {
  accessKey?: unknown;
  secretKey?: unknown;
}

function readBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function readNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be numeric. Received: ${raw}`);
  }
  return value;
}

function readOptionalNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be numeric. Received: ${raw}`);
  }
  return value;
}

function readOptionalPositiveInt(name: string): number | null {
  const value = readOptionalNumber(name);
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer. Received: ${value}`);
  }
  return value;
}

function readMode(name: string, defaultValue: "strict" | "relaxed"): "strict" | "relaxed" {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  if (raw === "strict" || raw === "relaxed") return raw;
  throw new Error(`Environment variable ${name} must be "strict" or "relaxed". Received: ${raw}`);
}

function readTrailingActivationMode(name: string, defaultValue: RecoveryTrailingActivationMode): RecoveryTrailingActivationMode {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  if (raw === "PROFIT_POSITIVE" || raw === "TP1" || raw === "TP2") return raw;
  throw new Error(`Environment variable ${name} must be PROFIT_POSITIVE, TP1, or TP2. Received: ${raw}`);
}

function absolutePath(path: string): string {
  return resolve(process.cwd(), path);
}

function readStoredBithumbSettings(): { accessKey: string; secretKey: string } {
  const path = absolutePath(process.env.BITHUMB_SETTINGS_PATH || "data/bithumb_settings.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredBithumbSettings;
    return {
      accessKey: typeof parsed.accessKey === "string" ? parsed.accessKey.trim() : "",
      secretKey: typeof parsed.secretKey === "string" ? parsed.secretKey.trim() : "",
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { accessKey: "", secretKey: "" };
    }
    throw new Error(`Failed to read Bithumb settings file ${path}: ${String(error)}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function loadConfig(): GridBotConfig {
  const botId = process.env.GRID_BOT_ID || "btc-grid-bot";
  const market = process.env.GRID_BOT_MARKET || DEFAULT_MARKET;
  const storedBithumbSettings = readStoredBithumbSettings();
  const mockPrice = readOptionalNumber("GRID_BOT_MOCK_PRICE");
  const enableRealOrders = readBool("ENABLE_REAL_ORDERS", false);
  const totalCapitalKrw = readNumber("GRID_BOT_TOTAL_CAPITAL_KRW", DEFAULT_TOTAL_CAPITAL_KRW);
  const realOrdersConfirm = process.env.REAL_ORDERS_CONFIRM || "";
  const bithumbAccessKey = process.env.BITHUMB_ACCESS_KEY || process.env.API_KEY || storedBithumbSettings.accessKey;
  const bithumbSecretKey = process.env.BITHUMB_SECRET_KEY || process.env.SECRET_KEY || storedBithumbSettings.secretKey;
  const maxRealOrderKrw = readNumber("GRID_BOT_MAX_REAL_ORDER_KRW", 10_000);
  const maxRealTotalCapitalKrw = readNumber("GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW", 1_000_000);

  if (enableRealOrders) {
    validateRealOrderConfig({
      mockPrice,
      totalCapitalKrw,
      maxRealOrderKrw,
      maxRealTotalCapitalKrw,
      realOrdersConfirm,
      bithumbAccessKey,
      bithumbSecretKey,
    });
  }

  return {
    botId,
    market,
    statePath: absolutePath(process.env.GRID_BOT_STATE_PATH || "data/bot_state.json"),
    logPath: absolutePath(process.env.GRID_BOT_LOG_PATH || "data/trading_logs/btc_master_log.jsonl"),
    loopIntervalMs: readNumber("GRID_BOT_LOOP_INTERVAL_MS", DEFAULT_LOOP_INTERVAL_MS),
    farmingLoopIntervalMs: readNumber("GRID_BOT_FARMING_LOOP_INTERVAL_MS", 300_000),
    maxLoops: readOptionalPositiveInt("GRID_BOT_MAX_LOOPS"),
    totalCapitalKrw,
    gridRatio: readNumber("GRID_BOT_GRID_RATIO", DEFAULT_GRID_RATIO),
    gridLevels: readNumber("GRID_BOT_GRID_LEVELS", DEFAULT_GRID_LEVELS),
    gridGapPct: readNumber("GRID_BOT_GRID_GAP_PCT", DEFAULT_GRID_GAP_PCT),
    feeRate: readNumber("GRID_BOT_FEE_RATE", DEFAULT_BITHUMB_FEE_RATE),
    mockPrice,
    enableRealOrders,
    realOrdersConfirm,
    maxRealOrderKrw,
    maxRealTotalCapitalKrw,
    bithumbAccessKey,
    bithumbSecretKey,
    enableGridBuy: readBool("ENABLE_GRID_BUY", false),
    enableGridSell: readBool("ENABLE_GRID_SELL", false),
    enableFarmerConfirmedBuy: readBool("ENABLE_FARMER_CONFIRMED_BUY", false),
    farmerLongTrendMode: readMode("FARMER_LONG_TREND_MODE", "relaxed"),
    farmerMinDailyTurnoverKrw: readNumber("FARMER_MIN_DAILY_TURNOVER_KRW", 0),
    farmerMax3dDrawdownPct: readNumber("FARMER_MAX_3D_DRAWDOWN_PCT", -0.25),
    farmerVolatilityNMultiplier: readNumber("FARMER_VOLATILITY_N_MULTIPLIER", 2),
    farmerStage2CooldownDays: readNumber("FARMER_STAGE2_COOLDOWN_DAYS", 3),
    farmerStage3CooldownDays: readNumber("FARMER_STAGE3_COOLDOWN_DAYS", 5),
    farmerUsePriceReachedFilter: readBool("FARMER_USE_PRICE_REACHED_FILTER", true),
    farmerUseLongTrendFilter: readBool("FARMER_USE_LONG_TREND_FILTER", true),
    farmerUseTurnoverRatioFilter: readBool("FARMER_USE_TURNOVER_RATIO_FILTER", true),
    farmerUseMa5TrendFilter: readBool("FARMER_USE_MA5_TREND_FILTER", true),
    farmerUseClosePositionFilter: readBool("FARMER_USE_CLOSE_POSITION_FILTER", true),
    farmerUseBullishDailyFilter: readBool("FARMER_USE_BULLISH_DAILY_FILTER", true),
    farmerUseTwoBullishDailyFilter: readBool("FARMER_USE_TWO_BULLISH_DAILY_FILTER", true),
    farmerUseVolatilityExplosionFilter: readBool("FARMER_USE_VOLATILITY_EXPLOSION_FILTER", true),
    farmerAllowFinalCapBuy: readBool("FARMER_ALLOW_FINAL_CAP_BUY", true),
    farmerMinOrderKrw: readNumber("FARMER_MIN_ORDER_KRW", 5_000),
    farmerMinDefenseCashAfterBuyKrw: readNumber("FARMER_MIN_DEFENSE_CASH_AFTER_BUY_KRW", 0),
    enableRecoveryTurtleSell: readBool("ENABLE_RECOVERY_TURTLE_SELL", false),
    recoveryTurtleNPeriod: readNumber("RECOVERY_TURTLE_N_PERIOD", 20),
    recoveryTurtleLowBreakoutPeriod: readNumber("RECOVERY_TURTLE_LOW_BREAKOUT_PERIOD", 20),
    recoveryTurtleNMultiplier: readNumber("RECOVERY_TURTLE_N_MULTIPLIER", 2),
    recoveryTurtleMinOrderKrw: readNumber("RECOVERY_TURTLE_MIN_ORDER_KRW", 5_000),
    recoveryUseSliceOrder: readBool("RECOVERY_USE_SLICE_ORDER", true),
    recoveryTurtleSliceOrderKrw: readNumber("RECOVERY_TURTLE_SLICE_ORDER_KRW", 1_000_000),
    recoveryTurtleSliceIntervalSeconds: readNumber("RECOVERY_TURTLE_SLICE_INTERVAL_SECONDS", 10),
    recoveryUse2NTrailExit: readBool("RECOVERY_USE_2N_TRAIL_EXIT", true),
    recoveryUseMa5Exit: readBool("RECOVERY_USE_MA5_EXIT", true),
    recoveryUseLowBreakoutExit: readBool("RECOVERY_USE_LOW_BREAKOUT_EXIT", true),
    recoveryTrailingActivationMode: readTrailingActivationMode("RECOVERY_TRAILING_ACTIVATION_MODE", "TP1"),
  };
}

function validateRealOrderConfig(params: {
  mockPrice: number | null;
  totalCapitalKrw: number;
  maxRealOrderKrw: number;
  maxRealTotalCapitalKrw: number;
  realOrdersConfirm: string;
  bithumbAccessKey: string;
  bithumbSecretKey: string;
}): void {
  if (params.mockPrice != null) {
    throw new Error("Real orders cannot run with GRID_BOT_MOCK_PRICE. Unset it before live trading.");
  }
  if (params.bithumbAccessKey.length === 0 || params.bithumbSecretKey.length === 0) {
    throw new Error("Real orders require BITHUMB_ACCESS_KEY and BITHUMB_SECRET_KEY.");
  }
  if (params.realOrdersConfirm !== REAL_ORDERS_CONFIRM_PHRASE) {
    throw new Error(`Real orders require REAL_ORDERS_CONFIRM=${REAL_ORDERS_CONFIRM_PHRASE}.`);
  }
  if (params.maxRealOrderKrw <= 0 || params.maxRealTotalCapitalKrw <= 0) {
    throw new Error("GRID_BOT_MAX_REAL_ORDER_KRW and GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW must be positive.");
  }
  if (params.totalCapitalKrw > params.maxRealTotalCapitalKrw) {
    throw new Error(
      `GRID_BOT_TOTAL_CAPITAL_KRW=${params.totalCapitalKrw} exceeds GRID_BOT_MAX_REAL_TOTAL_CAPITAL_KRW=${params.maxRealTotalCapitalKrw}.`,
    );
  }
}
