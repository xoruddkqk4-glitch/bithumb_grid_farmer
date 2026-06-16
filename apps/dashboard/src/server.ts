import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_BITHUMB_FEE_RATE,
  DEFAULT_FARMER_ENTRY_PCT,
  DEFAULT_GRID_RATIO,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_MARKET,
} from "../../../packages/shared/src/constants";
import {
  buildDefaultGridLevelSettings,
  calculateGridSizing,
  generateGridLayers,
  normalizeGridLevelSetting,
  roundKrw,
} from "../../../packages/shared/src";
import { reconcileBotState } from "../../../packages/shared/src/reconciliation";
import { BithumbPrivateClient, BithumbPublicClient } from "../../grid-bot/src/bithumb/bithumb-client";
import { loadConfig } from "../../grid-bot/src/config";
import { PaperOrderExecutor } from "../../grid-bot/src/orders/paper-executor";
import { RealOrderExecutor, selectOrderExecutor } from "../../grid-bot/src/orders/order-executor";
import { JsonlTradeLogger } from "../../grid-bot/src/storage/logger";
import type {
  BotState,
  GridLayer,
  GridLevelSetting,
  OrderExecution,
  RecoveryExitSignalState,
  RecoveryTrailingActivationMode,
  TradeLogRecord,
} from "../../../packages/shared/src/types";

interface DashboardSummary {
  generatedAt: string;
  state: BotState | null;
  recentTrades: TradeLogRecord[];
  botLogLines: string[];
  layerPerformance: Record<number, ProfitSummary>;
  dailyPnl: DailyPnlRecord[];
  totals: {
    waitingLayers: number;
    openLayers: number;
    soldLayers: number;
    buyCount: number;
    sellCount: number;
    realizedPnlKrw: number;
    realizedPnlPct: number | null;
    todayRealizedPnlKrw: number;
    todayRealizedPnlPct: number | null;
    holdingCostKrw: number;
    holdingValueKrw: number;
    holdingPnlKrw: number;
    holdingPnlPct: number | null;
  };
  files: {
    statePath: string;
    logPath: string;
    botOutLogPath: string;
  };
  warnings: string[];
}

interface ProfitSummary {
  realizedPnlKrw: number;
  costBasisKrw: number;
  realizedPnlPct: number | null;
}

interface DailyPnlRecord {
  date: string;
  pnlKrw: number;
  cumulativePnlKrw: number;
}

interface ViewOptions {
  calendarMode: "day" | "month" | "year";
  calendarCursor: string;
  chartFrom: string;
  chartTo: string;
  chartUnit: "day" | "week" | "month" | "quarter" | "half" | "year";
}

const port = readNumber("DASHBOARD_PORT", 3000);
const host = process.env.DASHBOARD_HOST || "0.0.0.0";
const statePath = absolutePath(process.env.DASHBOARD_STATE_PATH || "data/bot_state.json");
const logPath = absolutePath(
  process.env.DASHBOARD_TRADE_LOG_PATH || "data/trading_logs/btc_master_log.jsonl",
);
const botOutLogPath =
  process.env.DASHBOARD_BOT_OUT_LOG_PATH ||
  `${process.env.HOME || "/home/ec2-user"}/.pm2/logs/bithumb-grid-bot-paper-out.log`;
const telegramSettingsPath = absolutePath(process.env.TELEGRAM_SETTINGS_PATH || "data/telegram_settings.json");
const bithumbSettingsPath = absolutePath(process.env.BITHUMB_SETTINGS_PATH || "data/bithumb_settings.json");
const backtestReportsPath = absolutePath(process.env.BACKTEST_REPORTS_PATH || "data/backtests/reports");
const backtestScriptPath = absolutePath(process.env.BACKTEST_SCRIPT_PATH || "scripts/backtest-btc-daily.cjs");
const authUser = process.env.DASHBOARD_AUTH_USER || "admin";
const authPassword = process.env.DASHBOARD_AUTH_PASSWORD || "";
const DEFAULT_FARMER_MAX_3D_DRAWDOWN_PCT = -0.25;
const DEFAULT_FARMER_STAGE2_COOLDOWN_DAYS = 3;
const DEFAULT_FARMER_STAGE3_COOLDOWN_DAYS = 5;
const DEFAULT_FARMER_USE_PRICE_REACHED_FILTER = true;
const DEFAULT_FARMER_USE_LONG_TREND_FILTER = true;
const DEFAULT_FARMER_USE_TURNOVER_RATIO_FILTER = true;
const DEFAULT_FARMER_USE_MA5_TREND_FILTER = true;
const DEFAULT_FARMER_USE_CLOSE_POSITION_FILTER = true;
const DEFAULT_FARMER_USE_BULLISH_DAILY_FILTER = true;
const DEFAULT_FARMER_USE_TWO_BULLISH_DAILY_FILTER = true;
const DEFAULT_FARMER_USE_VOLATILITY_EXPLOSION_FILTER = true;
const DEFAULT_RECOVERY_TURTLE_N_PERIOD = 20;
const DEFAULT_RECOVERY_TURTLE_LOW_BREAKOUT_PERIOD = 20;
const DEFAULT_RECOVERY_TURTLE_N_MULTIPLIER = 2;
const DEFAULT_RECOVERY_TURTLE_MIN_ORDER_KRW = 5_000;
const DEFAULT_RECOVERY_USE_SLICE_ORDER = true;
const DEFAULT_RECOVERY_TURTLE_SLICE_ORDER_KRW = 1_000_000;
const DEFAULT_RECOVERY_TURTLE_SLICE_INTERVAL_SECONDS = 10;
const DEFAULT_RECOVERY_USE_2N_TRAIL_EXIT = true;
const DEFAULT_RECOVERY_USE_MA5_EXIT = true;
const DEFAULT_RECOVERY_USE_LOW_BREAKOUT_EXIT = true;
const DEFAULT_RECOVERY_TRAILING_ACTIVATION_MODE: RecoveryTrailingActivationMode = "TP1";
const DEFAULT_FARMING_LOOP_INTERVAL_MS = 300_000;
const DEFAULT_PARTIAL_TAKE_PROFIT_ENABLED = false;
const DEFAULT_TP1_RETURN_PCT = 0.1;
const DEFAULT_TP1_SELL_RATIO = 0.33;
const DEFAULT_TP2_RETURN_PCT = 0.2;
const DEFAULT_TP2_SELL_RATIO = 0.33;
const BITHUMB_LIVE_TEST_ORDER_KRW = 10_000;
const DEFAULT_TELEGRAM_GRID_BUY_NOTIFICATION_MODE = "batch";
const DEFAULT_TELEGRAM_GRID_SELL_NOTIFICATION_MODE = "immediate";
const DEFAULT_TELEGRAM_GRID_BATCH_SIZE = 10;

type TelegramGridNotificationMode = "off" | "immediate" | "batch";

interface TelegramSettings {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  gridBuyNotificationMode?: TelegramGridNotificationMode;
  gridSellNotificationMode?: TelegramGridNotificationMode;
  gridBatchSize?: number;
  updatedAt: string;
}

interface BithumbCredentialSettings {
  accessKey?: string;
  secretKey?: string;
  lastLiveTestBuy?: BithumbLiveTestBuyRecord;
  updatedAt: string;
}

interface BithumbLiveTestBuyRecord {
  market: string;
  qty: number;
  amountKrw: number;
  price: number;
  orderId: string;
  executedAt: string;
}

interface PeriodWindow {
  start: Date;
  end: Date;
}

function absolutePath(path: string): string {
  return resolve(process.cwd(), path);
}

function readNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer. Received: ${raw}`);
  }
  return value;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readJsonlRecords<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readTextTail(path: string, maxRows: number): Promise<string[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-maxRows);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
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

async function buildSummary(): Promise<DashboardSummary> {
  const warnings: string[] = [];
  const state = await readJsonFile<BotState>(statePath);
  const allTrades = await readJsonlRecords<TradeLogRecord>(logPath);
  const cycleTrades = state == null ? allTrades : allTrades.filter((trade) => trade.cycleId === state.cycleId);
  const recentTrades = cycleTrades.slice(-10).reverse();
  const botLogLines = await readTextTail(botOutLogPath, 3);
  const layerPerformance = calculateLayerPerformance(allTrades);
  const totalPerformance = calculateRealizedPerformance(allTrades);
  const todayPerformance = calculatePeriodPerformance(allTrades, getCurrentTradingDayWindow());
  const dailyPnl = calculateDailyPnl(allTrades);
  const tradeCounts = countTradeActions(allTrades, state?.cycleId ?? null);

  if (state == null) {
    warnings.push("State file does not exist yet. Start the grid bot first.");
  } else {
    for (const warning of reconcileBotState(state).warnings) {
      warnings.push(`State check: ${warning}`);
    }
  }
  const layers = state?.layers ?? [];
  const holdingSummary = calculateHoldingSummary(layers, state?.lastPrice ?? null);
  return {
    generatedAt: new Date().toISOString(),
    state,
    recentTrades,
    botLogLines,
    layerPerformance,
    dailyPnl,
    totals: {
      waitingLayers: countLayers(layers, "WAITING"),
      openLayers: countLayers(layers, "OPEN"),
      soldLayers: countLayers(layers, "SOLD"),
      buyCount: tradeCounts.buys,
      sellCount: tradeCounts.sells,
      realizedPnlKrw: totalPerformance.realizedPnlKrw,
      realizedPnlPct: totalPerformance.realizedPnlPct,
      todayRealizedPnlKrw: todayPerformance.realizedPnlKrw,
      todayRealizedPnlPct: todayPerformance.realizedPnlPct,
      holdingCostKrw: holdingSummary.costKrw,
      holdingValueKrw: holdingSummary.valueKrw,
      holdingPnlKrw: holdingSummary.pnlKrw,
      holdingPnlPct: holdingSummary.pnlPct,
    },
    files: { statePath, logPath, botOutLogPath },
    warnings,
  };
}

function countLayers(layers: GridLayer[], status: GridLayer["status"]): number {
  if (status === "OPEN") {
    return layers.filter((layer) => layer.status === "OPEN" && layer.qty > 0).length;
  }
  return layers.filter((layer) => layer.status === status).length;
}

function countTradeActions(trades: TradeLogRecord[], cycleId: string | null): { buys: number; sells: number } {
  return trades.reduce(
    (counts, trade) => {
      if (cycleId != null && trade.cycleId !== cycleId) {
        return counts;
      }
      if (trade.action === "GRID_BUY" || trade.action === "FARMER_BUY" || String(trade.action) === "GRID_REBUY") {
        counts.buys += 1;
      }
      if (isRealizedSellAction(trade.action)) {
        counts.sells += 1;
      }
      return counts;
    },
    { buys: 0, sells: 0 },
  );
}

function isRealizedSellAction(action: TradeLogRecord["action"] | string): boolean {
  return action === "GRID_SELL" || action === "RECOVERY_SELL";
}

function calculateLayerPerformance(trades: TradeLogRecord[]): Record<number, ProfitSummary> {
  const byStage: Record<number, ProfitSummary> = {};
  for (const trade of trades) {
    if (trade.action !== "GRID_SELL" || trade.stage == null || trade.realizedPnlKrw == null) {
      continue;
    }
    const feeKrw = trade.feeKrw ?? 0;
    const amountKrw = trade.amountKrw ?? 0;
    const costBasisKrw = Math.max(0, amountKrw - feeKrw - trade.realizedPnlKrw);
    const current = byStage[trade.stage] ?? { realizedPnlKrw: 0, costBasisKrw: 0, realizedPnlPct: null };
    current.realizedPnlKrw += trade.realizedPnlKrw;
    current.costBasisKrw += costBasisKrw;
    current.realizedPnlPct = calculatePnlPct(current.realizedPnlKrw, current.costBasisKrw);
    byStage[trade.stage] = current;
  }
  return byStage;
}

function sumProfitSummaries(summaries: ProfitSummary[]): ProfitSummary {
  const total = summaries.reduce(
    (acc, summary) => ({
      realizedPnlKrw: acc.realizedPnlKrw + summary.realizedPnlKrw,
      costBasisKrw: acc.costBasisKrw + summary.costBasisKrw,
      realizedPnlPct: null,
    }),
    { realizedPnlKrw: 0, costBasisKrw: 0, realizedPnlPct: null } satisfies ProfitSummary,
  );
  return {
    ...total,
    realizedPnlPct: calculatePnlPct(total.realizedPnlKrw, total.costBasisKrw),
  };
}

function calculateRealizedPerformance(trades: TradeLogRecord[]): ProfitSummary {
  const summary: ProfitSummary = { realizedPnlKrw: 0, costBasisKrw: 0, realizedPnlPct: null };
  for (const trade of trades) {
    if (!isRealizedSellAction(trade.action) || trade.realizedPnlKrw == null) {
      continue;
    }
    const feeKrw = trade.feeKrw ?? 0;
    const amountKrw = trade.amountKrw ?? 0;
    summary.realizedPnlKrw += trade.realizedPnlKrw;
    summary.costBasisKrw += Math.max(0, amountKrw - feeKrw - trade.realizedPnlKrw);
  }
  return {
    ...summary,
    realizedPnlPct: calculatePnlPct(summary.realizedPnlKrw, summary.costBasisKrw),
  };
}

function calculatePeriodPerformance(trades: TradeLogRecord[], window: PeriodWindow): ProfitSummary {
  const summary: ProfitSummary = { realizedPnlKrw: 0, costBasisKrw: 0, realizedPnlPct: null };
  for (const trade of trades) {
    const timestamp = new Date(trade.timestamp).getTime();
    if (
      !isRealizedSellAction(trade.action) ||
      trade.realizedPnlKrw == null ||
      timestamp < window.start.getTime() ||
      timestamp > window.end.getTime()
    ) {
      continue;
    }
    const feeKrw = trade.feeKrw ?? 0;
    const amountKrw = trade.amountKrw ?? 0;
    summary.realizedPnlKrw += trade.realizedPnlKrw;
    summary.costBasisKrw += Math.max(0, amountKrw - feeKrw - trade.realizedPnlKrw);
  }
  return {
    ...summary,
    realizedPnlPct: calculatePnlPct(summary.realizedPnlKrw, summary.costBasisKrw),
  };
}

function calculatePnlPct(realizedPnlKrw: number, costBasisKrw: number): number | null {
  return costBasisKrw > 0 ? (realizedPnlKrw / costBasisKrw) * 100 : null;
}

function calculateTradeRealizedPnlPct(trade: TradeLogRecord): number | null {
  if (!isRealizedSellAction(trade.action) || trade.realizedPnlKrw == null) {
    return null;
  }
  const proceedsKrw = trade.amountKrw ?? 0;
  const feeKrw = trade.feeKrw ?? 0;
  const costBasisKrw = Math.max(0, proceedsKrw - feeKrw - trade.realizedPnlKrw);
  return calculatePnlPct(trade.realizedPnlKrw, costBasisKrw);
}

function calculateGridLayerCostBasisKrw(layer: GridLayer): number {
  if (layer.qty > 0 && layer.buyPrice > 0) {
    return layer.buyPrice * layer.qty;
  }
  return layer.amountKrw;
}

function calculateHoldingSummary(
  layers: GridLayer[],
  lastPrice: number | null,
): { costKrw: number; valueKrw: number; pnlKrw: number; pnlPct: number | null } {
  const openLayers = layers.filter((layer) => layer.status === "OPEN" && layer.qty > 0);
  const costKrw = openLayers.reduce((sum, layer) => sum + calculateGridLayerCostBasisKrw(layer), 0);
  const valueKrw = lastPrice == null ? 0 : openLayers.reduce((sum, layer) => sum + layer.qty * lastPrice, 0);
  const pnlKrw = valueKrw - costKrw;
  return {
    costKrw: Math.round(costKrw),
    valueKrw: Math.round(valueKrw),
    pnlKrw: Math.round(pnlKrw),
    pnlPct: calculatePnlPct(pnlKrw, costKrw),
  };
}

function calculateDailyPnl(trades: TradeLogRecord[]): DailyPnlRecord[] {
  const byDate = new Map<string, number>();
  for (const trade of trades) {
    if (!isRealizedSellAction(trade.action) || trade.realizedPnlKrw == null) continue;
    const date = formatIsoDateInSeoul(trade.timestamp);
    byDate.set(date, (byDate.get(date) ?? 0) + trade.realizedPnlKrw);
  }

  let cumulativePnlKrw = 0;
  return Array.from(byDate.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, pnlKrw]) => {
      cumulativePnlKrw += pnlKrw;
      return { date, pnlKrw, cumulativePnlKrw };
    });
}

function formatIsoDateInSeoul(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function getCurrentTradingDayWindow(): PeriodWindow {
  const now = new Date();
  const seoulParts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).formatToParts(now);
  const readPart = (type: string): number => Number(seoulParts.find((part) => part.type === type)?.value ?? "0");
  const year = readPart("year");
  const month = readPart("month");
  const day = readPart("day");
  const start = new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

function formatKrw(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${Math.round(value).toLocaleString("ko-KR")} KRW`;
}

function formatCompactKrw(value: number): string {
  const abs = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs).toLocaleString("ko-KR")}`;
}

function formatManwon(value: number): string {
  const scaled = value / 10_000;
  const rounded = Math.round(scaled * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}`;
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function formatPhaseKo(value: string | null | undefined): string {
  if (value === "GRID") return "그리드";
  if (value === "FARMING") return "농부 매수";
  if (value === "HOLDING") return "보유";
  if (value === "COOLDOWN") return "쿨다운";
  return value ?? "-";
}

function formatLayerStatusKo(value: string | null | undefined): string {
  if (value === "WAITING") return "대기";
  if (value === "OPEN") return "보유";
  if (value === "SOLD") return "대기";
  return value ?? "-";
}

function formatTradeActionKo(value: string | null | undefined): string {
  if (value === "GRID_BUY") return "그리드 매수";
  if (value === "GRID_SELL") return "그리드 매도";
  if (value === "FARMER_BUY") return "농부 매수";
  if (value === "FARMER_SIGNAL") return "농부 신호";
  if (value === "RECOVERY_EXIT_SIGNAL") return "회복 매도 신호";
  if (value === "RECOVERY_SELL") return "회복 매도";
  if (value === "PHASE_CHANGE") return "단계 전환";
  if (value === "BOT_ERROR") return "봇 오류";
  return value ?? "-";
}

function formatRecoveryExitStatusKo(signal: RecoveryExitSignalState | null): string {
  if (signal == null) return "-";
  if (signal.triggered) return `매도 준비 ${formatRecoveryReasonKo(signal.reason)}`.trim();
  if (signal.blockedReasons.length > 0) return signal.blockedReasons.map(formatRecoveryReasonKo).join(", ");
  return "감시 중";
}

function formatRecoveryReasonKo(value: string | null | undefined): string {
  if (value === "2N_TRAIL") return "2N 트레일링 이탈";
  if (value === "MA5_EXIT") return "MA5 이탈";
  if (value === "N_DAY_LOW_BREAK") return "N일 최저가 이탈";
  if (value === "PROFIT_GATE_BLOCKED") return "수익 게이트 미충족";
  return value ?? "-";
}

function pnlToneClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? "tone-profit" : "tone-loss";
}

function okToneClass(value: boolean | null | undefined): string {
  return value === true ? "tone-ok" : "";
}

function enabledToneClass(enabled: boolean): string {
  return enabled ? "" : "tone-disabled";
}

function formatNumberInput(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(Math.round(value));
}

function inferGridGapPct(state: BotState | null): number | null {
  if (state == null || state.gridEntryPrice == null || state.layers.length === 0) return null;
  const firstLayer = state.layers.find((layer) => layer.idx === 1);
  if (firstLayer == null) return null;
  return (state.gridEntryPrice - firstLayer.buyPrice) / state.gridEntryPrice;
}

function getLastGridBuyPrice(state: BotState | null): number | null {
  if (state == null || state.layers.length === 0) return null;
  const lastLayer =
    [...state.layers]
      .filter((layer) => layer.qty > 0 || layer.status === "OPEN")
      .sort((left, right) => right.idx - left.idx)[0] ??
    [...state.layers].sort((left, right) => right.idx - left.idx)[0] ??
    null;
  if (lastLayer == null) return null;
  if (lastLayer.qty > 0 && lastLayer.amountKrw > 0) {
    return lastLayer.amountKrw / lastLayer.qty;
  }
  return lastLayer.buyPrice > 0 ? lastLayer.buyPrice : null;
}

function getFarmerLastBuyPrice(state: BotState | null): number | null {
  if (state == null) return null;
  if (state.farmerStage === 0) {
    return state.farmerAnchorPrice ?? getLastGridBuyPrice(state);
  }
  return state.farmerAnchorPrice ?? state.farmerLastBuyPrice ?? null;
}

function getNextFarmerEntryPrice(state: BotState | null, farmerEntryPct: number): number | null {
  if (state == null) return null;
  if (state.farmerStage >= (state.maxFarmerStages ?? 3)) return null;
  const lastBuyPrice = getFarmerLastBuyPrice(state);
  if (lastBuyPrice == null) return null;
  return lastBuyPrice * (1 - farmerEntryPct);
}

function formatDate(value: string | null | undefined): string {
  if (value == null) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isAuthEnabled(): boolean {
  return authPassword.length > 0;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function isAuthorized(request: import("node:http").IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;

  const header = request.headers.authorization;
  const rawHeader = Array.isArray(header) ? header[0] : header;
  if (rawHeader == null || !rawHeader.startsWith("Basic ")) return false;

  const decoded = Buffer.from(rawHeader.slice("Basic ".length), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) return false;

  const user = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return constantTimeEqual(user, authUser) && constantTimeEqual(password, authPassword);
}

function requestAuth(response: import("node:http").ServerResponse): void {
  response.statusCode = 401;
  response.setHeader("www-authenticate", 'Basic realm="Bithumb Grid Farmer", charset="UTF-8"');
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end("Authentication required");
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  return await new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 80_000) {
        rejectBody(new Error("Request body is too large."));
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.dashboard.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.dashboard.tmp`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, path);
}

function parseGridSettingsBody(body: string, totalCapitalKrw: number): {
  gapPct: number;
  orderAmountKrw: number;
  gridInvestmentKrw: number;
  gridLevels: number;
  gridLevelSettings: GridLevelSetting[];
  maxFarmerStages: number;
  farmerEntryPct: number;
  farmerMax3dDrawdownPct: number;
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
  gridLoopIntervalMs: number;
  farmingLoopIntervalMs: number;
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
  partialTakeProfitEnabled: boolean;
  takeProfit1ReturnPct: number;
  takeProfit1SellRatio: number;
  takeProfit2ReturnPct: number;
  takeProfit2SellRatio: number;
} {
  const parsed = JSON.parse(body) as {
    gapPct?: unknown;
    gridLevels?: unknown;
    gridLevelSettings?: unknown;
    maxFarmerStages?: unknown;
    farmerEntryPct?: unknown;
    farmerMax3dDrawdownPct?: unknown;
    farmerStage2CooldownDays?: unknown;
    farmerStage3CooldownDays?: unknown;
    farmerUsePriceReachedFilter?: unknown;
    farmerUseLongTrendFilter?: unknown;
    farmerUseTurnoverRatioFilter?: unknown;
    farmerUseMa5TrendFilter?: unknown;
    farmerUseClosePositionFilter?: unknown;
    farmerUseBullishDailyFilter?: unknown;
    farmerUseTwoBullishDailyFilter?: unknown;
    farmerUseVolatilityExplosionFilter?: unknown;
    gridLoopIntervalMs?: unknown;
    farmingLoopIntervalMs?: unknown;
    enableRecoveryTurtleSell?: unknown;
    recoveryTurtleNPeriod?: unknown;
    recoveryTurtleLowBreakoutPeriod?: unknown;
    recoveryTurtleNMultiplier?: unknown;
    recoveryTurtleMinOrderKrw?: unknown;
    recoveryUseSliceOrder?: unknown;
    recoveryTurtleSliceOrderKrw?: unknown;
    recoveryTurtleSliceIntervalSeconds?: unknown;
    recoveryUse2NTrailExit?: unknown;
    recoveryUseMa5Exit?: unknown;
    recoveryUseLowBreakoutExit?: unknown;
    recoveryTrailingActivationMode?: unknown;
    partialTakeProfitEnabled?: unknown;
    takeProfit1ReturnPct?: unknown;
    takeProfit1SellRatio?: unknown;
    takeProfit2ReturnPct?: unknown;
    takeProfit2SellRatio?: unknown;
  };
  const gapPct = Number(parsed.gapPct);
  const gridLevels = Number(parsed.gridLevels);
  const maxFarmerStages = Number(parsed.maxFarmerStages);
  const farmerEntryPct = Number(parsed.farmerEntryPct);
  const farmerMax3dDrawdownPct = Number(parsed.farmerMax3dDrawdownPct);
  const farmerStage2CooldownDays = Number(parsed.farmerStage2CooldownDays);
  const farmerStage3CooldownDays = Number(parsed.farmerStage3CooldownDays);
  const farmerUsePriceReachedFilter = parsed.farmerUsePriceReachedFilter === true;
  const farmerUseLongTrendFilter = parsed.farmerUseLongTrendFilter === true;
  const farmerUseTurnoverRatioFilter = parsed.farmerUseTurnoverRatioFilter === true;
  const farmerUseMa5TrendFilter = parsed.farmerUseMa5TrendFilter === true;
  const farmerUseClosePositionFilter = parsed.farmerUseClosePositionFilter === true;
  const farmerUseBullishDailyFilter = parsed.farmerUseBullishDailyFilter === true;
  const farmerUseTwoBullishDailyFilter = parsed.farmerUseTwoBullishDailyFilter === true;
  const farmerUseVolatilityExplosionFilter = parsed.farmerUseVolatilityExplosionFilter === true;
  const gridLoopIntervalMs = Number(parsed.gridLoopIntervalMs);
  const farmingLoopIntervalMs = Number(parsed.farmingLoopIntervalMs);
  const enableRecoveryTurtleSell = parsed.enableRecoveryTurtleSell === true;
  const recoveryTurtleNPeriod = Number(parsed.recoveryTurtleNPeriod);
  const recoveryTurtleLowBreakoutPeriod = Number(parsed.recoveryTurtleLowBreakoutPeriod);
  const recoveryTurtleNMultiplier = Number(parsed.recoveryTurtleNMultiplier);
  const recoveryTurtleMinOrderKrw = Number(parsed.recoveryTurtleMinOrderKrw);
  const recoveryUseSliceOrder = parsed.recoveryUseSliceOrder === true;
  const recoveryTurtleSliceOrderKrw = Number(parsed.recoveryTurtleSliceOrderKrw);
  const recoveryTurtleSliceIntervalSeconds = Number(parsed.recoveryTurtleSliceIntervalSeconds);
  const recoveryUse2NTrailExit = parsed.recoveryUse2NTrailExit === true;
  const recoveryUseMa5Exit = parsed.recoveryUseMa5Exit === true;
  const recoveryUseLowBreakoutExit = parsed.recoveryUseLowBreakoutExit === true;
  const recoveryTrailingActivationMode = parseRecoveryTrailingActivationMode(parsed.recoveryTrailingActivationMode);
  const partialTakeProfitEnabled = parsed.partialTakeProfitEnabled === true;
  const takeProfit1ReturnPct = Number(parsed.takeProfit1ReturnPct);
  const takeProfit1SellRatio = Number(parsed.takeProfit1SellRatio);
  const takeProfit2ReturnPct = Number(parsed.takeProfit2ReturnPct);
  const takeProfit2SellRatio = Number(parsed.takeProfit2SellRatio);

  if (!Number.isFinite(gapPct) || gapPct < 0.001 || gapPct > 0.2) {
    throw new Error("Gap percent must be between 0.1% and 20%.");
  }
  if (!Number.isInteger(gridLevels) || gridLevels < 1 || gridLevels > 100) {
    throw new Error("Grid levels must be an integer between 1 and 100.");
  }
  const gridLevelSettings = parseGridLevelSettings(parsed.gridLevelSettings, gridLevels, gapPct);
  const gridSizing = calculateGridSizing({
    totalCapitalKrw,
    gridRatio: DEFAULT_GRID_RATIO,
    levels: gridLevels,
    levelSettings: gridLevelSettings,
  });
  const orderAmountKrw = gridSizing.orderAmountKrw;
  if (!Number.isFinite(orderAmountKrw) || orderAmountKrw < 5_000) {
    throw new Error("Calculated order amount must be at least 5,000 KRW. Increase account capital or reduce grid levels.");
  }
  if (!Number.isInteger(maxFarmerStages) || maxFarmerStages < 0 || maxFarmerStages > 10) {
    throw new Error("Farmer stages must be an integer between 0 and 10.");
  }
  if (!Number.isFinite(farmerEntryPct) || farmerEntryPct < 0.01 || farmerEntryPct > 0.9) {
    throw new Error("Farmer entry percent must be between 1% and 90%.");
  }
  if (!Number.isFinite(farmerMax3dDrawdownPct) || farmerMax3dDrawdownPct > -0.01 || farmerMax3dDrawdownPct < -0.9) {
    throw new Error("Farmer max 3-day drawdown must be between -1% and -90%.");
  }
  if (!Number.isInteger(farmerStage2CooldownDays) || farmerStage2CooldownDays < 0 || farmerStage2CooldownDays > 365) {
    throw new Error("Farmer stage 2 cooldown days must be an integer between 0 and 365.");
  }
  if (!Number.isInteger(farmerStage3CooldownDays) || farmerStage3CooldownDays < 0 || farmerStage3CooldownDays > 365) {
    throw new Error("Farmer stage 3 cooldown days must be an integer between 0 and 365.");
  }
  if (!Number.isInteger(gridLoopIntervalMs) || gridLoopIntervalMs < 1_000 || gridLoopIntervalMs > 86_400_000) {
    throw new Error("Grid loop interval must be an integer between 1 second and 24 hours.");
  }
  if (!Number.isInteger(farmingLoopIntervalMs) || farmingLoopIntervalMs < 10_000 || farmingLoopIntervalMs > 86_400_000) {
    throw new Error("Farming loop interval must be an integer between 10 seconds and 24 hours.");
  }
  if (!Number.isInteger(recoveryTurtleNPeriod) || recoveryTurtleNPeriod < 5 || recoveryTurtleNPeriod > 100) {
    throw new Error("Turtle N period must be an integer between 5 and 100.");
  }
  if (
    !Number.isInteger(recoveryTurtleLowBreakoutPeriod) ||
    recoveryTurtleLowBreakoutPeriod < 5 ||
    recoveryTurtleLowBreakoutPeriod > 200
  ) {
    throw new Error("Turtle low breakout period must be an integer between 5 and 200.");
  }
  if (!Number.isFinite(recoveryTurtleNMultiplier) || recoveryTurtleNMultiplier < 0.5 || recoveryTurtleNMultiplier > 10) {
    throw new Error("Trailing N multiplier must be between 0.5 and 10.");
  }
  if (!Number.isFinite(recoveryTurtleMinOrderKrw) || recoveryTurtleMinOrderKrw < 5_000) {
    throw new Error("Turtle minimum order must be at least 5,000 KRW.");
  }
  if (!Number.isFinite(recoveryTurtleSliceOrderKrw) || recoveryTurtleSliceOrderKrw < 5_000) {
    throw new Error("Slice order must be at least 5,000 KRW.");
  }
  if (
    !Number.isInteger(recoveryTurtleSliceIntervalSeconds) ||
    recoveryTurtleSliceIntervalSeconds < 0 ||
    recoveryTurtleSliceIntervalSeconds > 3600
  ) {
    throw new Error("Slice interval seconds must be an integer between 0 and 3600.");
  }
  if (!Number.isFinite(takeProfit1ReturnPct) || takeProfit1ReturnPct < 0.01 || takeProfit1ReturnPct > 10) {
    throw new Error("TP1 return must be between 1% and 1000%.");
  }
  if (!Number.isFinite(takeProfit2ReturnPct) || takeProfit2ReturnPct < 0.01 || takeProfit2ReturnPct > 10) {
    throw new Error("TP2 return must be between 1% and 1000%.");
  }
  if (!Number.isFinite(takeProfit1SellRatio) || takeProfit1SellRatio < 0.01 || takeProfit1SellRatio > 1) {
    throw new Error("TP1 sell ratio must be between 1% and 100%.");
  }
  if (!Number.isFinite(takeProfit2SellRatio) || takeProfit2SellRatio < 0.01 || takeProfit2SellRatio > 1) {
    throw new Error("TP2 sell ratio must be between 1% and 100%.");
  }
  if (takeProfit1ReturnPct >= takeProfit2ReturnPct) {
    throw new Error("TP2 return must be higher than TP1 return.");
  }
  if (takeProfit1SellRatio + takeProfit2SellRatio > 1) {
    throw new Error("TP1 and TP2 sell ratios cannot exceed 100% combined.");
  }

  return {
    gapPct,
    orderAmountKrw: Math.round(orderAmountKrw),
    gridInvestmentKrw: gridSizing.gridInvestmentKrw,
    gridLevels,
    gridLevelSettings,
    maxFarmerStages,
    farmerEntryPct,
    farmerMax3dDrawdownPct,
    farmerStage2CooldownDays,
    farmerStage3CooldownDays,
    farmerUsePriceReachedFilter,
    farmerUseLongTrendFilter,
    farmerUseTurnoverRatioFilter,
    farmerUseMa5TrendFilter,
    farmerUseClosePositionFilter,
    farmerUseBullishDailyFilter,
    farmerUseTwoBullishDailyFilter,
    farmerUseVolatilityExplosionFilter,
    gridLoopIntervalMs,
    farmingLoopIntervalMs,
    enableRecoveryTurtleSell,
    recoveryTurtleNPeriod,
    recoveryTurtleLowBreakoutPeriod,
    recoveryTurtleNMultiplier,
    recoveryTurtleMinOrderKrw: Math.round(recoveryTurtleMinOrderKrw),
    recoveryUseSliceOrder,
    recoveryTurtleSliceOrderKrw: Math.round(recoveryTurtleSliceOrderKrw),
    recoveryTurtleSliceIntervalSeconds,
    recoveryUse2NTrailExit,
    recoveryUseMa5Exit,
    recoveryUseLowBreakoutExit,
    recoveryTrailingActivationMode,
    partialTakeProfitEnabled,
    takeProfit1ReturnPct,
    takeProfit1SellRatio,
    takeProfit2ReturnPct,
    takeProfit2SellRatio,
  };
}

function parseRecoveryTrailingActivationMode(value: unknown): RecoveryTrailingActivationMode {
  if (value === "PROFIT_POSITIVE" || value === "TP1" || value === "TP2") {
    return value;
  }
  throw new Error("2N trailing activation mode must be PROFIT_POSITIVE, TP1, or TP2.");
}

function parseGridLevelSettings(value: unknown, levels: number, fallbackGapPct: number): GridLevelSetting[] {
  const rawSettings = Array.isArray(value) ? value : [];
  return Array.from({ length: levels }, (_, index) => {
    const level = index + 1;
    const raw = rawSettings.find(
      (setting) =>
        typeof setting === "object" &&
        setting != null &&
        Number((setting as { level?: unknown }).level) === level,
    ) as Partial<GridLevelSetting> | undefined;
    const normalized = normalizeGridLevelSetting(raw, level, fallbackGapPct);
    if (normalized.buyGapPct < 0.001 || normalized.buyGapPct > 0.2) {
      throw new Error(`Grid level ${level} buy gap must be between 0.1% and 20%.`);
    }
    if (normalized.buyAmountMultiplier < 0.01 || normalized.buyAmountMultiplier > 100) {
      throw new Error(`Grid level ${level} buy amount multiplier must be between 0.01x and 100x.`);
    }
    if (normalized.takeProfitPct < 0.001 || normalized.takeProfitPct > 1) {
      throw new Error(`Grid level ${level} take profit must be between 0.1% and 100%.`);
    }
    if (normalized.trailingPullbackPct < 0 || normalized.trailingPullbackPct > 0.2) {
      throw new Error(`Grid level ${level} trailing pullback must be between 0% and 20%.`);
    }
    return normalized;
  });
}

function getGridLevelSettings(state: BotState | null, levels: number, fallbackGapPct: number): GridLevelSetting[] {
  if (state == null) return buildDefaultGridLevelSettings(levels, fallbackGapPct);
  const existingSettings = state?.gridLevelSettings;
  return Array.from({ length: levels }, (_, index) => {
    const level = index + 1;
    const configured = existingSettings?.find((setting) => setting.level === level);
    const layer = state?.layers.find((item) => item.idx === level);
    const derived: Partial<GridLevelSetting> = { level };
    if (layer?.buyGapPct != null) derived.buyGapPct = layer.buyGapPct;
    if (layer?.buyAmountMultiplier != null) derived.buyAmountMultiplier = layer.buyAmountMultiplier;
    if (layer?.takeProfitPct != null) derived.takeProfitPct = layer.takeProfitPct;
    if (layer?.trailingPullbackPct != null) derived.trailingPullbackPct = layer.trailingPullbackPct;
    return normalizeGridLevelSetting(configured ?? derived, level, fallbackGapPct);
  });
}

function rebuildGridLayers(params: {
  state: BotState;
  entryPrice: number;
  gapPct: number;
  orderAmountKrw: number;
  targetInvestmentKrw: number;
  gridLevels: number;
  gridLevelSettings: GridLevelSetting[];
}): GridLayer[] {
  const generatedLayers = generateGridLayers({
    entryPrice: params.entryPrice,
    orderAmountKrw: params.orderAmountKrw,
    targetInvestmentKrw: params.targetInvestmentKrw,
    levels: params.gridLevels,
    gapPct: params.gapPct,
    levelSettings: params.gridLevelSettings,
  });
  return generatedLayers.map((generatedLayer) => {
    const existing = params.state.layers.find((layer) => layer.idx === generatedLayer.idx);
    if (existing == null || (existing.status !== "OPEN" && existing.qty <= 0)) {
      return generatedLayer;
    }
    return {
      ...generatedLayer,
      amountKrw: existing.amountKrw,
      qty: existing.qty,
      status: existing.status,
      buyCount: existing.buyCount,
      sellCount: existing.sellCount,
      boughtAt: existing.boughtAt,
      soldAt: existing.soldAt,
      buyOrderId: existing.buyOrderId,
      sellOrderId: existing.sellOrderId,
      trailingActive: existing.trailingActive ?? generatedLayer.trailingActive ?? false,
      trailingHighPrice: existing.trailingHighPrice ?? generatedLayer.trailingHighPrice ?? null,
    };
  });
}

async function updateGridSettings(body: string): Promise<{
  ok: true;
  gapPct: number;
  orderAmountKrw: number;
  entryPrice: number;
  levels: number;
  updatedAvailableLayers: number;
  returnedToGrid: boolean;
}> {
  const state = await readJsonFile<BotState>(statePath);
  if (state == null) {
    throw new Error("State file does not exist yet. Start the grid bot first.");
  }
  const settings = parseGridSettingsBody(body, state.totalCapitalKrw);

  const entryPrice = state.gridEntryPrice ?? state.lastPrice;
  if (entryPrice == null || entryPrice <= 0) {
    throw new Error("Cannot change grid settings before an entry price is available.");
  }
  const maxHeldLevel = state.layers.reduce(
    (max, layer) => (layer.status === "OPEN" || layer.qty > 0 ? Math.max(max, layer.idx) : max),
    0,
  );
  if (settings.gridLevels < maxHeldLevel) {
    throw new Error(`Grid levels cannot be lower than the highest held level (${maxHeldLevel}).`);
  }
  const layers = rebuildGridLayers({
    state,
    entryPrice,
    gapPct: settings.gapPct,
    orderAmountKrw: settings.orderAmountKrw,
    targetInvestmentKrw: settings.gridInvestmentKrw,
    gridLevels: settings.gridLevels,
    gridLevelSettings: settings.gridLevelSettings,
  });
  const updatedAvailableLayers = layers.filter((layer) => layer.status !== "OPEN" && layer.qty <= 0).length;
  const previousLayerIndexes = new Set(state.layers.map((layer) => layer.idx));
  const addedWaitingGridLayer = layers.some(
    (layer) => !previousLayerIndexes.has(layer.idx) && layer.status === "WAITING" && layer.qty <= 0,
  );
  const returnedToGrid =
    (state.phase === "FARMING" || state.phase === "HOLDING") && addedWaitingGridLayer;
  const nextState: BotState = {
    ...state,
    phase: returnedToGrid ? "GRID" : state.phase,
    gridEntryPrice: entryPrice,
    gridOrderAmountKrw: settings.orderAmountKrw,
    gridLevelSettings: settings.gridLevelSettings,
    gridInvestmentKrw: layers.reduce((sum, layer) => sum + layer.amountKrw, 0),
    layers,
    maxFarmerStages: settings.maxFarmerStages,
    farmerEntryPct: settings.farmerEntryPct,
    farmerMax3dDrawdownPct: settings.farmerMax3dDrawdownPct,
    farmerStage2CooldownDays: settings.farmerStage2CooldownDays,
    farmerStage3CooldownDays: settings.farmerStage3CooldownDays,
    farmerUsePriceReachedFilter: settings.farmerUsePriceReachedFilter,
    farmerUseLongTrendFilter: settings.farmerUseLongTrendFilter,
    farmerUseTurnoverRatioFilter: settings.farmerUseTurnoverRatioFilter,
    farmerUseMa5TrendFilter: settings.farmerUseMa5TrendFilter,
    farmerUseClosePositionFilter: settings.farmerUseClosePositionFilter,
    farmerUseBullishDailyFilter: settings.farmerUseBullishDailyFilter,
    farmerUseTwoBullishDailyFilter: settings.farmerUseTwoBullishDailyFilter,
    farmerUseVolatilityExplosionFilter: settings.farmerUseVolatilityExplosionFilter,
    gridLoopIntervalMs: settings.gridLoopIntervalMs,
    farmingLoopIntervalMs: settings.farmingLoopIntervalMs,
    enableRecoveryTurtleSell: settings.enableRecoveryTurtleSell,
    recoveryTurtleNPeriod: settings.recoveryTurtleNPeriod,
    recoveryTurtleLowBreakoutPeriod: settings.recoveryTurtleLowBreakoutPeriod,
    recoveryTurtleNMultiplier: settings.recoveryTurtleNMultiplier,
    recoveryTurtleMinOrderKrw: settings.recoveryTurtleMinOrderKrw,
    recoveryUseSliceOrder: settings.recoveryUseSliceOrder,
    recoveryTurtleSliceOrderKrw: settings.recoveryTurtleSliceOrderKrw,
    recoveryTurtleSliceIntervalSeconds: settings.recoveryTurtleSliceIntervalSeconds,
    recoveryUse2NTrailExit: settings.recoveryUse2NTrailExit,
    recoveryUseMa5Exit: settings.recoveryUseMa5Exit,
    recoveryUseLowBreakoutExit: settings.recoveryUseLowBreakoutExit,
    recoveryTrailingActivationMode: settings.recoveryTrailingActivationMode,
    partialTakeProfitEnabled: settings.partialTakeProfitEnabled,
    takeProfit1ReturnPct: settings.takeProfit1ReturnPct,
    takeProfit1SellRatio: settings.takeProfit1SellRatio,
    takeProfit2ReturnPct: settings.takeProfit2ReturnPct,
    takeProfit2SellRatio: settings.takeProfit2SellRatio,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(statePath, nextState);

  return {
    ok: true,
    gapPct: settings.gapPct,
    orderAmountKrw: settings.orderAmountKrw,
    entryPrice,
    levels: layers.length,
    updatedAvailableLayers,
    returnedToGrid,
  };
}

async function readTelegramSettings(): Promise<TelegramSettings> {
  const settings = (await readJsonFile<TelegramSettings>(telegramSettingsPath)) ?? {
    enabled: true,
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    updatedAt: new Date().toISOString(),
  };
  return {
    ...settings,
    enabled: settings.enabled !== false,
    gridBuyNotificationMode: normalizeTelegramGridNotificationMode(
      settings.gridBuyNotificationMode,
      DEFAULT_TELEGRAM_GRID_BUY_NOTIFICATION_MODE,
    ),
    gridSellNotificationMode: normalizeTelegramGridNotificationMode(
      settings.gridSellNotificationMode,
      DEFAULT_TELEGRAM_GRID_SELL_NOTIFICATION_MODE,
    ),
    gridBatchSize: normalizeTelegramGridBatchSize(settings.gridBatchSize),
  };
}

function normalizeTelegramGridNotificationMode(
  value: unknown,
  fallback: TelegramGridNotificationMode,
): TelegramGridNotificationMode {
  return value === "off" || value === "immediate" || value === "batch" ? value : fallback;
}

function normalizeTelegramGridBatchSize(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > 100) {
    return DEFAULT_TELEGRAM_GRID_BATCH_SIZE;
  }
  return numberValue;
}

async function readTelegramSettingsForClient(): Promise<{
  enabled: boolean;
  botTokenConfigured: boolean;
  chatIdConfigured: boolean;
  gridBuyNotificationMode: TelegramGridNotificationMode;
  gridSellNotificationMode: TelegramGridNotificationMode;
  gridBatchSize: number;
  updatedAt: string;
}> {
  const settings = await readTelegramSettings();
  return {
    enabled: settings.enabled,
    botTokenConfigured: (settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "").length > 0,
    chatIdConfigured: (settings.chatId || process.env.TELEGRAM_CHAT_ID || "").length > 0,
    gridBuyNotificationMode:
      settings.gridBuyNotificationMode ?? DEFAULT_TELEGRAM_GRID_BUY_NOTIFICATION_MODE,
    gridSellNotificationMode:
      settings.gridSellNotificationMode ?? DEFAULT_TELEGRAM_GRID_SELL_NOTIFICATION_MODE,
    gridBatchSize: settings.gridBatchSize ?? DEFAULT_TELEGRAM_GRID_BATCH_SIZE,
    updatedAt: settings.updatedAt,
  };
}

async function updateTelegramSettings(body: string): Promise<{
  ok: true;
  enabled: boolean;
  botTokenConfigured: boolean;
  chatIdConfigured: boolean;
  gridBuyNotificationMode: TelegramGridNotificationMode;
  gridSellNotificationMode: TelegramGridNotificationMode;
  gridBatchSize: number;
}> {
  const parsed = JSON.parse(body) as {
    enabled?: unknown;
    botToken?: unknown;
    chatId?: unknown;
    gridBuyNotificationMode?: unknown;
    gridSellNotificationMode?: unknown;
    gridBatchSize?: unknown;
  };
  const current = await readTelegramSettings();
  if (parsed.enabled != null && typeof parsed.enabled !== "boolean") {
    throw new Error("텔레그램 사용 여부 값이 올바르지 않습니다.");
  }
  if (parsed.botToken != null && typeof parsed.botToken !== "string") {
    throw new Error("텔레그램 봇 토큰은 문자열이어야 합니다.");
  }
  if (parsed.chatId != null && typeof parsed.chatId !== "string") {
    throw new Error("텔레그램 채팅 ID는 문자열이어야 합니다.");
  }
  if (
    parsed.gridBuyNotificationMode != null &&
    parsed.gridBuyNotificationMode !== "off" &&
    parsed.gridBuyNotificationMode !== "immediate" &&
    parsed.gridBuyNotificationMode !== "batch"
  ) {
    throw new Error("그리드 매수 알림 방식이 올바르지 않습니다.");
  }
  if (
    parsed.gridSellNotificationMode != null &&
    parsed.gridSellNotificationMode !== "off" &&
    parsed.gridSellNotificationMode !== "immediate" &&
    parsed.gridSellNotificationMode !== "batch"
  ) {
    throw new Error("그리드 매도 알림 방식이 올바르지 않습니다.");
  }
  const parsedGridBatchSize =
    parsed.gridBatchSize == null
      ? normalizeTelegramGridBatchSize(current.gridBatchSize)
      : Number(parsed.gridBatchSize);
  if (!Number.isInteger(parsedGridBatchSize) || parsedGridBatchSize < 1 || parsedGridBatchSize > 100) {
    throw new Error("그리드 알림 묶음 기준은 1~100 사이의 정수여야 합니다.");
  }
  const nextBotToken = typeof parsed.botToken === "string" && parsed.botToken.trim().length > 0
    ? parsed.botToken.trim()
    : current.botToken;
  const nextChatId = typeof parsed.chatId === "string" && parsed.chatId.trim().length > 0
    ? parsed.chatId.trim()
    : current.chatId;
  const settings: TelegramSettings = {
    enabled: parsed.enabled ?? current.enabled,
    gridBuyNotificationMode: normalizeTelegramGridNotificationMode(
      parsed.gridBuyNotificationMode ?? current.gridBuyNotificationMode,
      DEFAULT_TELEGRAM_GRID_BUY_NOTIFICATION_MODE,
    ),
    gridSellNotificationMode: normalizeTelegramGridNotificationMode(
      parsed.gridSellNotificationMode ?? current.gridSellNotificationMode,
      DEFAULT_TELEGRAM_GRID_SELL_NOTIFICATION_MODE,
    ),
    gridBatchSize: parsedGridBatchSize ?? DEFAULT_TELEGRAM_GRID_BATCH_SIZE,
    updatedAt: new Date().toISOString(),
  };
  if (nextBotToken != null) settings.botToken = nextBotToken;
  if (nextChatId != null) settings.chatId = nextChatId;
  await writeJsonAtomic(telegramSettingsPath, settings);
  return {
    ok: true,
    enabled: settings.enabled,
    botTokenConfigured: (settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "").length > 0,
    chatIdConfigured: (settings.chatId || process.env.TELEGRAM_CHAT_ID || "").length > 0,
    gridBuyNotificationMode:
      settings.gridBuyNotificationMode ?? DEFAULT_TELEGRAM_GRID_BUY_NOTIFICATION_MODE,
    gridSellNotificationMode:
      settings.gridSellNotificationMode ?? DEFAULT_TELEGRAM_GRID_SELL_NOTIFICATION_MODE,
    gridBatchSize: settings.gridBatchSize ?? DEFAULT_TELEGRAM_GRID_BATCH_SIZE,
  };
}

async function readBithumbCredentialSettings(): Promise<BithumbCredentialSettings> {
  return (await readJsonFile<BithumbCredentialSettings>(bithumbSettingsPath)) ?? {
    accessKey: process.env.BITHUMB_ACCESS_KEY || process.env.API_KEY || "",
    secretKey: process.env.BITHUMB_SECRET_KEY || process.env.SECRET_KEY || "",
    updatedAt: new Date().toISOString(),
  };
}

async function readBithumbCredentialSettingsForClient(): Promise<{
  accessKeyConfigured: boolean;
  secretKeyConfigured: boolean;
  lastLiveTestBuyQty: number | null;
  lastLiveTestBuyMarket: string | null;
  lastLiveTestBuyExecutedAt: string | null;
  updatedAt: string;
}> {
  const settings = await readBithumbCredentialSettings();
  const lastLiveTestBuy = normalizeBithumbLiveTestBuy(settings.lastLiveTestBuy);
  return {
    accessKeyConfigured: (settings.accessKey || process.env.BITHUMB_ACCESS_KEY || process.env.API_KEY || "").length > 0,
    secretKeyConfigured: (settings.secretKey || process.env.BITHUMB_SECRET_KEY || process.env.SECRET_KEY || "").length > 0,
    lastLiveTestBuyQty: lastLiveTestBuy?.qty ?? null,
    lastLiveTestBuyMarket: lastLiveTestBuy?.market ?? null,
    lastLiveTestBuyExecutedAt: lastLiveTestBuy?.executedAt ?? null,
    updatedAt: settings.updatedAt,
  };
}

async function readConfiguredBithumbCredentials(): Promise<{ accessKey: string; secretKey: string }> {
  const settings = await readBithumbCredentialSettings();
  return {
    accessKey: settings.accessKey || process.env.BITHUMB_ACCESS_KEY || process.env.API_KEY || "",
    secretKey: settings.secretKey || process.env.BITHUMB_SECRET_KEY || process.env.SECRET_KEY || "",
  };
}

async function updateBithumbCredentialSettings(body: string): Promise<{
  ok: true;
  accessKeyConfigured: boolean;
  secretKeyConfigured: boolean;
}> {
  const parsed = JSON.parse(body) as { accessKey?: unknown; secretKey?: unknown };
  const current = await readBithumbCredentialSettings();
  if (parsed.accessKey != null && typeof parsed.accessKey !== "string") {
    throw new Error("Bithumb access key는 문자열이어야 합니다.");
  }
  if (parsed.secretKey != null && typeof parsed.secretKey !== "string") {
    throw new Error("Bithumb secret key는 문자열이어야 합니다.");
  }

  const nextAccessKey = typeof parsed.accessKey === "string" && parsed.accessKey.trim().length > 0
    ? parsed.accessKey.trim()
    : current.accessKey;
  const nextSecretKey = typeof parsed.secretKey === "string" && parsed.secretKey.trim().length > 0
    ? parsed.secretKey.trim()
    : current.secretKey;
  const settings: BithumbCredentialSettings = {
    updatedAt: new Date().toISOString(),
  };
  if (nextAccessKey != null) settings.accessKey = nextAccessKey;
  if (nextSecretKey != null) settings.secretKey = nextSecretKey;
  const currentLiveTestBuy = normalizeBithumbLiveTestBuy(current.lastLiveTestBuy);
  if (currentLiveTestBuy != null) {
    settings.lastLiveTestBuy = currentLiveTestBuy;
  }
  await writeJsonAtomic(bithumbSettingsPath, settings);

  return {
    ok: true,
    accessKeyConfigured: (settings.accessKey || "").length > 0,
    secretKeyConfigured: (settings.secretKey || "").length > 0,
  };
}

async function testBithumbCredentialSettings(): Promise<{
  ok: true;
  accounts: number;
  nonZeroAccounts: number;
}> {
  const { accessKey, secretKey } = await readConfiguredBithumbCredentials();
  if (accessKey.length === 0 || secretKey.length === 0) {
    throw new Error("Bithumb access key와 secret key를 먼저 저장하세요.");
  }
  const client = new BithumbPrivateClient({
    accessKey,
    secretKey,
    feeRate: DEFAULT_BITHUMB_FEE_RATE,
  });
  const accounts = await client.getAccounts();
  return {
    ok: true,
    accounts: accounts.length,
    nonZeroAccounts: accounts.filter((account) => account.balance > 0 || account.locked > 0).length,
  };
}

async function executeBithumbLiveTestOrder(body: string): Promise<{
  ok: true;
  side: "BUY" | "SELL";
  market: string;
  orderId: string;
  amountKrw: number;
  qty: number;
  price: number;
  executedAt: string;
  lastLiveTestBuyQty: number | null;
  telegramNotified: boolean;
  telegramError: string | null;
}> {
  if (!isAuthEnabled()) {
    throw new Error("실시간 테스트 주문은 대시보드 인증을 켠 뒤에만 사용할 수 있습니다.");
  }

  const parsed = JSON.parse(body) as { side?: unknown };
  const side = parsed.side === "BUY" || parsed.side === "SELL" ? parsed.side : null;
  if (side == null) {
    throw new Error("side must be BUY or SELL.");
  }

  const settings = await readBithumbCredentialSettings();
  const { accessKey, secretKey } = await readConfiguredBithumbCredentials();
  if (accessKey.length === 0 || secretKey.length === 0) {
    throw new Error("Bithumb access key와 secret key를 먼저 저장하세요.");
  }

  const market = process.env.GRID_BOT_MARKET || DEFAULT_MARKET;
  const publicClient = new BithumbPublicClient({ mockPrice: null });
  const quote = await publicClient.getCurrentPrice(market);
  const savedBuy = normalizeBithumbLiveTestBuy(settings.lastLiveTestBuy);
  const sellQty = side === "SELL" ? savedBuy?.qty ?? null : null;
  if (side === "SELL") {
    if (savedBuy == null || sellQty == null || sellQty <= 0) {
      throw new Error("먼저 10,000원 실시간 매수 테스트를 실행한 뒤, 그 매수 수량만 매도 테스트할 수 있습니다.");
    }
    if (savedBuy.market !== market) {
      throw new Error(`마지막 매수 테스트 마켓(${savedBuy.market})과 현재 마켓(${market})이 다릅니다.`);
    }
    const estimatedSellKrw = quote.tradePrice * sellQty;
    if (estimatedSellKrw > BITHUMB_LIVE_TEST_ORDER_KRW * 1.2) {
      throw new Error(`테스트 매도 예상 금액이 안전 한도(12,000원)를 초과했습니다. estimated=${roundKrw(estimatedSellKrw)}`);
    }
  }
  const privateClient = new BithumbPrivateClient({
    accessKey,
    secretKey,
    feeRate: DEFAULT_BITHUMB_FEE_RATE,
  });
  const executor = new RealOrderExecutor({
    enabled: true,
    client: privateClient,
    maxOrderKrw: side === "SELL" ? BITHUMB_LIVE_TEST_ORDER_KRW * 1.2 : BITHUMB_LIVE_TEST_ORDER_KRW,
    useAggressiveLimitOrders: true,
    aggressiveLimitOffsetPct: 0.0005,
    aggressiveLimitWaitMs: 1_000,
  });
  const requestId = randomUUID();
  const execution = side === "BUY"
    ? await executor.buyMarket({
        market,
        price: quote.tradePrice,
        amountKrw: BITHUMB_LIVE_TEST_ORDER_KRW,
        requestId,
      })
    : await executor.sellMarket({
        market,
        price: quote.tradePrice,
        qty: sellQty ?? 0,
        requestId,
      });

  if (side === "BUY") {
    await writeBithumbLiveTestBuy({
      market,
      qty: execution.qty,
      amountKrw: execution.amountKrw,
      price: execution.price,
      orderId: execution.orderId,
      executedAt: execution.executedAt,
    });
  } else {
    await writeBithumbLiveTestBuy(null);
  }
  const telegramResult = await notifyBithumbLiveTestOrder(execution);

  return {
    ok: true,
    side,
    market,
    orderId: execution.orderId,
    amountKrw: execution.amountKrw,
    qty: execution.qty,
    price: execution.price,
    executedAt: execution.executedAt,
    lastLiveTestBuyQty: side === "BUY" ? execution.qty : null,
    telegramNotified: telegramResult.sent,
    telegramError: telegramResult.error ?? null,
  };
}

function normalizeBithumbLiveTestBuy(record: BithumbCredentialSettings["lastLiveTestBuy"]): BithumbLiveTestBuyRecord | null {
  if (record == null) return null;
  if (
    typeof record.market !== "string" ||
    typeof record.qty !== "number" ||
    typeof record.amountKrw !== "number" ||
    typeof record.price !== "number" ||
    typeof record.orderId !== "string" ||
    typeof record.executedAt !== "string"
  ) {
    return null;
  }
  if (!Number.isFinite(record.qty) || record.qty <= 0) return null;
  if (!Number.isFinite(record.amountKrw) || record.amountKrw <= 0) return null;
  if (!Number.isFinite(record.price) || record.price <= 0) return null;
  return record;
}

async function writeBithumbLiveTestBuy(record: BithumbLiveTestBuyRecord | null): Promise<void> {
  const current = await readBithumbCredentialSettings();
  const settings: BithumbCredentialSettings = {
    ...current,
    updatedAt: new Date().toISOString(),
  };
  if (record == null) {
    delete settings.lastLiveTestBuy;
  } else {
    settings.lastLiveTestBuy = record;
  }
  await writeJsonAtomic(bithumbSettingsPath, settings);
}

async function notifyBithumbLiveTestOrder(execution: OrderExecution): Promise<{ sent: boolean; error?: string }> {
  const sideLabel = execution.side === "BUY" ? "매수" : "매도";
  const message = [
    `[Bithumb 실시간 테스트 ${sideLabel} 완료]`,
    `마켓: ${execution.market}`,
    `금액: ${formatKrw(execution.amountKrw)}`,
    `수량: ${execution.qty}`,
    `기준가: ${formatKrw(execution.price)}`,
    `주문ID: ${execution.orderId}`,
    `체결시각: ${formatDate(execution.executedAt)}`,
  ].join("\n");
  return await sendTelegramMessageIfEnabled(message);
}

async function sendTelegramMessageIfEnabled(message: string): Promise<{ sent: boolean; error?: string }> {
  try {
    const settings = await readTelegramSettings();
    if (settings.enabled === false) {
      return { sent: false, error: "텔레그램이 꺼져 있습니다." };
    }
    const token = settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
    const chatId = settings.chatId || process.env.TELEGRAM_CHAT_ID || "";
    if (token.length === 0 || chatId.length === 0) {
      return { sent: false, error: "텔레그램 토큰 또는 채팅 ID가 설정되지 않았습니다." };
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: "true",
      }).toString(),
    });
    const json = await response.json();
    if (!response.ok) {
      return { sent: false, error: `Telegram HTTP ${response.status}: ${JSON.stringify(json)}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sendTelegramTestMessage(): Promise<{ ok: true }> {
  const settings = await readTelegramSettings();
  const token = settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = settings.chatId || process.env.TELEGRAM_CHAT_ID || "";
  if (token.length === 0 || chatId.length === 0) {
    throw new Error("텔레그램 봇 토큰과 채팅 ID를 입력한 뒤 저장하세요.");
  }

  const message = "You're now connected.";
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: "true",
    }).toString(),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`텔레그램 테스트에 실패했습니다: ${JSON.stringify(json)}`);
  }
  return { ok: true };
}

function getProgressedLevel(layers: GridLayer[]): number {
  return layers.reduce(
    (max, layer) =>
      layer.status === "OPEN" || layer.qty > 0 || layer.buyCount > 0 || layer.sellCount > 0
        ? Math.max(max, layer.idx)
        : max,
    0,
  );
}

async function requestGridReset(): Promise<{
  ok: true;
  sold: boolean;
  soldCount: number;
  openGridPositions: number;
  phase: BotState["phase"];
}> {
  const state = await readJsonFile<BotState>(statePath);
  if (state == null) {
    throw new Error("State file does not exist yet. Start the grid bot first.");
  }

  const openLayers = state.layers.filter((layer) => layer.status === "OPEN" && layer.qty > 0);
  const openGridPositions = openLayers.length;
  if (openGridPositions === 0) {
    await writeJsonAtomic(statePath, {
      ...state,
      phase: "GRID",
      cycleId: randomUUID(),
      gridEntryPrice: null,
      gridEntryReferencePrice: null,
      gridEntryNValue: null,
      gridEntryNCalculatedForKstDate: null,
      gridInvestmentKrw: 0,
      gridOrderAmountKrw: 0,
      layers: [],
      highestPrice: 0,
      gridResetRequestedAt: null,
      gridResetCompletedAt: new Date().toISOString(),
      gridResetLastError: null,
    });
    return {
      ok: true,
      sold: false,
      soldCount: 0,
      openGridPositions,
      phase: "GRID",
    };
  }

  const gridConfig = loadConfig();
  const publicClient = new BithumbPublicClient({ mockPrice: gridConfig.mockPrice });
  const privateClient = new BithumbPrivateClient({
    accessKey: gridConfig.bithumbAccessKey,
    secretKey: gridConfig.bithumbSecretKey,
    feeRate: gridConfig.feeRate,
  });
  const executor = selectOrderExecutor({
    enableRealOrders: gridConfig.enableRealOrders,
    paperExecutor: new PaperOrderExecutor(gridConfig.feeRate),
    realExecutor: new RealOrderExecutor({
      enabled: gridConfig.enableRealOrders,
      client: privateClient,
      maxOrderKrw: gridConfig.maxRealOrderKrw,
      useAggressiveLimitOrders: gridConfig.useAggressiveLimitOrders,
      aggressiveLimitOffsetPct: gridConfig.aggressiveLimitOffsetPct,
      aggressiveLimitWaitMs: gridConfig.aggressiveLimitWaitMs,
    }),
  });
  const logger = new JsonlTradeLogger(logPath);
  const quote = await publicClient.getCurrentPrice(state.market);
  let nextState: BotState = {
    ...state,
    lastPrice: quote.tradePrice,
    lastLoopAt: new Date().toISOString(),
    gridResetLastError: null,
  };
  let soldCount = 0;

  for (const layer of openLayers) {
    const execution = await executor.sellMarket({
      market: nextState.market,
      price: quote.tradePrice,
      qty: layer.qty,
      requestId: randomUUID(),
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
    soldCount += 1;
    await logger.append({
      timestamp: execution.executedAt,
      botId: nextState.botId,
      market: nextState.market,
      cycleId: nextState.cycleId,
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
      metadata: {
        source: "DASHBOARD_IMMEDIATE_RESET",
        quoteSource: quote.source,
      },
    });
  }

  const completedAt = new Date().toISOString();
  nextState = {
    ...nextState,
    phase: "GRID",
    cycleId: randomUUID(),
    gridEntryPrice: null,
    gridEntryReferencePrice: null,
    gridEntryNValue: null,
    gridEntryNCalculatedForKstDate: null,
    gridInvestmentKrw: 0,
    gridOrderAmountKrw: 0,
    layers: [],
    highestPrice: 0,
    gridResetRequestedAt: null,
    gridResetCompletedAt: completedAt,
    gridResetLastError: null,
    lastExitTime: completedAt,
  };
  await writeJsonAtomic(statePath, nextState);

  return {
    ok: true,
    sold: soldCount > 0,
    soldCount,
    openGridPositions,
    phase: nextState.phase,
  };
}

async function resetRealizedPnlRecords(): Promise<{
  ok: true;
  removedCount: number;
  keptCount: number;
}> {
  const trades = await readJsonlRecords<TradeLogRecord>(logPath);
  const keptTrades = trades.filter((trade) => !isRealizedSellAction(trade.action));
  const removedCount = trades.length - keptTrades.length;
  const nextText = keptTrades.length > 0 ? `${keptTrades.map((trade) => JSON.stringify(trade)).join("\n")}\n` : "";
  await writeTextAtomic(logPath, nextText);
  return {
    ok: true,
    removedCount,
    keptCount: keptTrades.length,
  };
}

function renderHtml(summary: DashboardSummary, options: ViewOptions): string {
  const state = summary.state;
  const layers = state?.layers ?? [];
  const lastPrice = state?.lastPrice ?? null;
  const openLayers = layers.filter((layer) => layer.status === "OPEN" || layer.qty > 0);
  const inactiveLayers = layers.filter((layer) => layer.status !== "OPEN" && layer.qty <= 0);
  const nextGridEntry = getNextGridEntry(layers);
  const currentGapPct = inferGridGapPct(state);
  const gridLevelCount = layers.length || 20;
  const gridLevelSettings = getGridLevelSettings(state, gridLevelCount, currentGapPct ?? 0.01);
  const gridLevelSettingsJson = escapeHtml(JSON.stringify(gridLevelSettings));
  const firstGridLevelSetting = gridLevelSettings[0] ?? null;
  const calculatedGridOrderAmountKrw =
    state != null
      ? calculateGridSizing({
          totalCapitalKrw: state.totalCapitalKrw,
          gridRatio: DEFAULT_GRID_RATIO,
          levels: gridLevelCount,
          levelSettings: gridLevelSettings,
        }).orderAmountKrw
      : null;
  const accountCapitalKrw = state?.accountCapitalKrw ?? state?.totalCapitalKrw ?? null;
  const accountKrwAvailable = state?.accountKrwBalance ?? null;
  const accountKrwLocked = state?.accountKrwLocked ?? null;
  const accountAssetQty =
    state == null
      ? null
      : (state.accountAssetBalance ?? 0) + (state.accountAssetLocked ?? 0);
  const accountAssetValueKrw = state?.accountAssetValueKrw ?? null;
  const accountUpdatedAt = state?.accountCapitalUpdatedAt ?? null;
  const formatRatioPct = (value: number | null | undefined): string =>
    value == null || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(2)}%`;
  const formatTrailingPct = (value: number | null | undefined): string => {
    if (value == null || !Number.isFinite(value)) return "-";
    const pct = Math.abs(value * 100);
    return pct === 0 ? "0.00%" : `-${pct.toFixed(2)}%`;
  };
  const maxFarmerStages = state?.maxFarmerStages ?? 3;
  const farmerEntryPct = state?.farmerEntryPct ?? DEFAULT_FARMER_ENTRY_PCT;
  const farmerMax3dDrawdownPct = state?.farmerMax3dDrawdownPct ?? DEFAULT_FARMER_MAX_3D_DRAWDOWN_PCT;
  const farmerStage2CooldownDays = state?.farmerStage2CooldownDays ?? DEFAULT_FARMER_STAGE2_COOLDOWN_DAYS;
  const farmerStage3CooldownDays = state?.farmerStage3CooldownDays ?? DEFAULT_FARMER_STAGE3_COOLDOWN_DAYS;
  const farmerUsePriceReachedFilter =
    state?.farmerUsePriceReachedFilter ?? DEFAULT_FARMER_USE_PRICE_REACHED_FILTER;
  const farmerUseLongTrendFilter = state?.farmerUseLongTrendFilter ?? DEFAULT_FARMER_USE_LONG_TREND_FILTER;
  const farmerUseTurnoverRatioFilter =
    state?.farmerUseTurnoverRatioFilter ?? DEFAULT_FARMER_USE_TURNOVER_RATIO_FILTER;
  const farmerUseMa5TrendFilter = state?.farmerUseMa5TrendFilter ?? DEFAULT_FARMER_USE_MA5_TREND_FILTER;
  const farmerUseClosePositionFilter =
    state?.farmerUseClosePositionFilter ?? DEFAULT_FARMER_USE_CLOSE_POSITION_FILTER;
  const farmerUseBullishDailyFilter =
    state?.farmerUseBullishDailyFilter ?? DEFAULT_FARMER_USE_BULLISH_DAILY_FILTER;
  const farmerUseTwoBullishDailyFilter =
    state?.farmerUseTwoBullishDailyFilter ?? DEFAULT_FARMER_USE_TWO_BULLISH_DAILY_FILTER;
  const farmerUseVolatilityExplosionFilter =
    state?.farmerUseVolatilityExplosionFilter ?? DEFAULT_FARMER_USE_VOLATILITY_EXPLOSION_FILTER;
  const gridLoopIntervalMs = state?.gridLoopIntervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  const gridLoopIntervalSeconds = Math.max(60, Math.round(gridLoopIntervalMs / 1000));
  const farmingLoopIntervalMs = state?.farmingLoopIntervalMs ?? DEFAULT_FARMING_LOOP_INTERVAL_MS;
  const farmingLoopIntervalSeconds = Math.round(farmingLoopIntervalMs / 1000);
  const enableRecoveryTurtleSell = state?.enableRecoveryTurtleSell ?? false;
  const recoveryTurtleNPeriod = state?.recoveryTurtleNPeriod ?? DEFAULT_RECOVERY_TURTLE_N_PERIOD;
  const recoveryTurtleLowBreakoutPeriod =
    state?.recoveryTurtleLowBreakoutPeriod ?? DEFAULT_RECOVERY_TURTLE_LOW_BREAKOUT_PERIOD;
  const recoveryTurtleNMultiplier = state?.recoveryTurtleNMultiplier ?? DEFAULT_RECOVERY_TURTLE_N_MULTIPLIER;
  const recoveryTurtleMinOrderKrw = state?.recoveryTurtleMinOrderKrw ?? DEFAULT_RECOVERY_TURTLE_MIN_ORDER_KRW;
  const recoveryUseSliceOrder = state?.recoveryUseSliceOrder ?? DEFAULT_RECOVERY_USE_SLICE_ORDER;
  const recoveryTurtleSliceOrderKrw =
    state?.recoveryTurtleSliceOrderKrw ?? DEFAULT_RECOVERY_TURTLE_SLICE_ORDER_KRW;
  const recoveryTurtleSliceIntervalSeconds =
    state?.recoveryTurtleSliceIntervalSeconds ?? DEFAULT_RECOVERY_TURTLE_SLICE_INTERVAL_SECONDS;
  const recoveryUse2NTrailExit = state?.recoveryUse2NTrailExit ?? DEFAULT_RECOVERY_USE_2N_TRAIL_EXIT;
  const recoveryUseMa5Exit = state?.recoveryUseMa5Exit ?? DEFAULT_RECOVERY_USE_MA5_EXIT;
  const recoveryUseLowBreakoutExit = state?.recoveryUseLowBreakoutExit ?? DEFAULT_RECOVERY_USE_LOW_BREAKOUT_EXIT;
  const recoveryTrailingActivationMode =
    state?.recoveryTrailingActivationMode ?? DEFAULT_RECOVERY_TRAILING_ACTIVATION_MODE;
  const partialTakeProfitEnabled = state?.partialTakeProfitEnabled ?? DEFAULT_PARTIAL_TAKE_PROFIT_ENABLED;
  const takeProfit1ReturnPct = state?.takeProfit1ReturnPct ?? DEFAULT_TP1_RETURN_PCT;
  const takeProfit1SellRatio = state?.takeProfit1SellRatio ?? DEFAULT_TP1_SELL_RATIO;
  const takeProfit2ReturnPct = state?.takeProfit2ReturnPct ?? DEFAULT_TP2_RETURN_PCT;
  const takeProfit2SellRatio = state?.takeProfit2SellRatio ?? DEFAULT_TP2_SELL_RATIO;
  const progressedLevel = getProgressedLevel(layers);
  const waitingLayerCount = summary.totals.waitingLayers + summary.totals.soldLayers;
  const farmerLastBuyPrice = getFarmerLastBuyPrice(state);
  const nextFarmerEntryPrice = getNextFarmerEntryPrice(state, farmerEntryPct);
  const recoveryExitSignal = state?.recoveryExitSignal ?? null;
  const recoveryExitStatus = formatRecoveryExitStatusKo(recoveryExitSignal);
  const strategyToggleCard = (title: string, value: string, muted?: string): string => `
        <div class="panel">
          <div class="metric-label">${escapeHtml(title)}</div>
          <div class="metric-value">${escapeHtml(value)}</div>
          ${muted ? `<div class="muted">${escapeHtml(muted)}</div>` : ""}
        </div>`;
  const strategyToggleGroup = (title: string, cards: string): string =>
    cards
      ? `
        <div class="strategy-toggle-group-title">${escapeHtml(title)}</div>
        ${cards}`
      : "";
  const trailingActivationLabel =
    recoveryTrailingActivationMode === "PROFIT_POSITIVE"
      ? "수익률 양수"
      : recoveryTrailingActivationMode === "TP1"
        ? "TP1 이상"
        : "TP2 이상";
  const farmerToggleCards = [
    farmerUsePriceReachedFilter
      ? strategyToggleCard("농부 진입 가격", `-${(farmerEntryPct * 100).toFixed(2)}%`, "목표가 도달 조건")
      : "",
    farmerUseLongTrendFilter ? strategyToggleCard("장기 추세", "MA200", "방향 조건") : "",
    farmerUseTurnoverRatioFilter ? strategyToggleCard("거래대금 증가", "1.50x / 1.20x", "20일 / 5일") : "",
    farmerUseMa5TrendFilter ? strategyToggleCard("MA5 단기 추세", "MA5") : "",
    farmerUseClosePositionFilter ? strategyToggleCard("종가 위치", "60% 이상") : "",
    farmerUseBullishDailyFilter ? strategyToggleCard("일봉 양봉", "1일") : "",
    farmerUseTwoBullishDailyFilter ? strategyToggleCard("2일 연속 양봉", "2일 연속 양봉") : "",
    farmerUseVolatilityExplosionFilter
      ? strategyToggleCard("변동성 폭발 구간", `${recoveryTurtleNMultiplier}N`, "차단")
      : "",
  ].filter(Boolean).join("");
  const turtleToggleCards = [
    enableRecoveryTurtleSell ? strategyToggleCard("회복 터틀 매도", recoveryExitStatus) : "",
    recoveryUse2NTrailExit ? strategyToggleCard("2N 트레일링 이탈", trailingActivationLabel) : "",
    recoveryUseMa5Exit ? strategyToggleCard("MA5 하회 매도", "MA5") : "",
    recoveryUseLowBreakoutExit ? strategyToggleCard("N일 최저가 이탈", `${recoveryTurtleLowBreakoutPeriod}일`) : "",
    recoveryUseSliceOrder
      ? strategyToggleCard("터틀 분할 주문", formatKrw(recoveryTurtleSliceOrderKrw), `${recoveryTurtleSliceIntervalSeconds}초 간격`)
      : "",
    partialTakeProfitEnabled
      ? strategyToggleCard(
          "부분 익절",
          `TP1 ${(takeProfit1ReturnPct * 100).toFixed(2)}% / ${(takeProfit1SellRatio * 100).toFixed(0)}%`,
          `TP2 ${(takeProfit2ReturnPct * 100).toFixed(2)}% / ${(takeProfit2SellRatio * 100).toFixed(0)}% 매도`,
        )
      : "",
  ].filter(Boolean).join("");
  const gridConditionCards = `
        <div class="panel"><div class="metric-label">그리드 차수</div><div class="metric-value">${gridLevelCount}</div></div>
        <div class="panel"><div class="metric-label">차수 간격</div><div class="metric-value">${formatRatioPct(currentGapPct)}</div></div>
        <div class="panel"><div class="metric-label">기본 차수별 매수 금액</div><div class="metric-value">${formatKrw(calculatedGridOrderAmountKrw)}</div></div>
        <div class="panel"><div class="metric-label">매도 익절 기준</div><div class="metric-value">${formatRatioPct(firstGridLevelSetting?.takeProfitPct)}</div></div>
        <div class="panel"><div class="metric-label">트레일링 폴링 기준</div><div class="metric-value">${formatTrailingPct(firstGridLevelSetting?.trailingPullbackPct)}</div></div>`;
  const strategyFixedSummary = strategyToggleGroup(
    "그리드 매매 조건",
    gridConditionCards,
  );
  const strategyToggleGroups = [
    strategyToggleGroup("농부 매수 조건", farmerToggleCards),
    strategyToggleGroup("터틀 매도 조건", turtleToggleCards),
  ].filter(Boolean).join("");
  const strategyToggleSummary =
    strategyToggleGroups || '<div class="strategy-toggle-empty">전략 조정에서 켜진 토글 메뉴가 없습니다.</div>';
  const warnings = summary.warnings
    .map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`)
    .join("");
  const renderLayerRow = (layer: GridLayer): string => {
    const openPnlKrw = calculateOpenLayerPnlKrw(layer, lastPrice);
    const openPnlPct = openPnlKrw == null ? null : calculatePnlPct(openPnlKrw, calculateGridLayerCostBasisKrw(layer));
    const displayStatus = formatLayerStatusKo(layer.status);
    const statusClass = layer.status === "SOLD" ? "waiting" : layer.status.toLowerCase();
    return `
        <tr>
          <td>${layer.idx}</td>
          <td><span class="badge ${statusClass}">${displayStatus}</span></td>
          <td>${formatKrw(layer.buyPrice)}</td>
          <td>${formatKrw(layer.sellPrice)}</td>
          <td>${formatKrw(layer.amountKrw)}</td>
          <td>${layer.qty.toFixed(8)}</td>
          <td>${layer.buyCount} / ${layer.sellCount}</td>
          <td>${formatKrw(openPnlKrw)}</td>
          <td>${formatPct(openPnlPct)}</td>
        </tr>`;
  };
  const openLayerRows = openLayers.map(renderLayerRow).join("");
  const inactiveLayerRows = inactiveLayers.map(renderLayerRow).join("");
  const tradeRows = summary.recentTrades
    .map(
      (trade) => `
        <tr>
          <td>${formatDate(trade.timestamp)}</td>
          <td>${escapeHtml(formatTradeActionKo(trade.action))}</td>
          <td>${trade.stage ?? "-"}</td>
          <td>${formatKrw(trade.price)}</td>
          <td>${formatKrw(trade.amountKrw)}</td>
          <td>${formatKrw(trade.realizedPnlKrw)}</td>
          <td>${formatPct(calculateTradeRealizedPnlPct(trade))}</td>
        </tr>`,
    )
    .join("");
  const commandLogRows = summary.botLogLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  const dailyPnlCalendar = renderDailyPnlCalendar(summary.dailyPnl, summary.generatedAt, options);
  const pnlChart = renderPnlChart(summary.dailyPnl, options);

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bithumb Grid Farmer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --surface: #ffffff;
      --line: #d8dee4;
      --text: #18202a;
      --muted: #5d6b7a;
      --green: #16794c;
      --blue: #1d5f99;
      --amber: #9a6700;
      --red: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Arial, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      line-height: 1.45;
      text-align: center;
    }
    header, main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 28px 0 18px; display: flex; align-items: end; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 17px; letter-spacing: 0; }
    .muted { color: var(--muted); font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric-group {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      margin: 14px 0;
    }
    .metric-group-head {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      margin-bottom: 10px;
      letter-spacing: 0.04em;
    }
    .metric-row {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .metric-row-follow { margin-top: 10px; }
    .farmer-signal-panel { margin-top: 10px; text-align: left; }
    .farmer-signal-summary { text-align: center; }
    .farmer-signal-title {
      font-size: 13px;
      font-weight: 900;
      color: var(--text);
    }
    .signal-line { margin: 4px 0 6px; overflow-wrap: anywhere; }
    .insight-grid { display: grid; grid-template-columns: minmax(320px, 0.9fr) minmax(420px, 1.4fr); gap: 12px; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    .panel.tone-profit {
      background: #fdecec;
      border-color: #f1c4c4;
    }
    .panel.tone-loss {
      background: #edf6fc;
      border-color: #b7d6ed;
    }
    .panel.tone-ok {
      background: #edf8ef;
      border-color: #b9dfc1;
    }
    .panel.tone-disabled {
      background: #f1f3f6;
      border-color: #d7dde5;
      color: #8a94a3;
    }
    .panel.tone-disabled .metric-label,
    .panel.tone-disabled .metric-value,
    .panel.tone-disabled .muted,
    .panel.tone-disabled strong {
      color: #8a94a3;
    }
    .settings-form {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      align-items: end;
    }
    .settings-section {
      grid-column: 1 / -1;
      margin-top: 6px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
    }
    .settings-section:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }
    .settings-section h3 {
      margin: 0 0 10px;
      font-size: 14px;
      color: var(--muted);
    }
    .settings-card {
      padding: 18px;
    }
    .strategy-setting-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .grid-condition-cards {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
    .grid-settings-summary {
      grid-column: 1 / -1;
    }
    .strategy-fixed-grid {
      margin-bottom: 12px;
    }
    .strategy-toggle-group-title {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      border-radius: 8px;
      color: #344153;
      background: #eef4fa;
      font-size: 12px;
      font-weight: 800;
    }
    .strategy-toggle-empty {
      grid-column: 1 / -1;
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px dashed #cbd5df;
      border-radius: 8px;
      color: var(--muted);
      background: #fbfcfd;
      font-weight: 700;
    }
    .field label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .field input,
    .field select {
      width: 100%;
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      font: inherit;
      background: #fff;
    }
    .field select {
      appearance: none;
    }
    .field input:disabled {
      background: #d8dee4;
      border-color: #aeb8c2;
      color: #4d5966;
      cursor: not-allowed;
    }
    .readonly-metric {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #f8fafb;
      color: var(--text);
      font-weight: 900;
      font-size: 16px;
    }
    .checkbox-field {
      min-height: 40px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      color: var(--text);
    }
    .checkbox-field input {
      width: 18px;
      height: 18px;
    }
    .funding-preview {
      grid-column: 1 / -1;
      margin-top: 4px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }
    .strategy-funding-summary {
      margin: 0 0 12px;
    }
    .form-actions {
      grid-column: 1 / -1;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
    }
    .funding-item {
      min-height: 72px;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      background: #fbfcfd;
      padding: 12px;
    }
    .funding-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .funding-value {
      color: var(--text);
      font-size: 14px;
      font-weight: 800;
      overflow-wrap: anywhere;
      line-height: 1.25;
    }
    .funding-item.total {
      background: #edf6fc;
      border-color: #b7d6ed;
    }
    .button {
      height: 40px;
      border: 0;
      border-radius: 6px;
      background: #18202a;
      color: white;
      padding: 0 16px;
      font-weight: 700;
      cursor: pointer;
    }
    .button.secondary { background: #2f3b46; }
    .button.danger { background: #b42318; }
    .button:disabled { opacity: 0.55; cursor: not-allowed; }
    .control-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: center;
    }
    .log-head {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(420px, 0.9fr);
      align-items: end;
      gap: 16px;
      margin-bottom: 10px;
    }
    .telegram-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 10px;
    }
    .telegram-form {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) minmax(110px, 0.7fr) auto auto auto;
      gap: 8px;
      align-items: center;
    }
    .telegram-routing-form {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 8px;
    }
    .telegram-routing-field {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .telegram-form input,
    .telegram-routing-field input,
    .telegram-routing-field select {
      width: 100%;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 9px;
      font: inherit;
      font-size: 12px;
      background: #fff;
    }
    .telegram-form .button { height: 36px; padding: 0 12px; white-space: nowrap; }
    .telegram-panel .form-status { margin-top: 6px; min-height: 16px; font-size: 12px; }
    .bithumb-form {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) auto auto;
      gap: 8px;
      align-items: center;
    }
    .bithumb-form input {
      width: 100%;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 9px;
      font: inherit;
      font-size: 12px;
      background: #fff;
    }
    .bithumb-form .button { height: 36px; padding: 0 12px; white-space: nowrap; }
    .bithumb-test-actions {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(2, minmax(180px, 1fr));
      gap: 8px;
    }
    .bithumb-test-actions .button {
      width: 100%;
      min-height: 38px;
      height: 38px;
    }
    .button.live-buy { background: #18202a; }
    .button.live-sell { background: #b42318; }
    .form-status { margin-top: 10px; min-height: 18px; font-size: 13px; color: var(--muted); }
    .metric-label { color: var(--muted); font-size: 12px; margin-bottom: 6px; text-align: center; }
    .metric-value { font-size: 21px; font-weight: 700; overflow-wrap: anywhere; }
    .section { margin: 14px 0; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
    .scroll-table { max-height: 360px; overflow: auto; }
    .calendar-head { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px; margin-bottom: 14px; }
    .calendar-head .summary-meta { justify-self: end; }
    .chart-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .calendar-weekdays { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); color: var(--muted); font-size: 12px; text-align: center; margin-bottom: 8px; }
    .calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
    .year-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .calendar-cell {
      min-height: 74px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 8px;
      background: #f6f8fa;
    }
    a.calendar-cell, button.calendar-cell {
      display: block;
      color: inherit;
      text-decoration: none;
    }
    button.calendar-cell {
      width: 100%;
      font: inherit;
      cursor: pointer;
    }
    .calendar-cell.empty { visibility: hidden; }
    .calendar-cell.positive { background: #fdecec; border-color: #f1c4c4; color: var(--red); }
    .calendar-cell.negative { background: #edf6fc; border-color: #b7d6ed; color: var(--blue); }
    .calendar-cell.neutral { color: var(--muted); }
    .calendar-cell.today-cell { border: 3px solid #111827; padding: 8px 6px; }
    .calendar-day { color: var(--text); font-size: 18px; font-weight: 700; margin-bottom: 6px; text-align: center; }
    button.calendar-day {
      border: 0;
      background: transparent;
      display: block;
      width: 100%;
      cursor: pointer;
      font: inherit;
    }
    .trade-day { cursor: pointer; }
    .trade-day:hover { outline: 2px solid #9fc8e8; outline-offset: 1px; }
    .calendar-pnl { font-size: 13px; font-weight: 700; text-align: center; overflow-wrap: anywhere; }
    .center-controls {
      display: grid;
      grid-template-columns: minmax(88px, 1fr) auto minmax(88px, 1fr);
      align-items: center;
      gap: 12px;
      margin: 0 0 14px;
    }
    .control-side { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .control-side.left { justify-content: flex-start; }
    .control-side.right { justify-content: flex-end; }
    .period-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    .icon-link, .mode-link {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      text-decoration: none;
      border-radius: 6px;
      min-width: 38px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
    }
    .mode-link { padding: 0 12px; }
    .today-link { border-width: 2px; box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.08); min-width: 74px; }
    .period-label { min-width: 96px; text-align: center; font-size: 18px; font-weight: 700; }
    .range-form { display: grid; grid-template-columns: repeat(4, minmax(0, 150px)); gap: 10px; margin: 0 auto 12px; align-items: end; justify-content: center; }
    .range-form select { width: 100%; height: 40px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: #fff; font: inherit; }
    .chart-wrap { position: relative; }
    .pnl-chart { display: block; width: 100%; height: auto; }
    .chart-hit-area { cursor: crosshair; pointer-events: all; }
    .chart-point { pointer-events: none; }
    .chart-tooltip {
      position: absolute;
      z-index: 4;
      display: none;
      min-width: 160px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 8px 22px rgba(24, 32, 42, 0.12);
      padding: 9px 10px;
      color: var(--text);
      font-size: 12px;
      text-align: left;
      pointer-events: none;
    }
    .chart-tooltip.open { display: block; }
    .chart-tooltip-title { font-weight: 800; margin-bottom: 4px; }
    .chart-tooltip-row { display: flex; justify-content: space-between; gap: 14px; white-space: nowrap; }
    .legend { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
    .legend-bar { width: 12px; height: 12px; background: #6aaed6; display: inline-block; border-radius: 2px; }
    .legend-line { width: 18px; height: 3px; background: #e3342f; display: inline-block; border-radius: 999px; margin-left: 8px; }
    details.section > summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    details.section > summary::-webkit-details-marker { display: none; }
    .summary-title { font-size: 17px; font-weight: 700; }
    .title-row { display: inline-flex; align-items: center; gap: 10px; }
    .summary-meta { color: var(--muted); font-size: 13px; }
    .chevron { color: var(--muted); font-size: 18px; line-height: 1; }
    details[open] .chevron { transform: rotate(180deg); }
    .strategy-adjustment {
      border: 1px solid #d4dde8;
      border-radius: 8px;
      padding: 0;
      margin-top: 14px;
      background: #fff;
      box-shadow: 0 12px 28px rgba(17, 24, 39, 0.06);
      overflow: hidden;
    }
    .strategy-adjustment[open] {
      border-color: #a8c5e8;
    }
    .strategy-adjustment summary {
      cursor: pointer;
      position: relative;
      display: grid;
      grid-template-columns: minmax(80px, 1fr) auto minmax(80px, 1fr);
      align-items: center;
      gap: 12px;
      font-weight: 800;
      color: var(--text);
      list-style: none;
      padding: 14px 16px;
      background: linear-gradient(180deg, #ffffff 0%, #f6f9fc 100%);
      text-align: center;
      user-select: none;
    }
    .strategy-adjustment summary::before {
      content: "";
    }
    .strategy-adjustment summary::after {
      content: "⌄";
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #ccd7e3;
      border-radius: 999px;
      color: #536273;
      background: #fff;
      transition: transform 0.16s ease, border-color 0.16s ease;
      justify-self: end;
    }
    .strategy-summary-title {
      grid-column: 2;
      justify-self: center;
    }
    .strategy-summary-save {
      position: absolute;
      top: 50%;
      right: 52px;
      transform: translateY(-50%);
      min-height: 32px;
      padding: 0 14px;
      font-size: 12px;
    }
    .strategy-adjustment[open] summary {
      border-bottom: 1px solid #e1e8f0;
    }
    .strategy-adjustment[open] summary::after {
      transform: rotate(180deg);
      border-color: #9bb9dc;
    }
    .strategy-adjustment summary::-webkit-details-marker { display: none; }
    .strategy-adjustment .settings-form {
      padding: 16px;
      gap: 12px;
      background: #f8fafc;
    }
    .strategy-adjustment .settings-section {
      margin: 4px 0 0;
      padding: 12px 14px 0;
      border-top: 1px solid #dde6ef;
    }
    .strategy-adjustment .settings-section:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }
    .strategy-adjustment .settings-section h3 {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      margin: 0;
      border-radius: 8px;
      color: #344153;
      background: #eef4fa;
      font-size: 12px;
      letter-spacing: 0;
    }
    .strategy-adjustment .field {
      min-height: 84px;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      padding: 10px;
      border: 1px solid #e0e7ef;
      border-radius: 8px;
      background: #fff;
    }
    .strategy-adjustment .field label {
      min-height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      line-height: 1.25;
      margin-bottom: 8px;
    }
    .strategy-adjustment .field input,
    .strategy-adjustment .field select {
      height: 38px;
      text-align: center;
      border-color: #ccd7e3;
      background: #fbfdff;
      box-shadow: inset 0 1px 2px rgba(17, 24, 39, 0.04);
    }
    .strategy-adjustment .field input:focus,
    .strategy-adjustment .field select:focus {
      outline: none;
      border-color: #5f9bd7;
      box-shadow: 0 0 0 3px rgba(95, 155, 215, 0.16);
      background: #fff;
    }
    .strategy-adjustment .checkbox-field {
      min-height: 38px;
      justify-content: center;
      padding: 0 8px;
      border: 1px solid #ccd7e3;
      border-radius: 8px;
      background: #fbfdff;
      font-size: 12px;
    }
    .grid-level-settings {
      grid-column: 1 / -1;
      display: grid;
      gap: 8px;
    }
    .grid-level-settings-details {
      grid-column: 1 / -1;
    }
    .grid-level-settings-toggle {
      cursor: pointer;
      list-style: none;
    }
    .grid-level-settings-toggle::-webkit-details-marker {
      display: none;
    }
    .grid-level-settings-toggle h3::after {
      content: "열기";
      margin-left: 8px;
      padding: 2px 8px;
      border-radius: 999px;
      background: #dbe8f5;
      color: #344153;
      font-size: 11px;
      font-weight: 800;
    }
    .grid-level-settings-details[open] .grid-level-settings-toggle h3::after {
      content: "닫기";
    }
    .grid-level-settings-details:not([open]) .grid-level-settings {
      display: none;
    }
    .grid-level-setting-row {
      display: grid;
      grid-template-columns: 72px repeat(4, minmax(112px, 1fr));
      gap: 8px;
      align-items: end;
      padding: 10px;
      border: 1px solid #dce5ef;
      border-radius: 8px;
      background: #fff;
    }
    .grid-level-setting-index {
      min-height: 38px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: #eef4fa;
      color: #344153;
      font-size: 12px;
      font-weight: 900;
    }
    .grid-level-setting-field label {
      min-height: auto;
      margin-bottom: 6px;
      font-size: 11px;
    }
    .grid-level-setting-field input {
      height: 36px;
    }
    .strategy-adjustment .form-actions {
      padding-top: 4px;
    }
    .strategy-adjustment .form-status {
      margin: 0;
      padding: 0 16px 16px;
      background: #f8fafc;
    }
    .strategy-adjustment > .settings-section {
      margin: 0 16px;
      padding-top: 12px;
    }
    .strategy-adjustment > .field {
      margin: 12px 16px;
    }
    .strategy-adjustment > .form-status:last-child {
      padding-bottom: 18px;
    }
    .strategy-adjustment .funding-preview {
      margin-top: 0;
    }
    .extension-form {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 12px;
      align-items: end;
      margin-top: 12px;
    }
    table { width: 100%; border-collapse: collapse; min-width: 760px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: center; font-size: 13px; white-space: nowrap; }
    th { color: var(--muted); background: #fbfcfd; font-weight: 700; }
    tr:last-child td { border-bottom: 0; }
    .badge { display: inline-block; min-width: 64px; padding: 3px 8px; border-radius: 999px; font-size: 12px; text-align: center; font-weight: 700; }
    .waiting { color: var(--muted); background: #eef1f4; }
    .open { color: var(--blue); background: #e8f2fb; }
    .sold { color: var(--green); background: #e8f5ee; }
    .cmd-log {
      min-height: 96px;
      background: #111820;
      color: #dce8f2;
      border-radius: 8px;
      padding: 14px;
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
      line-height: 1.65;
      overflow-x: auto;
      white-space: nowrap;
      border: 1px solid #263545;
      text-align: left;
    }
    .cmd-log .log-lines {
      transform: translateY(0);
      opacity: 1;
    }
    .cmd-log.is-moving .log-lines {
      transform: translateY(-18px);
      opacity: 0.35;
      transition: transform 180ms ease, opacity 180ms ease;
    }
    .cmd-log .empty { color: #94a7b8; }
    .warning { border: 1px solid #f0d28a; background: #fff8df; color: var(--amber); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
    .error { color: var(--red); }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(24, 32, 42, 0.48);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      z-index: 20;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      width: min(920px, 100%);
      max-height: min(720px, calc(100vh - 36px));
      overflow: auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 20px 60px rgba(24, 32, 42, 0.28);
      padding: 18px;
    }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .modal-close {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 6px;
      width: 36px;
      height: 36px;
      cursor: pointer;
      font-size: 18px;
    }
    @media (max-width: 860px) {
      header { display: block; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .insight-grid { grid-template-columns: 1fr; }
      .range-form { grid-template-columns: 1fr 1fr; }
      .strategy-setting-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .settings-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .log-head { grid-template-columns: 1fr; }
      .telegram-form { grid-template-columns: 1fr 1fr; }
      .telegram-routing-form { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .bithumb-form { grid-template-columns: 1fr 1fr; }
      .bithumb-test-actions { grid-template-columns: 1fr 1fr; }
      .grid-level-setting-row { grid-template-columns: 60px repeat(2, minmax(0, 1fr)); }
      .extension-form { grid-template-columns: 1fr; }
      .funding-preview { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 520px) {
      header, main { width: min(100% - 20px, 1180px); }
      .grid { grid-template-columns: 1fr; }
      .metric-row { grid-template-columns: 1fr; }
      .metric-value { font-size: 18px; }
      .strategy-setting-grid { grid-template-columns: 1fr; }
      .settings-form { grid-template-columns: 1fr; }
      .telegram-form { grid-template-columns: 1fr; }
      .telegram-routing-form { grid-template-columns: 1fr; }
      .bithumb-form { grid-template-columns: 1fr; }
      .bithumb-test-actions { grid-template-columns: 1fr; }
      .grid-level-setting-row { grid-template-columns: 1fr; }
      .funding-preview { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Bithumb Grid Farmer</h1>
      <div class="muted">페이퍼 거래 대시보드 · 로그 자동 갱신</div>
    </div>
    <div class="control-row">
      <a class="button secondary" href="/backtests">백테스트 대시보드</a>
      <div id="summary-generated-at" class="muted">생성 시각 ${formatDate(summary.generatedAt)}</div>
    </div>
  </header>
  <main>
    ${warnings}
    <section class="section">
      <div class="log-head">
        <h2>최근 로그</h2>
        <div class="telegram-panel">
          <div class="telegram-form">
            <input id="telegram-token" type="password" autocomplete="off" placeholder="봇 토큰">
            <input id="telegram-chat-id" type="password" autocomplete="off" placeholder="채팅 ID">
            <button id="telegram-save" class="button secondary" type="button">저장</button>
            <button id="telegram-toggle" class="button secondary" type="button">불러오는 중...</button>
            <button id="telegram-test" class="button" type="button">테스트</button>
          </div>
          <div class="telegram-routing-form">
            <label class="telegram-routing-field" for="telegram-grid-buy-mode">
              그리드 매수 알림
              <select id="telegram-grid-buy-mode">
                <option value="batch">묶음</option>
                <option value="immediate">즉시</option>
                <option value="off">끄기</option>
              </select>
            </label>
            <label class="telegram-routing-field" for="telegram-grid-sell-mode">
              그리드 매도 알림
              <select id="telegram-grid-sell-mode">
                <option value="immediate">즉시</option>
                <option value="batch">묶음</option>
                <option value="off">끄기</option>
              </select>
            </label>
            <label class="telegram-routing-field" for="telegram-grid-batch-size">
              묶음 기준
              <input id="telegram-grid-batch-size" type="number" min="1" max="100" step="1" value="${DEFAULT_TELEGRAM_GRID_BATCH_SIZE}">
            </label>
          </div>
          <div id="telegram-status" class="form-status">텔레그램 설정은 서버에서 불러옵니다.</div>
        </div>
      </div>
        <div class="telegram-panel">
          <div class="bithumb-form">
            <input id="bithumb-access-key" type="password" autocomplete="off" placeholder="Bithumb access key">
            <input id="bithumb-secret-key" type="password" autocomplete="off" placeholder="Bithumb secret key">
            <button id="bithumb-save" class="button secondary" type="button">저장</button>
            <button id="bithumb-test" class="button" type="button">연결 확인</button>
            <div class="bithumb-test-actions">
              <button id="bithumb-test-buy" class="button live-buy" type="button">10,000원 실시간 매수 테스트</button>
              <button id="bithumb-test-sell" class="button live-sell" type="button">매수분 실시간 매도 테스트</button>
            </div>
          </div>
          <div id="bithumb-status" class="form-status">Bithumb API 키 설정을 서버에서 불러옵니다.</div>
        </div>
      <div id="log-tail" class="cmd-log"><div id="log-tail-lines" class="log-lines">${commandLogRows || `<div class="empty">아직 PM2 로그가 없습니다. pm2 logs bithumb-grid-bot-paper를 확인하세요.</div>`}</div></div>
    </section>
    <section class="metric-group">
      <div class="metric-group-head">기본 정보</div>
      <div class="metric-row">
        <div class="panel"><div class="metric-label">거래소</div><div class="metric-value">Bithumb</div></div>
        <div class="panel"><div class="metric-label">마켓</div><div id="market-value" class="metric-value">${escapeHtml(state?.market ?? "-")}</div></div>
        <div class="panel"><div class="metric-label">현재 단계</div><div id="current-phase-value" class="metric-value" data-phase="${escapeHtml(state?.phase ?? "")}">${escapeHtml(formatPhaseKo(state?.phase))}</div></div>
        <div class="panel"><div class="metric-label">마지막 루프</div><div id="last-loop-value" class="metric-value">${formatDate(state?.lastLoopAt)}</div></div>
      </div>
    </section>
    <section class="metric-group">
      <div class="metric-group-head">계좌 정보</div>
      <div class="metric-row">
        <div class="panel"><div class="metric-label">계좌 평가금액</div><div id="account-capital-value" class="metric-value">${formatKrw(accountCapitalKrw)}</div></div>
        <div class="panel"><div class="metric-label">주문 가능 KRW</div><div id="account-krw-available-value" class="metric-value">${formatKrw(accountKrwAvailable)}</div></div>
        <div class="panel"><div class="metric-label">잠김 KRW</div><div id="account-krw-locked-value" class="metric-value">${formatKrw(accountKrwLocked)}</div></div>
        <div class="panel"><div class="metric-label">BTC 보유 수량</div><div id="account-asset-qty-value" class="metric-value">${accountAssetQty == null ? "-" : `${accountAssetQty.toFixed(8)} BTC`}</div></div>
      </div>
      <div class="metric-row metric-row-follow">
        <div class="panel"><div class="metric-label">BTC 평가금액</div><div id="account-asset-value-value" class="metric-value">${formatKrw(accountAssetValueKrw)}</div></div>
        <div class="panel"><div class="metric-label">전략 기준 자본</div><div id="account-strategy-capital-value" class="metric-value">${formatKrw(state?.totalCapitalKrw)}</div></div>
        <div class="panel"><div class="metric-label">기본 차수별 매수 금액</div><div id="account-grid-order-amount-value" class="metric-value">${formatKrw(calculatedGridOrderAmountKrw)}</div></div>
        <div class="panel"><div class="metric-label">평가 기준 시각</div><div id="account-updated-at-value" class="metric-value">${formatDate(accountUpdatedAt)}</div></div>
      </div>
    </section>
    <section class="metric-group">
      <div class="metric-group-head">실현 손익</div>
      <div class="metric-row">
        <div class="panel ${pnlToneClass(summary.totals.realizedPnlKrw)}"><div class="metric-label">전체 실현 손익</div><div id="realized-pnl-krw-value" class="metric-value">${formatKrw(summary.totals.realizedPnlKrw)}</div></div>
        <div class="panel ${pnlToneClass(summary.totals.realizedPnlPct)}"><div class="metric-label">전체 수익률</div><div id="realized-pnl-pct-value" class="metric-value">${formatPct(summary.totals.realizedPnlPct)}</div></div>
        <div class="panel ${pnlToneClass(summary.totals.todayRealizedPnlKrw)}"><div class="metric-label">오늘 실현 손익</div><div id="today-realized-pnl-krw-value" class="metric-value">${formatKrw(summary.totals.todayRealizedPnlKrw)}</div></div>
        <div class="panel ${pnlToneClass(summary.totals.todayRealizedPnlPct)}"><div class="metric-label">오늘 수익률</div><div id="today-realized-pnl-pct-value" class="metric-value">${formatPct(summary.totals.todayRealizedPnlPct)}</div></div>
      </div>
    </section>
    <section class="metric-group">
      <div class="metric-group-head">보유 현황</div>
      <div class="metric-row">
        <div class="panel"><div class="metric-label">보유 원금</div><div id="holding-cost-value" class="metric-value">${formatKrw(summary.totals.holdingCostKrw)}</div></div>
        <div class="panel"><div class="metric-label">평가 금액</div><div id="holding-value-value" class="metric-value">${formatKrw(summary.totals.holdingValueKrw)}</div></div>
        <div class="panel ${pnlToneClass(summary.totals.holdingPnlKrw)}"><div class="metric-label">평가 손익</div><div id="holding-pnl-krw-value" class="metric-value">${formatKrw(summary.totals.holdingPnlKrw)}</div></div>
        <div class="panel ${pnlToneClass(summary.totals.holdingPnlPct)}"><div class="metric-label">평가 수익률</div><div id="holding-pnl-pct-value" class="metric-value">${formatPct(summary.totals.holdingPnlPct)}</div></div>
      </div>
    </section>
    <section class="metric-group">
      <div class="metric-group-head">그리드 상태</div>
      <div class="metric-row">
        <div class="panel"><div class="metric-label">현재가</div><div class="metric-value js-last-price">${formatKrw(state?.lastPrice)}</div></div>
        <div class="panel"><div class="metric-label">다음 그리드 진입가</div><div id="next-grid-entry-value" class="metric-value">${formatKrw(nextGridEntry)}</div></div>
        <div class="panel"><div class="metric-label">레이어 상태</div><div id="layer-status-value" class="metric-value">${waitingLayerCount} / ${summary.totals.openLayers}</div><div class="muted">대기 / 보유</div></div>
        <div class="panel"><div class="metric-label">매수 / 매도 횟수</div><div id="trade-count-value" class="metric-value">${summary.totals.buyCount} / ${summary.totals.sellCount}</div></div>
      </div>
    </section>
    <section class="metric-group">
      <div class="metric-group-head">농부 상태</div>
      <div class="metric-row">
        <div class="panel"><div class="metric-label">현재가</div><div class="metric-value js-last-price">${formatKrw(state?.lastPrice)}</div></div>
        <div class="panel"><div class="metric-label">직전 매수가</div><div id="farmer-last-buy-price-value" class="metric-value">${formatKrw(farmerLastBuyPrice)}</div></div>
        <div class="panel ${enabledToneClass(farmerUsePriceReachedFilter)}"><div class="metric-label">다음 농부 진입가</div><div id="next-farmer-entry-value" class="metric-value">${formatKrw(nextFarmerEntryPrice)}</div><div id="farmer-entry-pct-muted" class="muted">필요 하락률 -${(farmerEntryPct * 100).toFixed(2)}%</div></div>
        <div class="panel"><div class="metric-label">농부 차수</div><div id="farmer-stage-value" class="metric-value">${state?.farmerStage ?? 0} / ${maxFarmerStages}</div></div>
      </div>
    </section>
    <section class="insight-grid section">
      <div id="calendar-panel" class="panel">${dailyPnlCalendar}</div>
      <div id="trend-panel" class="panel">${pnlChart}</div>
    </section>
    <section class="section panel settings-card">
      <h2>전략 설정</h2>
      <div id="strategy-funding-summary" class="funding-preview strategy-funding-summary"></div>
      <div id="strategy-fixed-summary" class="strategy-setting-grid strategy-fixed-grid grid-condition-cards">
        ${strategyFixedSummary}
      </div>
      <div id="strategy-toggle-summary" class="strategy-setting-grid">
        ${strategyToggleSummary}
      </div>
      <details class="strategy-adjustment">
        <summary><span class="strategy-summary-title">전략 조정</span><button id="grid-settings-submit" class="button strategy-summary-save" type="submit" form="grid-settings-form">저장</button></summary>
        <form id="grid-settings-form" class="settings-form">
          <div class="settings-section"><h3>그리드 매수 설정</h3></div>
          <div id="grid-settings-summary" class="strategy-setting-grid grid-condition-cards grid-settings-summary">
            ${gridConditionCards}
          </div>
          <div class="field">
            <label for="grid-levels">그리드 차수</label>
            <input id="grid-levels" name="gridLevels" type="number" min="1" max="100" step="1" value="${gridLevelCount}">
          </div>
          <div class="field">
            <label for="grid-gap-pct">차수 간격(%)</label>
            <input id="grid-gap-pct" name="gapPct" type="number" min="0.1" max="20" step="0.1" value="${currentGapPct == null ? "" : (currentGapPct * 100).toFixed(2)}">
          </div>
          <div class="field">
            <label>차수별 매수 금액(KRW)</label>
            <div id="grid-order-amount" class="readonly-metric" data-value="${calculatedGridOrderAmountKrw ?? ""}">${formatKrw(calculatedGridOrderAmountKrw)}</div>
            <div class="muted">계좌 평가금액 × 15.8% ÷ 차수별 배수 합계로 자동 계산됩니다.</div>
          </div>
          <div class="field">
            <label for="grid-loop-interval">Grid 점검 간격(초)</label>
            <input id="grid-loop-interval" name="gridLoopIntervalSeconds" type="number" min="60" max="86400" step="1" value="${gridLoopIntervalSeconds}">
          </div>
          <details class="grid-level-settings-details">
            <summary class="settings-section grid-level-settings-toggle"><h3>차수별 Grid 설정</h3></summary>
            <div id="grid-level-settings" class="grid-level-settings" data-settings="${gridLevelSettingsJson}"></div>
          </details>
          <div class="settings-section"><h3>농부 매수 설정</h3></div>
          <div class="field">
            <label for="farmer-stages">농부 최대 매수 차수</label>
            <input id="farmer-stages" name="maxFarmerStages" type="number" min="0" max="10" step="1" value="${maxFarmerStages}">
          </div>
          <div class="field">
            <label for="farmer-entry-pct">농부 진입 하락률(%)</label>
            <input id="farmer-entry-pct" name="farmerEntryPct" type="number" min="1" max="90" step="0.1" value="${(farmerEntryPct * 100).toFixed(2)}">
          </div>
          <div class="field">
            <label for="farmer-max-3d-drawdown-pct">3일 급락 제한(%)</label>
            <input id="farmer-max-3d-drawdown-pct" name="farmerMax3dDrawdownPct" type="number" min="1" max="90" step="0.1" value="${Math.abs(farmerMax3dDrawdownPct * 100).toFixed(2)}">
          </div>
          <div class="field">
            <label for="farmer-stage2-cooldown-days">2차 쿨다운(일)</label>
            <input id="farmer-stage2-cooldown-days" name="farmerStage2CooldownDays" type="number" min="0" max="365" step="1" value="${farmerStage2CooldownDays}">
          </div>
          <div class="field">
            <label for="farmer-stage3-cooldown-days">3차 이후 쿨다운(일)</label>
            <input id="farmer-stage3-cooldown-days" name="farmerStage3CooldownDays" type="number" min="0" max="365" step="1" value="${farmerStage3CooldownDays}">
          </div>
          <div class="field">
            <label for="farming-loop-interval">Farming 루프 간격(초)</label>
            <input id="farming-loop-interval" name="farmingLoopIntervalSeconds" type="number" min="10" max="86400" step="10" value="${farmingLoopIntervalSeconds}">
          </div>
          <div class="settings-section"><h3>농부 매수 조건</h3></div>
          <div class="field">
            <label for="farmer-use-price-reached-filter">농부 진입 가격 미도달</label>
            <label class="checkbox-field"><input id="farmer-use-price-reached-filter" name="farmerUsePriceReachedFilter" type="checkbox" ${farmerUsePriceReachedFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="field">
            <label for="farmer-use-long-trend-filter">장기 추세 조건 미충족</label>
            <label class="checkbox-field"><input id="farmer-use-long-trend-filter" name="farmerUseLongTrendFilter" type="checkbox" ${farmerUseLongTrendFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="field">
            <label for="farmer-use-turnover-ratio-filter">거래대금 증가 조건 미충족</label>
            <label class="checkbox-field"><input id="farmer-use-turnover-ratio-filter" name="farmerUseTurnoverRatioFilter" type="checkbox" ${farmerUseTurnoverRatioFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="field">
            <label for="farmer-use-ma5-trend-filter">MA5 단기 추세 조건 미충족</label>
            <label class="checkbox-field"><input id="farmer-use-ma5-trend-filter" name="farmerUseMa5TrendFilter" type="checkbox" ${farmerUseMa5TrendFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="field">
            <label for="farmer-use-close-position-filter">종가 위치 조건 미충족</label>
            <label class="checkbox-field"><input id="farmer-use-close-position-filter" name="farmerUseClosePositionFilter" type="checkbox" ${farmerUseClosePositionFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="field">
            <label for="farmer-use-bullish-daily-filter">일봉 양봉 조건 미충족</label>
            <label class="checkbox-field"><input id="farmer-use-bullish-daily-filter" name="farmerUseBullishDailyFilter" type="checkbox" ${farmerUseBullishDailyFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="field">
            <label for="farmer-use-two-bullish-daily-filter">2일 연속 양봉 조건 미충족</label>
            <label class="checkbox-field"><input id="farmer-use-two-bullish-daily-filter" name="farmerUseTwoBullishDailyFilter" type="checkbox" ${farmerUseTwoBullishDailyFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="field">
            <label for="farmer-use-volatility-explosion-filter">변동성 폭발 구간</label>
            <label class="checkbox-field"><input id="farmer-use-volatility-explosion-filter" name="farmerUseVolatilityExplosionFilter" type="checkbox" ${farmerUseVolatilityExplosionFilter ? "checked" : ""}> 매수 필터 적용</label>
          </div>
          <div class="settings-section"><h3>터틀 매도 조건</h3></div>
          <div class="field">
            <label for="recovery-turtle-sell">회복 터틀 매도</label>
            <label class="checkbox-field"><input id="recovery-turtle-sell" name="enableRecoveryTurtleSell" type="checkbox" ${enableRecoveryTurtleSell ? "checked" : ""}> 매도 조건 사용</label>
          </div>
          <div class="field">
            <label for="recovery-use-2n-trail-exit">2N 트레일링 이탈</label>
            <label class="checkbox-field"><input id="recovery-use-2n-trail-exit" name="recoveryUse2NTrailExit" type="checkbox" ${recoveryUse2NTrailExit ? "checked" : ""}> 매도 조건 사용</label>
          </div>
          <div class="field">
            <label for="recovery-trailing-activation-mode">2N 트레일링 시작 조건</label>
            <select id="recovery-trailing-activation-mode" name="recoveryTrailingActivationMode">
              <option value="PROFIT_POSITIVE" ${recoveryTrailingActivationMode === "PROFIT_POSITIVE" ? "selected" : ""}>수익률이 양수일 때</option>
              <option value="TP1" ${recoveryTrailingActivationMode === "TP1" ? "selected" : ""}>1차 익절 수익률(T1%) 이상</option>
              <option value="TP2" ${recoveryTrailingActivationMode === "TP2" ? "selected" : ""}>2차 익절 수익률(T2%) 이상</option>
            </select>
          </div>
          <div class="field">
            <label for="recovery-use-ma5-exit">일봉 종가 MA5 하회</label>
            <label class="checkbox-field"><input id="recovery-use-ma5-exit" name="recoveryUseMa5Exit" type="checkbox" ${recoveryUseMa5Exit ? "checked" : ""}> 매도 조건 사용</label>
          </div>
          <div class="field">
            <label for="recovery-use-low-breakout-exit">N일 최저가 이탈</label>
            <label class="checkbox-field"><input id="recovery-use-low-breakout-exit" name="recoveryUseLowBreakoutExit" type="checkbox" ${recoveryUseLowBreakoutExit ? "checked" : ""}> 매도 조건 사용</label>
          </div>
          <div class="field">
            <label for="recovery-turtle-n-period">터틀 N 기간(일)</label>
            <input id="recovery-turtle-n-period" name="recoveryTurtleNPeriod" type="number" min="5" max="100" step="1" value="${recoveryTurtleNPeriod}">
          </div>
          <div class="field">
            <label for="recovery-turtle-low-breakout-period">N일 최저가 이탈 기간</label>
            <input id="recovery-turtle-low-breakout-period" name="recoveryTurtleLowBreakoutPeriod" type="number" min="5" max="200" step="1" value="${recoveryTurtleLowBreakoutPeriod}">
          </div>
          <div class="field">
            <label for="recovery-turtle-n-multiplier">트레일링 N 배수</label>
            <input id="recovery-turtle-n-multiplier" name="recoveryTurtleNMultiplier" type="number" min="0.5" max="10" step="0.1" value="${recoveryTurtleNMultiplier}">
          </div>
          <div class="field">
            <label for="recovery-turtle-min-order">터틀 최소 주문 금액(KRW)</label>
            <input id="recovery-turtle-min-order" name="recoveryTurtleMinOrderKrw" type="number" min="5000" step="1000" value="${recoveryTurtleMinOrderKrw}">
          </div>
          <div class="field">
            <label for="recovery-use-slice-order">분할 주문</label>
            <label class="checkbox-field"><input id="recovery-use-slice-order" name="recoveryUseSliceOrder" type="checkbox" ${recoveryUseSliceOrder ? "checked" : ""}> 사용</label>
          </div>
          <div class="field">
            <label for="recovery-turtle-slice-order">분할 주문 금액(KRW)</label>
            <input id="recovery-turtle-slice-order" name="recoveryTurtleSliceOrderKrw" type="number" min="5000" step="10000" value="${recoveryTurtleSliceOrderKrw}">
          </div>
          <div class="field">
            <label for="recovery-turtle-slice-interval">분할 주문 간격(초)</label>
            <input id="recovery-turtle-slice-interval" name="recoveryTurtleSliceIntervalSeconds" type="number" min="0" max="3600" step="1" value="${recoveryTurtleSliceIntervalSeconds}">
          </div>
          <div class="settings-section"><h3>부분 익절 설정</h3></div>
          <div class="field">
            <label for="partial-take-profit">부분 익절</label>
            <label class="checkbox-field"><input id="partial-take-profit" name="partialTakeProfitEnabled" type="checkbox" ${partialTakeProfitEnabled ? "checked" : ""}> 사용</label>
          </div>
          <div class="field">
            <label for="tp1-return-pct">1차 익절 수익률(%)</label>
            <input id="tp1-return-pct" name="takeProfit1ReturnPct" type="number" min="1" max="1000" step="0.1" value="${(takeProfit1ReturnPct * 100).toFixed(2)}">
          </div>
          <div class="field">
            <label for="tp1-sell-ratio">1차 익절 매도 비율(%)</label>
            <input id="tp1-sell-ratio" name="takeProfit1SellRatio" type="number" min="1" max="100" step="1" value="${(takeProfit1SellRatio * 100).toFixed(0)}">
          </div>
          <div class="field">
            <label for="tp2-return-pct">2차 익절 수익률(%)</label>
            <input id="tp2-return-pct" name="takeProfit2ReturnPct" type="number" min="1" max="1000" step="0.1" value="${(takeProfit2ReturnPct * 100).toFixed(2)}">
          </div>
          <div class="field">
            <label for="tp2-sell-ratio">2차 익절 매도 비율(%)</label>
            <input id="tp2-sell-ratio" name="takeProfit2SellRatio" type="number" min="1" max="100" step="1" value="${(takeProfit2SellRatio * 100).toFixed(0)}">
          </div>
          <div id="funding-preview" class="funding-preview"></div>
        </form>
        <div id="grid-settings-status" class="form-status">전략 설정은 저장 즉시 적용됩니다. 차수별 매수 금액은 계좌 평가금액과 차수별 배수 합계 기준으로 자동 계산됩니다.</div>
        <div class="settings-section"><h3>그리드 전체 리셋</h3></div>
        <div class="field">
          <label>보유 중인 그리드 포지션 전량 매도</label>
          <button id="grid-reset-button" class="button secondary" type="button">그리드 전체 리셋 실행</button>
        </div>
        <div id="grid-reset-status" class="form-status">리셋을 실행하면 OPEN 상태의 Grid 포지션을 현재가 기준 시장가로 즉시 매도하고 Grid 단계로 전환합니다.</div>
        <div class="settings-section"><h3>실현 손익 리셋</h3></div>
        <div class="field">
          <label>기존 실현 손익 기록 삭제</label>
          <button id="realized-pnl-reset-button" class="button danger" type="button">실현 손익 리셋 실행</button>
        </div>
        <div id="realized-pnl-reset-status" class="form-status">리셋을 실행하면 기존 Grid/Recovery 매도 손익 기록을 삭제하고 이후 거래부터 다시 집계합니다.</div>
      </details>
    </section>
    ${state?.lastError ? `<section class="section panel error">${escapeHtml(state.lastError)}</section>` : ""}
    <section class="section">
      <h2>최근 실거래 로그 <span class="summary-meta">현재 사이클 ${summary.recentTrades.length}개</span></h2>
      <div class="table-wrap scroll-table">
        <table>
          <thead><tr><th>시각</th><th>동작</th><th>차수</th><th>가격</th><th>금액</th><th>손익</th><th>수익률</th></tr></thead>
          <tbody>${tradeRows || `<tr><td colspan="7">현재 사이클의 매수/매도 로그가 없습니다. Grid 리셋 후 새 사이클은 여기서 0부터 표시됩니다.</td></tr>`}</tbody>
        </table>
      </div>
    </section>
    <section class="section">
      <h2>보유 중인 그리드 <span class="summary-meta">${openLayers.length}개 보유</span></h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>상태</th><th>매수가</th><th>매도가</th><th>금액</th><th>수량</th><th>매수/매도</th><th>미실현 손익</th><th>미실현 수익률</th></tr></thead>
          <tbody>${openLayerRows || `<tr><td colspan="9">보유 중인 그리드가 없습니다.</td></tr>`}</tbody>
        </table>
      </div>
    </section>
    <details class="section">
      <summary>
        <span class="summary-title">대기 중인 그리드</span>
        <span class="summary-meta">${inactiveLayers.length}개 레이어, 클릭해서 펼치기 <span class="chevron">v</span></span>
      </summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>상태</th><th>매수가</th><th>매도가</th><th>금액</th><th>수량</th><th>매수/매도</th><th>미실현 손익</th><th>미실현 수익률</th></tr></thead>
          <tbody>${inactiveLayerRows || `<tr><td colspan="9">No waiting grid levels.</td></tr>`}</tbody>
        </table>
      </div>
    </details>
  </main>
  <script>
    const logTail = document.getElementById("log-tail");
    const logTailLines = document.getElementById("log-tail-lines");
    const currentPhaseValue = document.getElementById("current-phase-value");
    let currentDashboardPhase = currentPhaseValue ? currentPhaseValue.dataset.phase || "" : "";
    const liveMetricIds = {
      generatedAt: "summary-generated-at",
      market: "market-value",
      lastLoopAt: "last-loop-value",
      accountCapital: "account-capital-value",
      accountKrwAvailable: "account-krw-available-value",
      accountKrwLocked: "account-krw-locked-value",
      accountAssetQty: "account-asset-qty-value",
      accountAssetValue: "account-asset-value-value",
      accountStrategyCapital: "account-strategy-capital-value",
      accountGridOrderAmount: "account-grid-order-amount-value",
      accountUpdatedAt: "account-updated-at-value",
      realizedPnlKrw: "realized-pnl-krw-value",
      realizedPnlPct: "realized-pnl-pct-value",
      todayRealizedPnlKrw: "today-realized-pnl-krw-value",
      todayRealizedPnlPct: "today-realized-pnl-pct-value",
      holdingCost: "holding-cost-value",
      holdingValue: "holding-value-value",
      holdingPnlKrw: "holding-pnl-krw-value",
      holdingPnlPct: "holding-pnl-pct-value",
      nextGridEntry: "next-grid-entry-value",
      layerStatus: "layer-status-value",
      tradeCount: "trade-count-value",
      farmerLastBuyPrice: "farmer-last-buy-price-value",
      nextFarmerEntry: "next-farmer-entry-value",
      farmerEntryPctMuted: "farmer-entry-pct-muted",
      farmerStage: "farmer-stage-value",
    };
    const gridSettingsForm = document.getElementById("grid-settings-form");
    const gridSettingsSubmitButton = document.getElementById("grid-settings-submit");
    const gridSettingsStatus = document.getElementById("grid-settings-status");
    const gridResetButton = document.getElementById("grid-reset-button");
    const gridResetStatus = document.getElementById("grid-reset-status");
    const realizedPnlResetButton = document.getElementById("realized-pnl-reset-button");
    const realizedPnlResetStatus = document.getElementById("realized-pnl-reset-status");
    const orderAmountDisplay = document.getElementById("grid-order-amount");
    const gridLevelsInput = document.getElementById("grid-levels");
    const gridGapPctInput = document.getElementById("grid-gap-pct");
    const gridLevelSettingsContainer = document.getElementById("grid-level-settings");
    const farmerStagesInput = document.getElementById("farmer-stages");
    const farmerEntryPctInput = document.getElementById("farmer-entry-pct");
    const fundingPreview = document.getElementById("funding-preview");
    const strategyFundingSummary = document.getElementById("strategy-funding-summary");
    const strategyFixedSummary = document.getElementById("strategy-fixed-summary");
    const gridSettingsSummary = document.getElementById("grid-settings-summary");
    const strategyToggleSummary = document.getElementById("strategy-toggle-summary");
    const farmerUsePriceReachedInput = document.getElementById("farmer-use-price-reached-filter");
    const farmerUseLongTrendInput = document.getElementById("farmer-use-long-trend-filter");
    const farmerUseTurnoverRatioInput = document.getElementById("farmer-use-turnover-ratio-filter");
    const farmerUseMa5TrendInput = document.getElementById("farmer-use-ma5-trend-filter");
    const farmerUseClosePositionInput = document.getElementById("farmer-use-close-position-filter");
    const farmerUseBullishDailyInput = document.getElementById("farmer-use-bullish-daily-filter");
    const farmerUseTwoBullishDailyInput = document.getElementById("farmer-use-two-bullish-daily-filter");
    const farmerUseVolatilityExplosionInput = document.getElementById("farmer-use-volatility-explosion-filter");
    const enableRecoveryTurtleSellInput = document.getElementById("recovery-turtle-sell");
    const recoveryUse2NTrailExitInput = document.getElementById("recovery-use-2n-trail-exit");
    const recoveryTrailingActivationModeInput = document.getElementById("recovery-trailing-activation-mode");
    const recoveryUseMa5ExitInput = document.getElementById("recovery-use-ma5-exit");
    const recoveryUseLowBreakoutExitInput = document.getElementById("recovery-use-low-breakout-exit");
    const recoveryTurtleNMultiplierInput = document.getElementById("recovery-turtle-n-multiplier");
    const recoveryTurtleLowBreakoutPeriodInput = document.getElementById("recovery-turtle-low-breakout-period");
    const recoveryUseSliceOrderInput = document.getElementById("recovery-use-slice-order");
    const recoveryTurtleSliceOrderInput = document.getElementById("recovery-turtle-slice-order");
    const recoveryTurtleSliceIntervalInput = document.getElementById("recovery-turtle-slice-interval");
    const partialTakeProfitInput = document.getElementById("partial-take-profit");
    const tp1ReturnInput = document.getElementById("tp1-return-pct");
    const tp1SellRatioInput = document.getElementById("tp1-sell-ratio");
    const tp2ReturnInput = document.getElementById("tp2-return-pct");
    const tp2SellRatioInput = document.getElementById("tp2-sell-ratio");
    const partialTakeProfitFields = [
      tp1ReturnInput,
      tp1SellRatioInput,
      tp2ReturnInput,
      tp2SellRatioInput,
    ].filter(Boolean);
    const telegramTokenInput = document.getElementById("telegram-token");
    const telegramChatIdInput = document.getElementById("telegram-chat-id");
    const telegramSave = document.getElementById("telegram-save");
    const telegramToggle = document.getElementById("telegram-toggle");
    const telegramTest = document.getElementById("telegram-test");
    const telegramStatus = document.getElementById("telegram-status");
    const telegramGridBuyModeInput = document.getElementById("telegram-grid-buy-mode");
    const telegramGridSellModeInput = document.getElementById("telegram-grid-sell-mode");
    const telegramGridBatchSizeInput = document.getElementById("telegram-grid-batch-size");
    const bithumbAccessKeyInput = document.getElementById("bithumb-access-key");
    const bithumbSecretKeyInput = document.getElementById("bithumb-secret-key");
    const bithumbSave = document.getElementById("bithumb-save");
    const bithumbTest = document.getElementById("bithumb-test");
    const bithumbTestBuy = document.getElementById("bithumb-test-buy");
    const bithumbTestSell = document.getElementById("bithumb-test-sell");
    const bithumbStatus = document.getElementById("bithumb-status");
    const emptyLogMessage = "No grid bot PM2 log lines yet. Check pm2 logs bithumb-grid-bot-paper.";
    let telegramEnabled = true;
    let bithumbLastLiveTestBuyQty = 0;
    let bithumbLastLiveTestBuyMarket = "";
    const defaultGridRatio = ${DEFAULT_GRID_RATIO};
    let strategyTotalCapitalKrw = ${state?.totalCapitalKrw ?? 0};

    const tradeModal = document.createElement("div");
    tradeModal.className = "modal-backdrop";
    tradeModal.innerHTML = '<div class="modal"><div class="modal-head"><h2 id="trade-modal-title">일별 거래 내역</h2><button class="modal-close" type="button">x</button></div><div id="trade-modal-body"></div></div>';
    document.body.appendChild(tradeModal);
    const tradeModalTitle = document.getElementById("trade-modal-title");
    const tradeModalBody = document.getElementById("trade-modal-body");
    tradeModal.querySelector(".modal-close").addEventListener("click", () => tradeModal.classList.remove("open"));
    tradeModal.addEventListener("click", (event) => {
      if (event.target === tradeModal) tradeModal.classList.remove("open");
    });

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function textOrDash(value) {
      return value == null || value === "" ? "-" : String(value);
    }

    function setMetricText(id, value) {
      const element = document.getElementById(id);
      if (element) element.textContent = textOrDash(value);
    }

    function setMetricTextAll(selector, value) {
      document.querySelectorAll(selector).forEach((element) => {
        element.textContent = textOrDash(value);
      });
    }

    function setPanelTone(id, value) {
      const element = document.getElementById(id);
      const panel = element ? element.closest(".panel") : null;
      if (!panel) return;
      panel.classList.remove("tone-profit", "tone-loss");
      if (!Number.isFinite(value) || value === 0) return;
      panel.classList.add(value > 0 ? "tone-profit" : "tone-loss");
    }

    function formatDate(value) {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "-";
      return new Intl.DateTimeFormat("ko-KR", {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone: "Asia/Seoul",
      }).format(date);
    }

    function formatPct(value) {
      return Number.isFinite(value) ? value.toFixed(2) + "%" : "-";
    }

    function formatPhaseKo(value) {
      if (value === "GRID") return "그리드";
      if (value === "FARMING") return "농부 매수";
      if (value === "HOLDING") return "보유";
      if (value === "COOLDOWN") return "쿨다운";
      return value || "-";
    }

    function getNextGridEntry(layers) {
      if (!Array.isArray(layers)) return null;
      const nextLayer = layers
        .filter((layer) => layer && (layer.status === "WAITING" || layer.status === "SOLD"))
        .sort((left, right) => Number(left.idx || 0) - Number(right.idx || 0))[0];
      return nextLayer && Number.isFinite(Number(nextLayer.buyPrice)) ? Number(nextLayer.buyPrice) : null;
    }

    function getLastGridBuyPrice(state) {
      const layers = state && Array.isArray(state.layers) ? state.layers : [];
      if (!layers.length) return null;
      const activeLayer = layers
        .filter((layer) => layer && (Number(layer.qty || 0) > 0 || layer.status === "OPEN"))
        .sort((left, right) => Number(right.idx || 0) - Number(left.idx || 0))[0];
      const fallbackLayer = layers
        .slice()
        .sort((left, right) => Number(right.idx || 0) - Number(left.idx || 0))[0];
      const layer = activeLayer || fallbackLayer;
      if (!layer) return null;
      const qty = Number(layer.qty || 0);
      const amountKrw = Number(layer.amountKrw || 0);
      if (qty > 0 && amountKrw > 0) return amountKrw / qty;
      const buyPrice = Number(layer.buyPrice);
      return Number.isFinite(buyPrice) && buyPrice > 0 ? buyPrice : null;
    }

    function getFarmerLastBuyPrice(state) {
      if (!state) return null;
      if (Number(state.farmerStage || 0) === 0) {
        return state.farmerAnchorPrice ?? getLastGridBuyPrice(state);
      }
      return state.farmerAnchorPrice ?? state.farmerLastBuyPrice ?? null;
    }

    function getFarmerEntryPct(state) {
      const stateValue = Number(state && state.farmerEntryPct);
      if (Number.isFinite(stateValue)) return stateValue;
      const inputValue = Number(farmerEntryPctInput ? farmerEntryPctInput.value : NaN);
      return Number.isFinite(inputValue) ? inputValue / 100 : 0.1;
    }

    function getNextFarmerEntryPrice(state, farmerEntryPct) {
      if (!state) return null;
      const maxFarmerStages = Number.isFinite(Number(state.maxFarmerStages)) ? Number(state.maxFarmerStages) : 3;
      if (Number(state.farmerStage || 0) >= maxFarmerStages) return null;
      const lastBuyPrice = getFarmerLastBuyPrice(state);
      return Number.isFinite(lastBuyPrice) ? lastBuyPrice * (1 - farmerEntryPct) : null;
    }

    function refreshLiveMetrics(summary) {
      const state = summary && summary.state ? summary.state : null;
      const totals = summary && summary.totals ? summary.totals : {};
      const farmerEntryPct = getFarmerEntryPct(state);
      const maxFarmerStages = Number.isFinite(Number(state && state.maxFarmerStages)) ? Number(state.maxFarmerStages) : 3;

      setMetricText(liveMetricIds.generatedAt, "생성 시각 " + formatDate(summary ? summary.generatedAt : null));
      setMetricText(liveMetricIds.market, state ? state.market : "-");
      if (currentPhaseValue) {
        currentPhaseValue.dataset.phase = state ? String(state.phase || "") : "";
        currentPhaseValue.textContent = formatPhaseKo(state ? state.phase : null);
      }
      setMetricText(liveMetricIds.lastLoopAt, formatDate(state ? state.lastLoopAt : null));
      setMetricTextAll(".js-last-price", formatKrw(state ? state.lastPrice : null));
      strategyTotalCapitalKrw = Number(state && state.totalCapitalKrw || strategyTotalCapitalKrw || 0);
      const accountAssetQty =
        state == null ? NaN : Number(state.accountAssetBalance || 0) + Number(state.accountAssetLocked || 0);
      setMetricText(liveMetricIds.accountCapital, formatKrw(state ? (state.accountCapitalKrw ?? state.totalCapitalKrw) : null));
      setMetricText(liveMetricIds.accountKrwAvailable, formatKrw(state ? state.accountKrwBalance : null));
      setMetricText(liveMetricIds.accountKrwLocked, formatKrw(state ? state.accountKrwLocked : null));
      setMetricText(liveMetricIds.accountAssetQty, formatAssetQty(accountAssetQty));
      setMetricText(liveMetricIds.accountAssetValue, formatKrw(state ? state.accountAssetValueKrw : null));
      setMetricText(liveMetricIds.accountStrategyCapital, formatKrw(state ? state.totalCapitalKrw : null));
      setMetricText(liveMetricIds.accountUpdatedAt, formatDate(state ? state.accountCapitalUpdatedAt : null));
      renderOrderAmountDisplay();

      setMetricText(liveMetricIds.realizedPnlKrw, formatKrw(totals.realizedPnlKrw));
      setMetricText(liveMetricIds.realizedPnlPct, formatPct(totals.realizedPnlPct));
      setMetricText(liveMetricIds.todayRealizedPnlKrw, formatKrw(totals.todayRealizedPnlKrw));
      setMetricText(liveMetricIds.todayRealizedPnlPct, formatPct(totals.todayRealizedPnlPct));
      setPanelTone(liveMetricIds.realizedPnlKrw, Number(totals.realizedPnlKrw));
      setPanelTone(liveMetricIds.realizedPnlPct, Number(totals.realizedPnlPct));
      setPanelTone(liveMetricIds.todayRealizedPnlKrw, Number(totals.todayRealizedPnlKrw));
      setPanelTone(liveMetricIds.todayRealizedPnlPct, Number(totals.todayRealizedPnlPct));

      setMetricText(liveMetricIds.holdingCost, formatKrw(totals.holdingCostKrw));
      setMetricText(liveMetricIds.holdingValue, formatKrw(totals.holdingValueKrw));
      setMetricText(liveMetricIds.holdingPnlKrw, formatKrw(totals.holdingPnlKrw));
      setMetricText(liveMetricIds.holdingPnlPct, formatPct(totals.holdingPnlPct));
      setPanelTone(liveMetricIds.holdingPnlKrw, Number(totals.holdingPnlKrw));
      setPanelTone(liveMetricIds.holdingPnlPct, Number(totals.holdingPnlPct));

      const waitingLayerCount = Number(totals.waitingLayers || 0) + Number(totals.soldLayers || 0);
      setMetricText(liveMetricIds.nextGridEntry, formatKrw(getNextGridEntry(state ? state.layers : [])));
      setMetricText(liveMetricIds.layerStatus, waitingLayerCount + " / " + Number(totals.openLayers || 0));
      setMetricText(liveMetricIds.tradeCount, Number(totals.buyCount || 0) + " / " + Number(totals.sellCount || 0));
      setMetricText(liveMetricIds.farmerLastBuyPrice, formatKrw(getFarmerLastBuyPrice(state)));
      setMetricText(liveMetricIds.nextFarmerEntry, formatKrw(getNextFarmerEntryPrice(state, farmerEntryPct)));
      setMetricText(liveMetricIds.farmerEntryPctMuted, "필요 하락률 -" + (farmerEntryPct * 100).toFixed(2) + "%");
      setMetricText(liveMetricIds.farmerStage, Number(state && state.farmerStage || 0) + " / " + maxFarmerStages);
    }

    async function refreshLogTail() {
      try {
        const response = await fetch("/api/summary", { cache: "no-store" });
        if (!response.ok) return;
        const summary = await response.json();
        const nextPhase = summary && summary.state ? String(summary.state.phase || "") : "";
        if (currentDashboardPhase && nextPhase && nextPhase !== currentDashboardPhase) {
          window.location.reload();
          return;
        }
        currentDashboardPhase = nextPhase || currentDashboardPhase;
        refreshLiveMetrics(summary);
        const lines = Array.isArray(summary.botLogLines) ? summary.botLogLines : [];
        const nextHtml = lines.length > 0
          ? lines.map((line) => "<div>" + escapeHtml(line) + "</div>").join("")
          : '<div class="empty">' + escapeHtml(emptyLogMessage) + '</div>';
        if (logTailLines.innerHTML === nextHtml) return;

        logTail.classList.add("is-moving");
        window.setTimeout(() => {
          logTailLines.innerHTML = nextHtml;
          logTail.classList.remove("is-moving");
        }, 180);
      } catch (_error) {
        // Keep the last visible log lines when a short polling request fails.
      }
    }

    setInterval(refreshLogTail, 3000);

    function parseInitialGridLevelSettings() {
      if (!gridLevelSettingsContainer) return [];
      try {
        const parsed = JSON.parse(gridLevelSettingsContainer.dataset.settings || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch (_error) {
        return [];
      }
    }

    const initialGridLevelSettings = parseInitialGridLevelSettings();

    function getGridLevelFallbackPercent() {
      const value = Number(gridGapPctInput ? gridGapPctInput.value : 1);
      return Number.isFinite(value) && value > 0 ? value : 1;
    }

    function readGridLevelSettingsFromContainer() {
      if (!gridLevelSettingsContainer) return [];
      return Array.from(gridLevelSettingsContainer.querySelectorAll(".grid-level-setting-row")).map((row) => {
        const readField = (field, fallback) => {
          const input = row.querySelector('[data-field="' + field + '"]');
          const value = Number(input ? input.value : fallback);
          return Number.isFinite(value) ? value : fallback;
        };
        return {
          level: Number(row.dataset.level || "0"),
          buyGapPct: readField("buyGapPct", 1) / 100,
          buyAmountMultiplier: readField("buyAmountMultiplier", 1),
          takeProfitPct: readField("takeProfitPct", 1) / 100,
          trailingPullbackPct: Math.abs(readField("trailingPullbackPct", 0)) / 100,
        };
      }).filter((setting) => Number.isInteger(setting.level) && setting.level > 0);
    }

    function renderGridLevelSettingsRows() {
      if (!gridLevelSettingsContainer) return;
      const existingSettings = readGridLevelSettingsFromContainer();
      const requestedLevels = Math.floor(Number(gridLevelsInput ? gridLevelsInput.value : "20"));
      const configuredLevels = Number.isFinite(requestedLevels) ? Math.max(1, Math.min(100, requestedLevels)) : 20;
      const fallbackGapPct = getGridLevelFallbackPercent();
      const findSetting = (level) =>
        existingSettings.find((setting) => setting.level === level) ||
        initialGridLevelSettings.find((setting) => Number(setting.level) === level) ||
        null;
      let html = "";
      for (let level = 1; level <= configuredLevels; level += 1) {
        const setting = findSetting(level) || {};
        const buyGapPct = Number.isFinite(Number(setting.buyGapPct)) ? Number(setting.buyGapPct) * 100 : fallbackGapPct;
        const buyAmountMultiplier = Number.isFinite(Number(setting.buyAmountMultiplier)) ? Number(setting.buyAmountMultiplier) : 1;
        const takeProfitPct = Number.isFinite(Number(setting.takeProfitPct)) ? Number(setting.takeProfitPct) * 100 : 1;
        const trailingPullbackPct = Number.isFinite(Number(setting.trailingPullbackPct)) ? -Math.abs(Number(setting.trailingPullbackPct) * 100) : 0;
        html +=
          '<div class="grid-level-setting-row" data-level="' + level + '">' +
          '<div class="grid-level-setting-index">' + level + '차</div>' +
          '<div class="grid-level-setting-field"><label>이전 차수와의 매수 간격(%)</label><input data-field="buyGapPct" type="number" min="0.1" max="20" step="0.1" value="' + buyGapPct.toFixed(2) + '"></div>' +
          '<div class="grid-level-setting-field"><label>매입 금액 배수</label><input data-field="buyAmountMultiplier" type="number" min="0.01" max="100" step="0.01" value="' + buyAmountMultiplier.toFixed(2) + '"></div>' +
          '<div class="grid-level-setting-field"><label>매도 익절 기준(%)</label><input data-field="takeProfitPct" type="number" min="0.1" max="100" step="0.1" value="' + takeProfitPct.toFixed(2) + '"></div>' +
          '<div class="grid-level-setting-field"><label>트레일링 폴링 기준(%)</label><input data-field="trailingPullbackPct" type="number" min="-20" max="0" step="0.1" value="' + trailingPullbackPct.toFixed(2) + '"></div>' +
          "</div>";
      }
      gridLevelSettingsContainer.innerHTML = html;
    }

    function formatKrw(value) {
      if (!Number.isFinite(value)) return "-";
      return Math.round(value).toLocaleString("ko-KR") + " KRW";
    }

    function formatAssetQty(value) {
      return Number.isFinite(value) ? value.toFixed(8) + " BTC" : "-";
    }

    function getCalculatedGridOrderAmount() {
      const configuredLevels = Math.floor(Number(gridLevelsInput ? gridLevelsInput.value : "20"));
      const levels = Number.isFinite(configuredLevels) && configuredLevels > 0 ? configuredLevels : 20;
      const totalCapital = Number(strategyTotalCapitalKrw);
      if (!Number.isFinite(totalCapital) || totalCapital <= 0) return NaN;
      const levelSettings = readGridLevelSettingsFromContainer();
      const multiplierTotal = levelSettings.length > 0
        ? levelSettings.slice(0, levels).reduce((sum, setting) => sum + Number(setting.buyAmountMultiplier || 0), 0)
        : levels;
      return Math.round((totalCapital * defaultGridRatio) / multiplierTotal);
    }

    function renderOrderAmountDisplay() {
      const orderAmount = getCalculatedGridOrderAmount();
      if (orderAmountDisplay) {
        orderAmountDisplay.dataset.value = Number.isFinite(orderAmount) ? String(orderAmount) : "";
        orderAmountDisplay.textContent = formatKrw(orderAmount);
      }
      setMetricText(liveMetricIds.accountGridOrderAmount, formatKrw(orderAmount));
    }

    function formatPercentValue(value) {
      return Number.isFinite(value) ? (value * 100).toFixed(2) + "%" : "-";
    }

    function formatTrailingPercentValue(value) {
      if (!Number.isFinite(value)) return "-";
      const pct = Math.abs(value * 100);
      return pct === 0 ? "0.00%" : "-" + pct.toFixed(2) + "%";
    }

    function buildGridConditionCards() {
      const levelsValue = Number(gridLevelsInput ? gridLevelsInput.value : "0");
      const gapPctValue = Number(gridGapPctInput ? gridGapPctInput.value : "0") / 100;
      const orderAmount = getCalculatedGridOrderAmount();
      const firstLevelSetting = readGridLevelSettingsFromContainer()[0] || {};
      return [
        strategyCard("그리드 차수", Number.isFinite(levelsValue) ? String(Math.floor(levelsValue)) : "-"),
        strategyCard("차수 간격", formatPercentValue(gapPctValue)),
        strategyCard("기본 차수별 매수 금액", formatKrw(orderAmount)),
        strategyCard("매도 익절 기준", formatPercentValue(Number(firstLevelSetting.takeProfitPct))),
        strategyCard("트레일링 폴링 기준", formatTrailingPercentValue(Number(firstLevelSetting.trailingPullbackPct))),
      ];
    }

    function renderFundingPreview() {
      const configuredLevels = Number(gridLevelsInput ? gridLevelsInput.value : "20");
      const levels = configuredLevels;
      const farmerStages = Math.max(0, Math.floor(Number(farmerStagesInput ? farmerStagesInput.value : "3")));
      const orderAmount = getCalculatedGridOrderAmount();
      const levelSettings = readGridLevelSettingsFromContainer();
      const multiplierTotal = levelSettings.length > 0
        ? levelSettings.slice(0, levels).reduce((sum, setting) => sum + Number(setting.buyAmountMultiplier || 0), 0)
        : levels;
      const gridTotal = Number.isFinite(strategyTotalCapitalKrw)
        ? Math.round(strategyTotalCapitalKrw * defaultGridRatio)
        : orderAmount * multiplierTotal;
      let positionValue = gridTotal;
      let totalInvestment = gridTotal;
      const farmerCards = [];
      for (let stage = 1; stage <= farmerStages; stage += 1) {
        const amount = stage === 1 ? positionValue : positionValue * 0.85;
        farmerCards.push('<div class="funding-item"><div class="funding-label">농부 ' + stage + '차</div><div class="funding-value">' + formatKrw(amount) + "</div></div>");
        totalInvestment += amount;
        positionValue += amount;
      }
      const previewHtml =
        '<div class="funding-item"><div class="funding-label">그리드 총액</div><div class="funding-value">' + formatKrw(gridTotal) + "</div></div>" +
        farmerCards.join("") +
        '<div class="funding-item total"><div class="funding-label">총 투입 예상액</div><div class="funding-value">' + formatKrw(totalInvestment) + "</div></div>";
      if (fundingPreview) fundingPreview.innerHTML = previewHtml;
      if (strategyFundingSummary) strategyFundingSummary.innerHTML = previewHtml;
    }

    function renderStrategyFixedSummary() {
      const cards = buildGridConditionCards();
      if (strategyFixedSummary) {
        strategyFixedSummary.innerHTML = strategyGroup("그리드 매매 조건", cards);
      }
      if (gridSettingsSummary) {
        gridSettingsSummary.innerHTML = cards.join("");
      }
    }

    function isChecked(input) {
      return !!(input && input.checked);
    }

    function numberValue(input, fallback) {
      const value = Number(input ? input.value : fallback);
      return Number.isFinite(value) ? value : fallback;
    }

    function trailingActivationLabel(value) {
      if (value === "PROFIT_POSITIVE") return "수익률 양수";
      if (value === "TP2") return "TP2 이상";
      return "TP1 이상";
    }

    function strategyCard(title, value, muted) {
      return '<div class="panel"><div class="metric-label">' + escapeHtml(title) + '</div><div class="metric-value">' + escapeHtml(value) + '</div>' + (muted ? '<div class="muted">' + escapeHtml(muted) + '</div>' : '') + '</div>';
    }

    function strategyGroup(title, cards) {
      if (!cards.length) return "";
      return '<div class="strategy-toggle-group-title">' + escapeHtml(title) + '</div>' + cards.join("");
    }

    function renderStrategyToggleSummary() {
      if (!strategyToggleSummary) return;
      const farmerEntryPct = numberValue(farmerEntryPctInput, 0);
      const nMultiplier = numberValue(recoveryTurtleNMultiplierInput, 2);
      const lowBreakoutPeriod = Math.max(0, Math.floor(numberValue(recoveryTurtleLowBreakoutPeriodInput, 20)));
      const sliceOrderKrw = numberValue(recoveryTurtleSliceOrderInput, 0);
      const sliceIntervalSeconds = Math.max(0, Math.floor(numberValue(recoveryTurtleSliceIntervalInput, 0)));
      const tp1ReturnPct = numberValue(tp1ReturnInput, 0);
      const tp1SellRatio = numberValue(tp1SellRatioInput, 0);
      const tp2ReturnPct = numberValue(tp2ReturnInput, 0);
      const tp2SellRatio = numberValue(tp2SellRatioInput, 0);
      const farmerCards = [
        isChecked(farmerUsePriceReachedInput) ? strategyCard("농부 진입 가격", "-" + farmerEntryPct.toFixed(2) + "%", "목표가 도달 조건") : "",
        isChecked(farmerUseLongTrendInput) ? strategyCard("장기 추세", "MA200", "방향 조건") : "",
        isChecked(farmerUseTurnoverRatioInput) ? strategyCard("거래대금 증가", "1.50x / 1.20x", "20일 / 5일") : "",
        isChecked(farmerUseMa5TrendInput) ? strategyCard("MA5 단기 추세", "MA5") : "",
        isChecked(farmerUseClosePositionInput) ? strategyCard("종가 위치", "60% 이상") : "",
        isChecked(farmerUseBullishDailyInput) ? strategyCard("일봉 양봉", "1일") : "",
        isChecked(farmerUseTwoBullishDailyInput) ? strategyCard("2일 연속 양봉", "2일 연속 양봉") : "",
        isChecked(farmerUseVolatilityExplosionInput) ? strategyCard("변동성 폭발 구간", nMultiplier.toFixed(1) + "N", "차단") : "",
      ].filter(Boolean);
      const turtleCards = [
        isChecked(enableRecoveryTurtleSellInput) ? strategyCard("회복 터틀 매도", "감시") : "",
        isChecked(recoveryUse2NTrailExitInput) ? strategyCard("2N 트레일링 이탈", trailingActivationLabel(recoveryTrailingActivationModeInput ? recoveryTrailingActivationModeInput.value : "TP1")) : "",
        isChecked(recoveryUseMa5ExitInput) ? strategyCard("MA5 하회 매도", "MA5") : "",
        isChecked(recoveryUseLowBreakoutExitInput) ? strategyCard("N일 최저가 이탈", lowBreakoutPeriod + "일") : "",
        isChecked(recoveryUseSliceOrderInput) ? strategyCard("터틀 분할 주문", formatKrw(sliceOrderKrw), sliceIntervalSeconds + "초 간격") : "",
        isChecked(partialTakeProfitInput) ? strategyCard("부분 익절", "TP1 " + tp1ReturnPct.toFixed(2) + "% / " + tp1SellRatio.toFixed(0) + "%", "TP2 " + tp2ReturnPct.toFixed(2) + "% / " + tp2SellRatio.toFixed(0) + "% 매도") : "",
      ].filter(Boolean);
      const html = strategyGroup("농부 매수 조건", farmerCards) + strategyGroup("터틀 매도 조건", turtleCards);
      strategyToggleSummary.innerHTML = html || '<div class="strategy-toggle-empty">전략 조정에서 켜진 토글 메뉴가 없습니다.</div>';
    }

    function refreshStrategySummaries() {
      renderOrderAmountDisplay();
      renderFundingPreview();
      renderStrategyFixedSummary();
      renderStrategyToggleSummary();
    }

    function refreshStrategySummariesSoon() {
      refreshStrategySummaries();
      requestAnimationFrame(refreshStrategySummaries);
      window.setTimeout(refreshStrategySummaries, 80);
      window.setTimeout(refreshStrategySummaries, 240);
    }

    if (gridLevelsInput) {
      gridLevelsInput.addEventListener("input", renderGridLevelSettingsRows);
      gridLevelsInput.addEventListener("input", renderFundingPreview);
      gridLevelsInput.addEventListener("input", renderOrderAmountDisplay);
      gridLevelsInput.addEventListener("input", renderStrategyFixedSummary);
    }
    if (gridGapPctInput) {
      gridGapPctInput.addEventListener("input", renderStrategyFixedSummary);
      gridGapPctInput.addEventListener("change", () => {
        renderGridLevelSettingsRows();
        renderFundingPreview();
      });
    }
    if (farmerStagesInput) {
      farmerStagesInput.addEventListener("input", renderFundingPreview);
    }
    if (farmerEntryPctInput) {
      farmerEntryPctInput.addEventListener("input", renderStrategyToggleSummary);
    }
    [
      farmerUsePriceReachedInput,
      farmerUseLongTrendInput,
      farmerUseTurnoverRatioInput,
      farmerUseMa5TrendInput,
      farmerUseClosePositionInput,
      farmerUseBullishDailyInput,
      farmerUseTwoBullishDailyInput,
      farmerUseVolatilityExplosionInput,
      enableRecoveryTurtleSellInput,
      recoveryUse2NTrailExitInput,
      recoveryUseMa5ExitInput,
      recoveryUseLowBreakoutExitInput,
      recoveryUseSliceOrderInput,
      partialTakeProfitInput,
    ].filter(Boolean).forEach((input) => {
      input.addEventListener("input", refreshStrategySummaries);
      input.addEventListener("change", refreshStrategySummariesSoon);
    });
    [
      recoveryTrailingActivationModeInput,
      recoveryTurtleNMultiplierInput,
      recoveryTurtleLowBreakoutPeriodInput,
      recoveryTurtleSliceOrderInput,
      recoveryTurtleSliceIntervalInput,
      tp1ReturnInput,
      tp1SellRatioInput,
      tp2ReturnInput,
      tp2SellRatioInput,
    ].filter(Boolean).forEach((input) => {
      input.addEventListener("input", renderStrategyToggleSummary);
      input.addEventListener("change", renderStrategyToggleSummary);
    });
    if (gridSettingsForm) {
      gridSettingsForm.addEventListener("input", refreshStrategySummaries);
      gridSettingsForm.addEventListener("change", refreshStrategySummariesSoon);
      gridSettingsForm.addEventListener("click", (event) => {
        const target = event.target;
        if (target && target.tagName === "INPUT" && target.type === "checkbox") {
          window.setTimeout(refreshStrategySummaries, 0);
        }
      });
    }
    if (gridSettingsSubmitButton) {
      gridSettingsSubmitButton.addEventListener("click", (event) => event.stopPropagation());
    }
    renderGridLevelSettingsRows();
    refreshStrategySummariesSoon();

    function syncPartialTakeProfitFields() {
      if (!partialTakeProfitInput) return;
      for (const field of partialTakeProfitFields) {
        field.disabled = !partialTakeProfitInput.checked;
      }
    }

    function syncRecoverySliceFields() {
      if (!recoveryUseSliceOrderInput) return;
      const disabled = !recoveryUseSliceOrderInput.checked;
      if (recoveryTurtleSliceOrderInput) recoveryTurtleSliceOrderInput.disabled = disabled;
      if (recoveryTurtleSliceIntervalInput) recoveryTurtleSliceIntervalInput.disabled = disabled;
    }

    if (partialTakeProfitInput) {
      partialTakeProfitInput.addEventListener("change", syncPartialTakeProfitFields);
    }
    if (recoveryUseSliceOrderInput) {
      recoveryUseSliceOrderInput.addEventListener("change", syncRecoverySliceFields);
    }
    syncPartialTakeProfitFields();
    syncRecoverySliceFields();

    function wireTrendForm() {
      const trendForm = document.getElementById("trend-form");
      const trendPanel = document.getElementById("trend-panel");
      if (!trendForm || !trendPanel) return;
      trendForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const params = new URLSearchParams(new FormData(trendForm));
        try {
          const response = await fetch("/api/trend-panel?" + params.toString(), { cache: "no-store" });
          if (!response.ok) return;
          trendPanel.innerHTML = await response.text();
          window.history.replaceState(null, "", "/?" + params.toString());
          wireTrendForm();
          wireTrendChartTooltip();
        } catch (_error) {
          // Leave the current chart in place if a panel refresh fails.
        }
      }, { once: true });
    }

    wireTrendForm();

    function wireTrendChartTooltip() {
      const chartWrap = document.querySelector(".chart-wrap");
      if (!chartWrap || chartWrap.dataset.tooltipWired === "1") return;
      chartWrap.dataset.tooltipWired = "1";
      const tooltip = chartWrap.querySelector(".chart-tooltip");
      if (!tooltip) return;

      function hideTooltip() {
        tooltip.classList.remove("open");
      }

      function showTooltip(event) {
        if (!(event.target instanceof Element)) return;
        const target = event.target.closest(".chart-hit-area");
        if (!target || !chartWrap.contains(target)) {
          hideTooltip();
          return;
        }
        tooltip.innerHTML =
          '<div class="chart-tooltip-title">' + escapeHtml(target.dataset.label || "-") + "</div>" +
          '<div class="chart-tooltip-row"><span>일별</span><strong>' + escapeHtml(target.dataset.pnl || "-") + "</strong></div>" +
          '<div class="chart-tooltip-row"><span>누적</span><strong>' + escapeHtml(target.dataset.cumulative || "-") + "</strong></div>";
        tooltip.classList.add("open");
        const wrapRect = chartWrap.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const left = Math.min(Math.max(8, event.clientX - wrapRect.left + 12), Math.max(8, wrapRect.width - tooltipRect.width - 8));
        const top = Math.max(8, event.clientY - wrapRect.top - tooltipRect.height - 12);
        tooltip.style.left = left + "px";
        tooltip.style.top = top + "px";
      }

      chartWrap.addEventListener("mousemove", showTooltip);
      chartWrap.addEventListener("mouseleave", hideTooltip);
    }

    wireTrendChartTooltip();

    function wireCalendarNav() {
      const calendarPanel = document.getElementById("calendar-panel");
      if (!calendarPanel) return;
      calendarPanel.querySelectorAll(".calendar-nav").forEach((link) => {
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          const href = link.getAttribute("href");
          if (!href) return;
          try {
            const response = await fetch("/api/calendar-panel" + href.slice(1), { cache: "no-store" });
            if (!response.ok) return;
            calendarPanel.innerHTML = await response.text();
            window.history.replaceState(null, "", href);
            wireCalendarNav();
          } catch (_error) {
            // Keep the current calendar if the panel refresh fails.
          }
        }, { once: true });
      });
      calendarPanel.querySelectorAll(".trade-day").forEach((cell) => {
        cell.addEventListener("click", async () => {
          const date = cell.getAttribute("data-date");
          if (!date) return;
          tradeModalTitle.textContent = date + " 거래 내역";
          tradeModalBody.innerHTML = "불러오는 중...";
          tradeModal.classList.add("open");
          try {
            const response = await fetch("/api/day-trades?date=" + encodeURIComponent(date), { cache: "no-store" });
            tradeModalBody.innerHTML = response.ok ? await response.text() : "거래 내역을 불러오지 못했습니다.";
          } catch (_error) {
            tradeModalBody.innerHTML = "거래 내역을 불러오지 못했습니다.";
          }
        });
      });
    }

    wireCalendarNav();

    function renderTelegramToggle() {
      telegramToggle.textContent = telegramEnabled ? "텔레그램 켜짐" : "텔레그램 꺼짐";
      telegramToggle.className = telegramEnabled ? "button" : "button danger";
    }

    async function loadTelegramSettings() {
      try {
        const response = await fetch("/api/telegram-settings", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "텔레그램 설정을 불러오지 못했습니다.");
        telegramEnabled = result.enabled !== false;
        telegramChatIdInput.value = "";
        telegramTokenInput.placeholder = result.botTokenConfigured ? "봇 토큰 저장됨" : "봇 토큰";
        telegramChatIdInput.placeholder = result.chatIdConfigured ? "채팅 ID 저장됨" : "채팅 ID";
        telegramGridBuyModeInput.value = result.gridBuyNotificationMode || "batch";
        telegramGridSellModeInput.value = result.gridSellNotificationMode || "immediate";
        telegramGridBatchSizeInput.value = String(result.gridBatchSize || 10);
        renderTelegramToggle();
        telegramStatus.textContent = telegramEnabled
          ? "텔레그램 메시지가 켜져 있습니다. 추천 설정: 매수 묶음 / 매도 즉시."
          : "텔레그램 메시지가 꺼져 있습니다.";
      } catch (error) {
        telegramToggle.textContent = "텔레그램";
        telegramStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    telegramSave.addEventListener("click", async () => {
      telegramSave.disabled = true;
      telegramStatus.textContent = "텔레그램 인증 정보를 저장하는 중...";
      try {
        const response = await fetch("/api/telegram-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            botToken: telegramTokenInput.value,
            chatId: telegramChatIdInput.value,
            gridBuyNotificationMode: telegramGridBuyModeInput.value,
            gridSellNotificationMode: telegramGridSellModeInput.value,
            gridBatchSize: Number(telegramGridBatchSizeInput.value),
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "텔레그램 인증 정보 저장에 실패했습니다.");
        telegramTokenInput.value = "";
        telegramTokenInput.placeholder = result.botTokenConfigured ? "봇 토큰 저장됨" : "봇 토큰";
        telegramChatIdInput.value = "";
        telegramChatIdInput.placeholder = result.chatIdConfigured ? "채팅 ID 저장됨" : "채팅 ID";
        telegramGridBuyModeInput.value = result.gridBuyNotificationMode || telegramGridBuyModeInput.value;
        telegramGridSellModeInput.value = result.gridSellNotificationMode || telegramGridSellModeInput.value;
        telegramGridBatchSizeInput.value = String(result.gridBatchSize || telegramGridBatchSizeInput.value || 10);
        telegramStatus.textContent = "텔레그램 설정을 저장했습니다.";
      } catch (error) {
        telegramStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        telegramSave.disabled = false;
      }
    });

    telegramToggle.addEventListener("click", async () => {
      telegramToggle.disabled = true;
      telegramStatus.textContent = "텔레그램 설정을 저장하는 중...";
      try {
        const response = await fetch("/api/telegram-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !telegramEnabled }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "텔레그램 설정 저장에 실패했습니다.");
        telegramEnabled = result.enabled;
        renderTelegramToggle();
        telegramStatus.textContent = telegramEnabled ? "텔레그램 메시지가 켜져 있습니다." : "텔레그램 메시지가 꺼져 있습니다.";
      } catch (error) {
        telegramStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        telegramToggle.disabled = false;
      }
    });

    telegramTest.addEventListener("click", async () => {
      telegramTest.disabled = true;
      telegramStatus.textContent = "Sending test message...";
      try {
        const response = await fetch("/api/telegram-test", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "테스트 메시지 전송에 실패했습니다.");
        telegramStatus.textContent = "테스트 메시지를 보냈습니다.";
      } catch (error) {
        telegramStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        telegramTest.disabled = false;
      }
    });

    async function loadBithumbSettings() {
      try {
        const response = await fetch("/api/bithumb-settings", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Bithumb API 키 설정을 불러오지 못했습니다.");
        bithumbAccessKeyInput.value = "";
        bithumbSecretKeyInput.value = "";
        bithumbAccessKeyInput.placeholder = result.accessKeyConfigured ? "Bithumb access key 저장됨" : "Bithumb access key";
        bithumbSecretKeyInput.placeholder = result.secretKeyConfigured ? "Bithumb secret key 저장됨" : "Bithumb secret key";
        bithumbLastLiveTestBuyQty = Number(result.lastLiveTestBuyQty || 0);
        bithumbLastLiveTestBuyMarket = result.lastLiveTestBuyMarket || "";
        renderBithumbTestButtons();
        bithumbStatus.textContent =
          result.accessKeyConfigured && result.secretKeyConfigured
            ? "Bithumb API 키가 저장되어 있습니다. 저장된 값은 화면에 다시 표시하지 않습니다."
            : "Bithumb API 키를 저장하면 봇이 환경변수 대신 이 값을 사용할 수 있습니다.";
      } catch (error) {
        bithumbStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    function renderBithumbTestButtons() {
      const hasBuyQty = Number.isFinite(bithumbLastLiveTestBuyQty) && bithumbLastLiveTestBuyQty > 0;
      bithumbTestSell.disabled = !hasBuyQty;
      bithumbTestSell.textContent = hasBuyQty ? "매수분 실시간 매도 테스트" : "매수 후 매도 테스트";
      bithumbTestSell.title = hasBuyQty
        ? "마지막 매수 테스트 수량 " + bithumbLastLiveTestBuyQty + " " + bithumbLastLiveTestBuyMarket + "을 매도합니다."
        : "먼저 10,000원 실시간 매수 테스트를 실행해야 합니다.";
    }
    renderBithumbTestButtons();

    bithumbSave.addEventListener("click", async () => {
      bithumbSave.disabled = true;
      bithumbStatus.textContent = "Bithumb API 키를 저장하는 중...";
      try {
        const response = await fetch("/api/bithumb-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accessKey: bithumbAccessKeyInput.value,
            secretKey: bithumbSecretKeyInput.value,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Bithumb API 키 저장에 실패했습니다.");
        bithumbAccessKeyInput.value = "";
        bithumbSecretKeyInput.value = "";
        bithumbAccessKeyInput.placeholder = result.accessKeyConfigured ? "Bithumb access key 저장됨" : "Bithumb access key";
        bithumbSecretKeyInput.placeholder = result.secretKeyConfigured ? "Bithumb secret key 저장됨" : "Bithumb secret key";
        bithumbStatus.textContent = "Bithumb API 키를 저장했습니다. 실행 중인 봇에는 재시작 후 반영됩니다.";
      } catch (error) {
        bithumbStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        bithumbSave.disabled = false;
      }
    });

    bithumbTest.addEventListener("click", async () => {
      bithumbTest.disabled = true;
      bithumbStatus.textContent = "Bithumb 계좌 조회로 연결을 확인하는 중...";
      try {
        const response = await fetch("/api/bithumb-test", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Bithumb 연결 확인에 실패했습니다.");
        bithumbStatus.textContent = "Bithumb 연결 확인 완료: 계좌 " + result.accounts + "개, 보유/잠김 잔고 " + result.nonZeroAccounts + "개";
      } catch (error) {
        bithumbStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        bithumbTest.disabled = false;
      }
    });

    async function runBithumbLiveTestOrder(side) {
      const isBuy = side === "BUY";
      const button = isBuy ? bithumbTestBuy : bithumbTestSell;
      const label = isBuy ? "매수" : "매도";
      if (!isBuy && (!Number.isFinite(bithumbLastLiveTestBuyQty) || bithumbLastLiveTestBuyQty <= 0)) {
        bithumbStatus.textContent = "먼저 10,000원 실시간 매수 테스트를 실행해야 매수한 수량만 매도할 수 있습니다.";
        renderBithumbTestButtons();
        return;
      }
      const confirmed = window.confirm(
        isBuy
          ? "실제 Bithumb 계좌로 10,000원 시장가 매수 주문을 전송합니다. 계속할까요?"
          : "실제 Bithumb 계좌로 마지막 매수 테스트 수량 " + bithumbLastLiveTestBuyQty + "을 시장가 매도합니다. 계속할까요?"
      );
      if (!confirmed) return;

      button.disabled = true;
      bithumbStatus.textContent = isBuy
        ? "Bithumb 10,000원 실시간 매수 테스트 주문을 전송하는 중..."
        : "Bithumb 매수 테스트 수량 실시간 매도 주문을 전송하는 중...";
      try {
        const response = await fetch("/api/bithumb-live-test-order", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ side }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Bithumb 실시간 테스트 주문에 실패했습니다.");
        bithumbLastLiveTestBuyQty = Number(result.lastLiveTestBuyQty || 0);
        bithumbLastLiveTestBuyMarket = isBuy ? result.market : "";
        renderBithumbTestButtons();
        const telegramStatusText = result.telegramNotified
          ? " / 텔레그램 전송 완료"
          : result.telegramError
            ? " / 텔레그램 전송 실패: " + result.telegramError
            : "";
        bithumbStatus.textContent =
          "실시간 " + label + " 테스트 완료: " +
          result.market + " / " +
          formatKrw(result.amountKrw) + " / qty " +
          result.qty + " / order " +
          result.orderId +
          telegramStatusText;
      } catch (error) {
        bithumbStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        if (isBuy) button.disabled = false;
        renderBithumbTestButtons();
      }
    }

    bithumbTestBuy.addEventListener("click", () => runBithumbLiveTestOrder("BUY"));
    bithumbTestSell.addEventListener("click", () => runBithumbLiveTestOrder("SELL"));

    loadTelegramSettings();
    loadBithumbSettings();

    gridSettingsForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = gridSettingsSubmitButton || gridSettingsForm.querySelector('button[type="submit"]');
      const formData = new FormData(gridSettingsForm);
      const gapPct = Number(formData.get("gapPct")) / 100;
      const gridLevels = Number(formData.get("gridLevels"));
      const gridLevelSettings = readGridLevelSettingsFromContainer();
      const maxFarmerStages = Number(formData.get("maxFarmerStages"));
      const farmerEntryPct = Number(formData.get("farmerEntryPct")) / 100;
      const farmerMax3dDrawdownPct = -Math.abs(Number(formData.get("farmerMax3dDrawdownPct")) / 100);
      const farmerStage2CooldownDays = Number(formData.get("farmerStage2CooldownDays"));
      const farmerStage3CooldownDays = Number(formData.get("farmerStage3CooldownDays"));
      const farmerUsePriceReachedFilter = formData.get("farmerUsePriceReachedFilter") === "on";
      const farmerUseLongTrendFilter = formData.get("farmerUseLongTrendFilter") === "on";
      const farmerUseTurnoverRatioFilter = formData.get("farmerUseTurnoverRatioFilter") === "on";
      const farmerUseMa5TrendFilter = formData.get("farmerUseMa5TrendFilter") === "on";
      const farmerUseClosePositionFilter = formData.get("farmerUseClosePositionFilter") === "on";
      const farmerUseBullishDailyFilter = formData.get("farmerUseBullishDailyFilter") === "on";
      const farmerUseTwoBullishDailyFilter = formData.get("farmerUseTwoBullishDailyFilter") === "on";
      const farmerUseVolatilityExplosionFilter = formData.get("farmerUseVolatilityExplosionFilter") === "on";
      const gridLoopIntervalMs = Number(formData.get("gridLoopIntervalSeconds")) * 1000;
      const farmingLoopIntervalMs = Number(formData.get("farmingLoopIntervalSeconds")) * 1000;
      const enableRecoveryTurtleSell = formData.get("enableRecoveryTurtleSell") === "on";
      const recoveryTurtleNPeriod = Number(formData.get("recoveryTurtleNPeriod"));
      const recoveryTurtleLowBreakoutPeriod = Number(formData.get("recoveryTurtleLowBreakoutPeriod"));
      const recoveryTurtleNMultiplier = Number(formData.get("recoveryTurtleNMultiplier"));
      const recoveryTurtleMinOrderKrw = Number(formData.get("recoveryTurtleMinOrderKrw"));
      const recoveryUseSliceOrder = formData.get("recoveryUseSliceOrder") === "on";
      const recoveryTurtleSliceOrderKrw = Number(
        recoveryTurtleSliceOrderInput ? recoveryTurtleSliceOrderInput.value : formData.get("recoveryTurtleSliceOrderKrw"),
      );
      const recoveryTurtleSliceIntervalSeconds = Number(
        recoveryTurtleSliceIntervalInput
          ? recoveryTurtleSliceIntervalInput.value
          : formData.get("recoveryTurtleSliceIntervalSeconds"),
      );
      const recoveryUse2NTrailExit = formData.get("recoveryUse2NTrailExit") === "on";
      const recoveryUseMa5Exit = formData.get("recoveryUseMa5Exit") === "on";
      const recoveryUseLowBreakoutExit = formData.get("recoveryUseLowBreakoutExit") === "on";
      const recoveryTrailingActivationMode = String(formData.get("recoveryTrailingActivationMode") || "TP1");
      const partialTakeProfitEnabled = formData.get("partialTakeProfitEnabled") === "on";
      const takeProfit1ReturnPct = Number(tp1ReturnInput ? tp1ReturnInput.value : "10") / 100;
      const takeProfit1SellRatio = Number(tp1SellRatioInput ? tp1SellRatioInput.value : "33") / 100;
      const takeProfit2ReturnPct = Number(tp2ReturnInput ? tp2ReturnInput.value : "20") / 100;
      const takeProfit2SellRatio = Number(tp2SellRatioInput ? tp2SellRatioInput.value : "33") / 100;

      if (submitButton) submitButton.disabled = true;
      gridSettingsStatus.textContent = "저장 중...";
      try {
        const response = await fetch("/api/grid-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            gapPct,
            gridLevels,
            gridLevelSettings,
            maxFarmerStages,
            farmerEntryPct,
            farmerMax3dDrawdownPct,
            farmerStage2CooldownDays,
            farmerStage3CooldownDays,
            farmerUsePriceReachedFilter,
            farmerUseLongTrendFilter,
            farmerUseTurnoverRatioFilter,
            farmerUseMa5TrendFilter,
            farmerUseClosePositionFilter,
            farmerUseBullishDailyFilter,
            farmerUseTwoBullishDailyFilter,
            farmerUseVolatilityExplosionFilter,
            gridLoopIntervalMs,
            farmingLoopIntervalMs,
            enableRecoveryTurtleSell,
            recoveryTurtleNPeriod,
            recoveryTurtleLowBreakoutPeriod,
            recoveryTurtleNMultiplier,
            recoveryTurtleMinOrderKrw,
            recoveryUseSliceOrder,
            recoveryTurtleSliceOrderKrw,
            recoveryTurtleSliceIntervalSeconds,
            recoveryUse2NTrailExit,
            recoveryUseMa5Exit,
            recoveryUseLowBreakoutExit,
            recoveryTrailingActivationMode,
            partialTakeProfitEnabled,
            takeProfit1ReturnPct,
            takeProfit1SellRatio,
            takeProfit2ReturnPct,
            takeProfit2SellRatio,
          }),
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "전략 설정 저장에 실패했습니다.");
        }
        const phaseMessage = result.returnedToGrid ? " 새 대기 그리드가 생겨 Grid 모드로 전환했습니다." : "";
        gridSettingsStatus.textContent = "저장 완료. 미보유 레이어 " + result.updatedAvailableLayers + "개를 갱신했습니다." + phaseMessage + " 대시보드를 새로고침합니다...";
        window.setTimeout(() => window.location.assign(window.location.href), 400);
      } catch (error) {
        gridSettingsStatus.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });

    if (gridResetButton && gridResetStatus) {
      gridResetButton.addEventListener("click", async () => {
        const ok = window.confirm("보유 중인 모든 Grid 포지션을 현재가 기준 시장가로 즉시 매도하고 Grid 단계로 전환합니다. 계속할까요?");
        if (!ok) return;
        gridResetButton.disabled = true;
        gridResetStatus.textContent = "그리드 전체 리셋을 실행하는 중...";
        try {
          const response = await fetch("/api/grid-reset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "그리드 전체 리셋에 실패했습니다.");
          }
          if (!result.sold) {
            gridResetStatus.textContent = "매도할 Grid 보유 포지션이 없습니다. Grid 단계로 전환했습니다.";
            return;
          }
          gridResetStatus.textContent = "리셋 완료. Grid 보유 포지션 " + result.soldCount + "개를 시장가로 매도했고 Grid 단계로 전환했습니다.";
        } catch (error) {
          gridResetStatus.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          gridResetButton.disabled = false;
        }
      });
    }

    if (realizedPnlResetButton && realizedPnlResetStatus) {
      realizedPnlResetButton.addEventListener("click", async () => {
        const ok = window.confirm("기존 Grid/Recovery 매도 실현 손익 기록을 삭제하고 0부터 다시 집계합니다. 계속할까요?");
        if (!ok) return;
        realizedPnlResetButton.disabled = true;
        realizedPnlResetStatus.textContent = "실현 손익 기록을 리셋하는 중...";
        try {
          const response = await fetch("/api/realized-pnl-reset", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "실현 손익 리셋에 실패했습니다.");
          }
          realizedPnlResetStatus.textContent = "리셋 완료. 기존 실현 손익 기록 " + result.removedCount + "개를 삭제했습니다. 대시보드를 새로고침합니다...";
          window.setTimeout(() => window.location.assign(window.location.href), 400);
        } catch (error) {
          realizedPnlResetStatus.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          realizedPnlResetButton.disabled = false;
        }
      });
    }
  </script>
</body>
</html>`;
}

function calculateOpenLayerPnlKrw(layer: GridLayer, lastPrice: number | null): number | null {
  if (lastPrice == null || layer.status !== "OPEN" || layer.qty <= 0) {
    return null;
  }
  return Math.round(lastPrice * layer.qty - calculateGridLayerCostBasisKrw(layer));
}

function getNextGridEntry(layers: GridLayer[]): number | null {
  const nextLayer = [...layers]
    .filter((layer) => layer.status === "WAITING" || layer.status === "SOLD")
    .sort((left, right) => left.idx - right.idx)[0];
  return nextLayer?.buyPrice ?? null;
}

function renderDailyPnlCalendar(records: DailyPnlRecord[], generatedAt: string, options: ViewOptions): string {
  const monthKey = options.calendarCursor.slice(0, 7);
  const yearKey = options.calendarCursor.slice(0, 4);
  const today = formatIsoDateInSeoul(generatedAt);
  const previousCursor = shiftCalendarCursor(options.calendarCursor, options.calendarMode, -1);
  const nextCursor = shiftCalendarCursor(options.calendarCursor, options.calendarMode, 1);
  const title = `
    <div class="title-row">
      <div class="summary-title">일별 손익</div>
      </div>`;
  const todayLink = `<a class="mode-link today-link calendar-nav" href="${buildDashboardHref({ ...options, calendarMode: "day", calendarCursor: today })}">오늘</a>`;
  const header = (period: string) => `
    <div class="calendar-head">
      ${title}
      ${todayLink}
      <div class="summary-meta">${period}</div>
    </div>`;

  if (options.calendarMode === "year") {
    const selectedYear = Number(yearKey);
    const years = getCalendarYears(records, selectedYear);
    const cells = years.map((year) => {
      const pnl = records
        .filter((record) => record.date.startsWith(`${year}-`))
        .reduce((sum, record) => sum + record.pnlKrw, 0);
      const tone = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
      return `
        <a class="calendar-cell ${tone} calendar-nav" href="${buildDashboardHref({ ...options, calendarMode: "month", calendarCursor: `${year}-01-01` })}">
          <div class="calendar-day">${year}</div>
          <div class="calendar-pnl">${formatManwon(pnl)}</div>
        </a>`;
    }).join("");
    return `
      ${header(yearKey)}
      <div class="center-controls">
        <div class="control-side left">
          <a class="mode-link calendar-nav" href="${buildDashboardHref({ ...options, calendarMode: "month" })}">월별</a>
        </div>
        <div class="period-nav">
          <a class="icon-link calendar-nav" href="${buildDashboardHref({ ...options, calendarCursor: previousCursor })}">&#8249;</a>
          <span class="period-label">${yearKey}</span>
          <a class="icon-link calendar-nav" href="${buildDashboardHref({ ...options, calendarCursor: nextCursor })}">&#8250;</a>
        </div>
        <div class="control-side right"></div>
      </div>
      <div class="year-grid">${cells}</div>`;
  }

  if (options.calendarMode === "month") {
    const monthly = Array.from({ length: 12 }, (_, index) => {
      const key = `${yearKey}-${String(index + 1).padStart(2, "0")}`;
      const pnl = records
        .filter((record) => record.date.startsWith(key))
        .reduce((sum, record) => sum + record.pnlKrw, 0);
      const tone = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
      return `
        <a class="calendar-cell ${tone} calendar-nav" href="${buildDashboardHref({ ...options, calendarMode: "day", calendarCursor: `${key}-01` })}">
          <div class="calendar-day">${index + 1}월</div>
          <div class="calendar-pnl">${formatManwon(pnl)}</div>
        </a>`;
    }).join("");
    return `
      ${header(yearKey)}
      <div class="center-controls">
        <div class="control-side left">
          <a class="mode-link calendar-nav" href="${buildDashboardHref({ ...options, calendarMode: "day" })}">일별</a>
        </div>
        <div class="period-nav">
          <a class="icon-link calendar-nav" href="${buildDashboardHref({ ...options, calendarCursor: previousCursor })}">&#8249;</a>
          <span class="period-label">${yearKey}</span>
          <a class="icon-link calendar-nav" href="${buildDashboardHref({ ...options, calendarCursor: nextCursor })}">&#8250;</a>
        </div>
        <div class="control-side right">
          <a class="mode-link calendar-nav" href="${buildDashboardHref({ ...options, calendarMode: "year" })}">연별</a>
        </div>
      </div>
      <div class="year-grid">${monthly}</div>`;
  }

  const [yearRaw, monthRaw] = monthKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const pnlByDate = new Map(records.map((record) => [record.date, record.pnlKrw]));
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = firstDay.getUTCDay();
  const cells: string[] = [];

  for (let index = 0; index < firstWeekday; index += 1) {
    cells.push(`<div class="calendar-cell empty"></div>`);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    const pnl = pnlByDate.get(date) ?? 0;
    const tone = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
    const todayClass = date === today ? " today-cell" : "";
    cells.push(`
      <div class="calendar-cell ${tone}${todayClass} trade-day" data-date="${date}" title="${date} 거래 보기">
        <button class="calendar-day" type="button">${day}</button>
        <div class="calendar-pnl">${formatManwon(pnl)}</div>
      </div>`);
  }

  return `
    ${header(monthKey)}
    <div class="center-controls">
      <div class="control-side left"></div>
      <div class="period-nav">
        <a class="icon-link calendar-nav" href="${buildDashboardHref({ ...options, calendarCursor: previousCursor })}">&#8249;</a>
        <span class="period-label">${monthKey}</span>
        <a class="icon-link calendar-nav" href="${buildDashboardHref({ ...options, calendarCursor: nextCursor })}">&#8250;</a>
      </div>
      <div class="control-side right">
        <a class="mode-link calendar-nav" href="${buildDashboardHref({ ...options, calendarMode: "month" })}">월별</a>
      </div>
    </div>
    <div class="calendar-weekdays">
      <span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span>
    </div>
    <div class="calendar-grid">${cells.join("")}</div>`;
}

function renderPnlChart(records: DailyPnlRecord[], options: ViewOptions): string {
  const buckets = aggregatePnl(records, options);
  let cumulative = [...records].reverse().find((record) => record.date < options.chartFrom)?.cumulativePnlKrw ?? 0;
  const points = buckets.map((bucket) => {
    const pnl = bucket.pnlKrw;
    cumulative += pnl;
    return { label: bucket.label, pnl, cumulative };
  });

  const width = 760;
  const height = 300;
  const padLeft = 62;
  const padRight = 24;
  const padTop = 30;
  const padBottom = 58;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const maxAbs = Math.max(1, ...points.flatMap((point) => [Math.abs(point.pnl), Math.abs(point.cumulative)]));
  const yMax = Math.max(1, maxAbs * 1.2);
  const y = (value: number) => padTop + (yMax - value) / (yMax * 2) * plotHeight;
  const x = (index: number) => padLeft + (index / Math.max(1, points.length - 1)) * plotWidth;
  const zeroY = y(0);
  const barWidth = Math.min(18, Math.max(4, plotWidth / Math.max(1, points.length) * 0.52));
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(2)} ${y(point.cumulative).toFixed(2)}`)
    .join(" ");
  const bars = points
    .map((point, index) => {
      const barX = x(index) - barWidth / 2;
      const barY = Math.min(y(point.pnl), zeroY);
      const barH = Math.max(1, Math.abs(zeroY - y(point.pnl)));
      const fill = point.pnl >= 0 ? "#5da8d5" : "#e46b6b";
      return `<rect x="${barX.toFixed(2)}" y="${barY.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barH.toFixed(2)}" fill="${fill}" rx="2"><title>${point.label} ${formatKrw(point.pnl)}</title></rect>`;
    })
    .join("");
  const hitWidth = plotWidth / Math.max(1, points.length);
  const lineDots = points
    .map((point, index) => `<circle class="chart-point" cx="${x(index).toFixed(2)}" cy="${y(point.cumulative).toFixed(2)}" r="3.5" fill="#e3342f"/>`)
    .join("");
  const hitAreas = points
    .map((point, index) => {
      const hitX = points.length <= 1
        ? padLeft
        : Math.max(padLeft, Math.min(width - padRight - hitWidth, x(index) - hitWidth / 2));
      return `<rect class="chart-hit-area" x="${hitX.toFixed(2)}" y="${padTop}" width="${hitWidth.toFixed(2)}" height="${plotHeight}" fill="transparent" data-label="${escapeHtml(point.label)}" data-pnl="${escapeHtml(formatKrw(point.pnl))}" data-cumulative="${escapeHtml(formatKrw(point.cumulative))}"/>`;
    })
    .join("");
  const ticks = [-1, -0.5, 0, 0.5, 1]
    .map((ratio) => {
      const value = yMax * ratio;
      const tickY = y(value);
      return `<line x1="${padLeft}" x2="${width - padRight}" y1="${tickY.toFixed(2)}" y2="${tickY.toFixed(2)}" stroke="#e2e7ec"/><text x="${padLeft - 10}" y="${(tickY + 4).toFixed(2)}" fill="#627080" font-size="11" text-anchor="end">${formatCompactKrw(value)}</text>`;
    })
    .join("");
  const maxLabels = 8;
  const labelStep = Math.max(1, Math.ceil(points.length / maxLabels));
  const labels = points
    .filter((_, index) => index % labelStep === 0 || index === points.length - 1)
    .map((point, index, selected) => {
      const originalIndex = points.findIndex((item) => item.label === point.label);
      return `<text x="${x(originalIndex).toFixed(2)}" y="${height - 22}" fill="#627080" font-size="10" text-anchor="${index === selected.length - 1 ? "end" : "middle"}" transform="rotate(-30 ${x(originalIndex).toFixed(2)} ${height - 22})">${escapeHtml(point.label)}</text>`;
    })
    .join("");

  return `
    <div class="chart-head">
      <div class="summary-title">실현 손익 추세</div>
      <div class="legend"><span class="legend-bar"></span>일별 <span class="legend-line"></span>누적</div>
    </div>
    <form id="trend-form" class="range-form" method="get">
      <input type="hidden" name="calendarMode" value="${escapeHtml(options.calendarMode)}">
      <input type="hidden" name="calendarCursor" value="${escapeHtml(options.calendarCursor)}">
      <div class="field"><label for="chart-from">시작일</label><input id="chart-from" name="chartFrom" type="date" value="${escapeHtml(options.chartFrom)}"></div>
      <div class="field"><label for="chart-to">종료일</label><input id="chart-to" name="chartTo" type="date" value="${escapeHtml(options.chartTo)}"></div>
      <div class="field">
        <label for="chart-unit">단위</label>
        <select id="chart-unit" name="chartUnit">
          ${renderUnitOption(options.chartUnit, "day", "일")}
          ${renderUnitOption(options.chartUnit, "week", "주")}
          ${renderUnitOption(options.chartUnit, "month", "월")}
          ${renderUnitOption(options.chartUnit, "quarter", "분기")}
          ${renderUnitOption(options.chartUnit, "half", "반기")}
          ${renderUnitOption(options.chartUnit, "year", "년")}
        </select>
      </div>
      <button class="button" type="submit">적용</button>
    </form>
    <div class="chart-wrap">
      <svg class="pnl-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="실현 손익 추세">
        <rect x="${padLeft}" y="${padTop}" width="${plotWidth}" height="${plotHeight}" fill="#fbfcfd" rx="8"/>
        ${ticks}
        <line x1="${padLeft}" x2="${width - padRight}" y1="${zeroY.toFixed(2)}" y2="${zeroY.toFixed(2)}" stroke="#7a848f"/>
        ${bars}
        <path d="${linePath}" fill="none" stroke="#e3342f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${lineDots}
        ${labels}
        ${hitAreas}
      </svg>
      <div class="chart-tooltip" role="status" aria-live="polite"></div>
    </div>`;
}

function renderUnitOption(current: ViewOptions["chartUnit"], value: ViewOptions["chartUnit"], label: string): string {
  return `<option value="${value}"${current === value ? " selected" : ""}>${label}</option>`;
}

function getCalendarYears(records: DailyPnlRecord[], selectedYear: number): number[] {
  const years = new Set<number>([selectedYear]);
  for (const record of records) {
    const year = Number(record.date.slice(0, 4));
    if (Number.isInteger(year) && year > 0) years.add(year);
  }
  const sorted = [...years].sort((left, right) => left - right);
  const minRecordYear = sorted[0] ?? selectedYear;
  const maxRecordYear = sorted[sorted.length - 1] ?? selectedYear;
  let start = Math.floor(selectedYear / 10) * 10;
  if (maxRecordYear > start + 11) start = maxRecordYear - 11;
  if (minRecordYear < start) start = minRecordYear;
  if (selectedYear < start) start = selectedYear;
  if (selectedYear > start + 11) start = selectedYear - 11;
  return Array.from({ length: 12 }, (_, index) => start + index);
}

function renderDayTrades(trades: TradeLogRecord[], date: string): string {
  const rows = trades
    .filter((trade) => formatIsoDateInSeoul(trade.timestamp) === date)
    .reverse()
    .map(
      (trade) => `
        <tr>
          <td>${formatDate(trade.timestamp)}</td>
          <td>${escapeHtml(formatTradeActionKo(trade.action))}</td>
          <td>${trade.stage ?? "-"}</td>
          <td>${formatKrw(trade.price)}</td>
          <td>${formatKrw(trade.amountKrw)}</td>
          <td>${formatKrw(trade.realizedPnlKrw)}</td>
          <td>${formatPct(calculateTradeRealizedPnlPct(trade))}</td>
        </tr>`,
    )
    .join("");
  const totalPnl = trades
    .filter((trade) => formatIsoDateInSeoul(trade.timestamp) === date)
    .reduce((sum, trade) => sum + (trade.realizedPnlKrw ?? 0), 0);

  return `
    <div class="metric-label">일별 실현 손익</div>
    <div class="metric-value" style="margin-bottom: 12px;">${formatKrw(totalPnl)} (${formatManwon(totalPnl)} 만원)</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>시각</th><th>동작</th><th>차수</th><th>가격</th><th>금액</th><th>손익</th><th>수익률</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">이 날짜의 거래 내역이 없습니다.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderPeriodTrades(trades: TradeLogRecord[], mode: "month" | "year", value: string): string {
  const filtered = trades.filter((trade) => {
    const date = formatIsoDateInSeoul(trade.timestamp);
    return mode === "month" ? date.startsWith(value) : date.startsWith(`${value}-`);
  });
  const rows = filtered
    .reverse()
    .map(
      (trade) => `
        <tr>
          <td>${formatDate(trade.timestamp)}</td>
          <td>${escapeHtml(formatTradeActionKo(trade.action))}</td>
          <td>${trade.stage ?? "-"}</td>
          <td>${formatKrw(trade.price)}</td>
          <td>${formatKrw(trade.amountKrw)}</td>
          <td>${formatKrw(trade.realizedPnlKrw)}</td>
          <td>${formatPct(calculateTradeRealizedPnlPct(trade))}</td>
        </tr>`,
    )
    .join("");
  const totalPnl = filtered.reduce((sum, trade) => sum + (trade.realizedPnlKrw ?? 0), 0);

  return `
    <div class="metric-label">${mode === "month" ? "월별" : "연별"} 실현 손익</div>
    <div class="metric-value" style="margin-bottom: 12px;">${formatKrw(totalPnl)} (${formatManwon(totalPnl)} 만원)</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>시각</th><th>동작</th><th>차수</th><th>가격</th><th>금액</th><th>손익</th><th>수익률</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">이 기간의 거래 내역이 없습니다.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function aggregatePnl(records: DailyPnlRecord[], options: ViewOptions): { label: string; pnlKrw: number }[] {
  const buckets = new Map<string, number>();
  const from = options.chartFrom;
  const to = options.chartTo;
  for (const record of records) {
    if (record.date < from || record.date > to) continue;
    const label = getBucketLabel(record.date, options.chartUnit);
    buckets.set(label, (buckets.get(label) ?? 0) + record.pnlKrw);
  }
  return Array.from(buckets.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, pnlKrw]) => ({ label, pnlKrw }));
}

function getBucketLabel(date: string, unit: ViewOptions["chartUnit"]): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (unit === "day") return date;
  if (unit === "week") return `${year}-W${String(getIsoWeek(date)).padStart(2, "0")}`;
  if (unit === "month") return date.slice(0, 7);
  if (unit === "quarter") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (unit === "half") return `${year}-H${month <= 6 ? 1 : 2}`;
  return String(year);
}

function getIsoWeek(date: string): number {
  const target = new Date(`${date}T00:00:00.000Z`);
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function readViewOptions(url: string): ViewOptions {
  const params = new URL(url, "http://localhost").searchParams;
  const today = formatIsoDateInSeoul(new Date().toISOString());
  const defaultFromDate = new Date(`${today}T00:00:00.000Z`);
  defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 44);
  const defaultFrom = defaultFromDate.toISOString().slice(0, 10);
  const calendarMode = readCalendarMode(params.get("calendarMode"));
  const calendarCursor = normalizeDateParam(params.get("calendarCursor"), today);
  const chartUnitRaw = params.get("chartUnit");
  const chartUnit = isChartUnit(chartUnitRaw) ? chartUnitRaw : "day";
  const chartFrom = normalizeDateParam(params.get("chartFrom"), defaultFrom);
  const chartTo = normalizeDateParam(params.get("chartTo"), today);

  return {
    calendarMode,
    calendarCursor,
    chartFrom: chartFrom <= chartTo ? chartFrom : chartTo,
    chartTo: chartFrom <= chartTo ? chartTo : chartFrom,
    chartUnit,
  };
}

function shiftCalendarCursor(cursor: string, mode: ViewOptions["calendarMode"], direction: -1 | 1): string {
  const date = new Date(`${cursor}T00:00:00.000Z`);
  if (mode === "day") {
    date.setUTCMonth(date.getUTCMonth() + direction);
  } else if (mode === "year") {
    date.setUTCFullYear(date.getUTCFullYear() + direction * 12);
  } else {
    date.setUTCFullYear(date.getUTCFullYear() + direction);
  }
  return date.toISOString().slice(0, 10);
}

function readCalendarMode(value: string | null): ViewOptions["calendarMode"] {
  if (value === "month" || value === "year") return value;
  return "day";
}

function buildDashboardHref(options: ViewOptions): string {
  const params: Array<[string, string]> = [
    ["calendarMode", options.calendarMode],
    ["calendarCursor", options.calendarCursor],
    ["chartFrom", options.chartFrom],
    ["chartTo", options.chartTo],
    ["chartUnit", options.chartUnit],
  ];
  return `/?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}

function isChartUnit(value: string | null): value is ViewOptions["chartUnit"] {
  return value === "day" || value === "week" || value === "month" || value === "quarter" || value === "half" || value === "year";
}

function normalizeDateParam(value: string | null, fallback: string): string {
  return value != null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function normalizePeriodParam(value: string | null, mode: "month" | "year", fallback: string): string {
  if (value == null) return fallback;
  if (mode === "year") return /^\d{4}$/.test(value) ? value : fallback;
  return /^\d{4}-\d{2}$/.test(value) ? value : fallback;
}

function sendJson(response: import("node:http").ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value, null, 2));
}

function sendHtml(response: import("node:http").ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

function sendRedirect(response: import("node:http").ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("location", location);
  response.end();
}

async function readBacktestReportHtml(url: string): Promise<string> {
  const parsedUrl = new URL(url, "http://localhost");
  const fileName = parsedUrl.pathname === "/backtests"
    ? "latest.html"
    : decodeURIComponent(parsedUrl.pathname.replace(/^\/backtests\//, ""));
  if (!isSafeBacktestReportFile(fileName)) {
    throw new Error("Invalid backtest report file.");
  }
  const html = await readFile(resolve(backtestReportsPath, fileName), "utf8");
  return injectBacktestNav(html);
}

function isSafeBacktestReportFile(fileName: string): boolean {
  return /^[A-Za-z0-9_.:-]+\.html$/.test(fileName) && !fileName.includes("..");
}

const ALLOWED_BACKTEST_ENV_KEYS = [
  "BACKTEST_FROM",
  "BACKTEST_TO",
  "BACKTEST_EXCHANGE",
  "BACKTEST_WARMUP_DAYS",
  "BACKTEST_TOTAL_CAPITAL_KRW",
  "BACKTEST_GRID_RATIO",
  "BACKTEST_GRID_LEVELS",
  "BACKTEST_GRID_GAP_PCT",
  "BACKTEST_USE_GRID_TRADING",
  "BACKTEST_FARMER_ENTRY_PCT",
  "BACKTEST_FARMER_MAX_STAGES",
  "BACKTEST_FARMER_MAX_3D_DRAWDOWN_PCT",
  "BACKTEST_FARMER_STAGE2_COOLDOWN_DAYS",
  "BACKTEST_FARMER_STAGE3_COOLDOWN_DAYS",
  "BACKTEST_TURTLE_N_PERIOD",
  "BACKTEST_TURTLE_LOW_BREAKOUT_PERIOD",
  "BACKTEST_TURTLE_N_MULTIPLIER",
  "BACKTEST_TP1_RETURN_PCT",
  "BACKTEST_TP1_SELL_RATIO",
  "BACKTEST_TP2_RETURN_PCT",
  "BACKTEST_TP2_SELL_RATIO",
  "BACKTEST_TRAILING_ACTIVATION_MODE",
  "BACKTEST_OPEN_BELOW_MA5_ACTIVATION_MODE",
  "BACKTEST_USE_PRICE_REACHED_FILTER",
  "BACKTEST_USE_LONG_TREND_FILTER",
  "BACKTEST_USE_TURNOVER_RATIO_FILTER",
  "BACKTEST_USE_MA5_TREND_FILTER",
  "BACKTEST_USE_CLOSE_POSITION_FILTER",
  "BACKTEST_USE_BULLISH_DAILY_FILTER",
  "BACKTEST_USE_TWO_BULLISH_DAILY_FILTER",
  "BACKTEST_USE_VOLATILITY_EXPLOSION_FILTER",
  "BACKTEST_USE_TURTLE_2N_TRAIL_EXIT",
  "BACKTEST_USE_TURTLE_OPEN_BELOW_MA5_EXIT",
  "BACKTEST_USE_TURTLE_MA5_EXIT",
  "BACKTEST_USE_TURTLE_LOW_BREAK_EXIT",
] as const;

async function runBacktestFromUrl(url: string): Promise<void> {
  const parsedUrl = new URL(url, "http://localhost");
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ALLOWED_BACKTEST_ENV_KEYS) {
    const value = parsedUrl.searchParams.get(key);
    if (value != null) env[key] = value;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [backtestScriptPath],
      { cwd: process.cwd(), env, timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error != null) {
          rejectPromise(new Error(`${error.message}\n${stdout}\n${stderr}`.trim()));
          return;
        }
        resolvePromise();
      },
    );
  });
}

function injectBacktestNav(html: string): string {
  const nav = `
  <div style="position:sticky;top:0;z-index:10;background:#f4f7fa;border-bottom:1px solid #d8e0ea;padding:10px 24px;text-align:right;">
    <a href="/" style="display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:6px;background:#18202a;color:#fff;text-decoration:none;font-weight:700;">운영 대시보드로 이동</a>
  </div>`;
  return html.includes("<body>") ? html.replace("<body>", `<body>${nav}`) : `${nav}${html}`;
}

const server = createServer(async (request, response) => {
  try {
    if (!isAuthorized(request)) {
      requestAuth(response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/grid-settings") {
      sendJson(response, 200, await updateGridSettings(await readRequestBody(request)));
      return;
    }

    if (request.method === "POST" && request.url === "/api/grid-reset") {
      sendJson(response, 200, await requestGridReset());
      return;
    }

    if (request.method === "POST" && request.url === "/api/realized-pnl-reset") {
      sendJson(response, 200, await resetRealizedPnlRecords());
      return;
    }

    if (request.method === "POST" && request.url === "/api/telegram-settings") {
      sendJson(response, 200, await updateTelegramSettings(await readRequestBody(request)));
      return;
    }

    if (request.method === "POST" && request.url === "/api/bithumb-settings") {
      sendJson(response, 200, await updateBithumbCredentialSettings(await readRequestBody(request)));
      return;
    }

    if (request.method === "POST" && request.url === "/api/telegram-test") {
      sendJson(response, 200, await sendTelegramTestMessage());
      return;
    }

    if (request.method === "POST" && request.url === "/api/bithumb-test") {
      sendJson(response, 200, await testBithumbCredentialSettings());
      return;
    }

    if (request.method === "POST" && request.url === "/api/bithumb-live-test-order") {
      sendJson(response, 200, await executeBithumbLiveTestOrder(await readRequestBody(request)));
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const url = request.url ?? "/";
    if (url === "/health") {
      sendJson(response, 200, { ok: true, generatedAt: new Date().toISOString() });
      return;
    }

    if (url === "/api/summary") {
      sendJson(response, 200, await buildSummary());
      return;
    }

    if (url === "/api/telegram-settings") {
      sendJson(response, 200, await readTelegramSettingsForClient());
      return;
    }

    if (url === "/api/bithumb-settings") {
      sendJson(response, 200, await readBithumbCredentialSettingsForClient());
      return;
    }

    if (url.startsWith("/api/trend-panel")) {
      sendHtml(response, 200, renderPnlChart((await buildSummary()).dailyPnl, readViewOptions(url)));
      return;
    }

    if (url.startsWith("/api/calendar-panel")) {
      const summary = await buildSummary();
      sendHtml(response, 200, renderDailyPnlCalendar(summary.dailyPnl, summary.generatedAt, readViewOptions(url)));
      return;
    }

    if (url.startsWith("/api/day-trades")) {
      const parsedUrl = new URL(url, "http://localhost");
      const date = normalizeDateParam(parsedUrl.searchParams.get("date"), formatIsoDateInSeoul(new Date().toISOString()));
      sendHtml(response, 200, renderDayTrades(await readJsonlRecords<TradeLogRecord>(logPath), date));
      return;
    }

    if (url.startsWith("/api/period-trades")) {
      const parsedUrl = new URL(url, "http://localhost");
      const mode = parsedUrl.searchParams.get("mode") === "year" ? "year" : "month";
      const fallbackValue = mode === "year" ? formatIsoDateInSeoul(new Date().toISOString()).slice(0, 4) : formatIsoDateInSeoul(new Date().toISOString()).slice(0, 7);
      const value = normalizePeriodParam(parsedUrl.searchParams.get("value"), mode, fallbackValue);
      sendHtml(response, 200, renderPeriodTrades(await readJsonlRecords<TradeLogRecord>(logPath), mode, value));
      return;
    }

    if (url === "/backtests/run" || url.startsWith("/backtests/run?")) {
      await runBacktestFromUrl(url);
      sendRedirect(response, "/backtests");
      return;
    }

    if (url === "/backtests" || url.startsWith("/backtests/")) {
      sendHtml(response, 200, await readBacktestReportHtml(url));
      return;
    }

    if (url === "/" || url.startsWith("/?")) {
      sendHtml(response, 200, renderHtml(await buildSummary(), readViewOptions(url)));
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`[dashboard] listening http://${host}:${port}`);
  console.log(`[dashboard] state=${statePath}`);
  console.log(`[dashboard] log=${logPath}`);
  console.log(`[dashboard] botOutLog=${botOutLogPath}`);
  console.log(`[dashboard] auth=${isAuthEnabled() ? `enabled user=${authUser}` : "disabled"}`);
});
