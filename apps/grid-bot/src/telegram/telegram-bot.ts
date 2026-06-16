import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BotState, GridLayer, TradeLogRecord } from "../../../../packages/shared/src/types";

interface TelegramConfig {
  envToken: string;
  envChatId: string;
  statePath: string;
  logPath: string;
  controlPath: string;
  telegramSettingsPath: string;
  telegramStatePath: string;
  pollIntervalMs: number;
  gridBatchSize: number;
  dailyReportHourKst: number;
  dailyReportMinuteKst: number;
}

interface TelegramRuntimeState {
  updateOffset: number;
  logOffset: number;
  gridBatchStages: number[];
  lastDailyReportKey: string | null;
  immediateTradeKeys?: string[];
}

interface ControlState {
  paused: boolean;
  buyPaused: boolean;
  sellPaused: boolean;
  reason: string | null;
  updatedAt: string;
}

interface TelegramSettings {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  gridBuyNotificationMode?: TelegramGridNotificationMode;
  gridSellNotificationMode?: TelegramGridNotificationMode;
  gridBatchSize?: number;
}

type TelegramGridNotificationMode = "off" | "immediate" | "batch";

const DEFAULT_GRID_BUY_NOTIFICATION_MODE: TelegramGridNotificationMode = "batch";
const DEFAULT_GRID_SELL_NOTIFICATION_MODE: TelegramGridNotificationMode = "immediate";

const defaultRuntimeState: TelegramRuntimeState = {
  updateOffset: 0,
  logOffset: 0,
  gridBatchStages: [],
  lastDailyReportKey: null,
};

async function main(): Promise<void> {
  const config = loadConfig();
  let runtimeState = await readRuntimeState(config.telegramStatePath);

  await sendMessage(config, "Bithumb Grid Telegram connected.");
  console.log(`[telegram] started gridBatchSize=${config.gridBatchSize}`);

  while (true) {
    try {
      runtimeState = await pollTelegramCommands(config, runtimeState);
      runtimeState = await processTradeLogs(config, runtimeState);
      runtimeState = await processDailyReport(config, runtimeState);
      await writeJsonAtomic(config.telegramStatePath, runtimeState);
    } catch (error) {
      console.error(`[telegram] ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

function loadConfig(): TelegramConfig {
  return {
    envToken: process.env.TELEGRAM_BOT_TOKEN || "",
    envChatId: process.env.TELEGRAM_CHAT_ID || "",
    statePath: absolutePath(process.env.GRID_BOT_STATE_PATH || "data/bot_state.json"),
    logPath: absolutePath(process.env.GRID_BOT_LOG_PATH || "data/trading_logs/btc_master_log.jsonl"),
    controlPath: absolutePath(process.env.GRID_BOT_CONTROL_PATH || "data/control/grid_control.json"),
    telegramSettingsPath: absolutePath(process.env.TELEGRAM_SETTINGS_PATH || "data/telegram_settings.json"),
    telegramStatePath: absolutePath(process.env.TELEGRAM_STATE_PATH || "data/telegram_state.json"),
    pollIntervalMs: readNumber("TELEGRAM_POLL_INTERVAL_MS", 3000),
    gridBatchSize: readNumber("TELEGRAM_GRID_BATCH_SIZE", 10),
    dailyReportHourKst: readNumber("TELEGRAM_DAILY_REPORT_HOUR_KST", 7),
    dailyReportMinuteKst: readNumber("TELEGRAM_DAILY_REPORT_MINUTE_KST", 0),
  };
}

function absolutePath(path: string): string {
  return resolve(process.cwd(), path);
}

function readNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer. Received: ${raw}`);
  }
  return value;
}

function readSignedNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be numeric. Received: ${raw}`);
  }
  return value;
}

async function pollTelegramCommands(
  config: TelegramConfig,
  runtimeState: TelegramRuntimeState,
): Promise<TelegramRuntimeState> {
  const credentials = await readTelegramCredentials(config);
  if (credentials == null) return runtimeState;
  const updates = await telegramApi<{ ok: boolean; result: TelegramUpdate[] }>(
    config,
    credentials.token,
    "getUpdates",
    {
      offset: String(runtimeState.updateOffset),
      timeout: "0",
      allowed_updates: JSON.stringify(["message"]),
    },
  );
  if (!updates.ok) return runtimeState;

  let nextOffset = runtimeState.updateOffset;
  for (const update of updates.result) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
    const message = update.message;
    if (message?.chat?.id == null || String(message.chat.id) !== credentials.chatId) {
      continue;
    }
    const text = message.text?.trim();
    if (text == null || !text.startsWith("/")) continue;
    await handleCommand(config, text);
  }

  return { ...runtimeState, updateOffset: nextOffset };
}

async function handleCommand(config: TelegramConfig, text: string): Promise<void> {
  const [command, ...args] = text.split(/\s+/);
  try {
    if (command === "/help") {
      await sendMessage(config, renderHelp());
      return;
    }
    if (command === "/status" || command === "/grid" || command === "/summary") {
      await sendMessage(config, renderStatus(await readJsonFile<BotState>(config.statePath)));
      return;
    }
    if (command === "/pnl") {
      await sendMessage(config, renderPnl(await readJsonFile<BotState>(config.statePath), await readTradeLogs(config.logPath)));
      return;
    }
    if (command === "/settings") {
      await sendMessage(config, renderSettings(await readJsonFile<BotState>(config.statePath)));
      return;
    }
    if (command === "/layers") {
      await sendMessage(config, renderLayers(await readJsonFile<BotState>(config.statePath)));
      return;
    }
    if (command === "/daily") {
      await sendMessage(config, renderDailyReport(await readTradeLogs(config.logPath), await readJsonFile<BotState>(config.statePath), getDailyReportWindow(new Date())));
      return;
    }
    if (command === "/pause" || command === "/resume" || command === "/pause_buy" || command === "/resume_buy" || command === "/pause_sell" || command === "/resume_sell") {
      await updateControl(config.controlPath, command, args.join(" "));
      await sendMessage(config, `Control updated: ${command}`);
      return;
    }
    if (command === "/set_gap" || command === "/set_levels" || command === "/set_amount" || command === "/set_farmer_stages") {
      await updateGridSetting(config, command, args[0]);
      await sendMessage(config, `Setting updated: ${command} ${args[0] ?? ""}`.trim());
      return;
    }
    if (command === "/extend_grid") {
      const result = await extendGrid(config, args[0]);
      await sendMessage(config, `Grid extended: ${result.progressedLevel} -> ${result.finalLevel}`);
      return;
    }
    await sendMessage(config, `Unknown command: ${command}\nUse /help`);
  } catch (error) {
    await sendMessage(config, `Command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function updateControl(path: string, command: string, reasonRaw: string): Promise<void> {
  const current = (await readJsonFile<ControlState>(path)) ?? {
    paused: false,
    buyPaused: false,
    sellPaused: false,
    reason: null,
    updatedAt: new Date().toISOString(),
  };
  const reason = reasonRaw.length > 0 ? reasonRaw : command;
  const next: ControlState = {
    ...current,
    paused: command === "/pause" ? true : command === "/resume" ? false : current.paused,
    buyPaused: command === "/pause_buy" ? true : command === "/resume_buy" ? false : current.buyPaused,
    sellPaused: command === "/pause_sell" ? true : command === "/resume_sell" ? false : current.sellPaused,
    reason,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path, next);
}

async function updateGridSetting(config: TelegramConfig, command: string, rawValue: string | undefined): Promise<void> {
  if (rawValue == null) throw new Error(`${command} requires a value.`);
  const state = await readRequiredState(config.statePath);
  const entryPrice = state.gridEntryPrice ?? state.lastPrice;
  if (entryPrice == null || entryPrice <= 0) {
    throw new Error("Cannot update grid settings before an entry price is available.");
  }

  const currentGapPct = inferGridGapPct(state) ?? 0.01;
  const currentAmount = state.gridOrderAmountKrw || state.layers[0]?.amountKrw || 0;
  let gapPct = currentGapPct;
  let amountKrw = currentAmount;
  let levels = state.layers.length;
  let maxFarmerStages = state.maxFarmerStages ?? 3;

  if (command === "/set_gap") {
    gapPct = Number(rawValue) / 100;
    if (!Number.isFinite(gapPct) || gapPct < 0.001 || gapPct > 0.2) {
      throw new Error("Gap percent must be between 0.1 and 20.");
    }
  }
  if (command === "/set_levels") {
    levels = Number(rawValue);
    if (!Number.isInteger(levels) || levels < 1 || levels > 100) {
      throw new Error("Grid levels must be an integer between 1 and 100.");
    }
  }
  if (command === "/set_amount") {
    if (state.layers.some((layer) => layer.status === "OPEN" || layer.qty > 0)) {
      throw new Error("Buy amount is locked while any layer is OPEN.");
    }
    amountKrw = Number(rawValue);
    if (!Number.isFinite(amountKrw) || amountKrw < 5000) {
      throw new Error("Buy amount must be at least 5,000 KRW.");
    }
    amountKrw = Math.round(amountKrw);
  }
  if (command === "/set_farmer_stages") {
    maxFarmerStages = Number(rawValue);
    if (!Number.isInteger(maxFarmerStages) || maxFarmerStages < 0 || maxFarmerStages > 10) {
      throw new Error("Farmer stages must be an integer between 0 and 10.");
    }
  }

  const maxHeldLevel = state.layers.reduce(
    (max, layer) => (layer.status === "OPEN" || layer.qty > 0 ? Math.max(max, layer.idx) : max),
    0,
  );
  if (levels < maxHeldLevel) {
    throw new Error(`Grid levels cannot be lower than the highest held level (${maxHeldLevel}).`);
  }

  const layers = rebuildGridLayers({ state, entryPrice, gapPct, orderAmountKrw: amountKrw, levels });
  await writeJsonAtomic(config.statePath, {
    ...state,
    gridEntryPrice: entryPrice,
    gridOrderAmountKrw: amountKrw,
    gridInvestmentKrw: layers.reduce((sum, layer) => sum + layer.amountKrw, 0),
    layers,
    maxFarmerStages,
    updatedAt: new Date().toISOString(),
  });
}

async function extendGrid(
  config: TelegramConfig,
  rawValue: string | undefined,
): Promise<{ progressedLevel: number; finalLevel: number }> {
  if (rawValue == null) throw new Error("/extend_grid requires a level count.");
  const extensionLevels = Number(rawValue);
  if (!Number.isInteger(extensionLevels) || extensionLevels < 1 || extensionLevels > 100) {
    throw new Error("Extension levels must be an integer between 1 and 100.");
  }
  const state = await readRequiredState(config.statePath);
  if (state.phase !== "GRID") throw new Error("Grid extension is only available in GRID phase.");
  const gapPct = inferGridGapPct(state) ?? 0.01;
  const orderAmountKrw = state.gridOrderAmountKrw || state.layers[0]?.amountKrw || 0;
  if (orderAmountKrw <= 0) throw new Error("Cannot extend grid before order amount is available.");
  const progressedLevel = getProgressedLevel(state.layers);
  const firstExtendedBuyPrice = getNextGridEntry(state.layers) ?? state.lastPrice;
  if (firstExtendedBuyPrice == null || firstExtendedBuyPrice <= 0) {
    throw new Error("Cannot extend grid before a next entry price is available.");
  }

  const keptLayers = state.layers.filter((layer) => layer.idx <= progressedLevel);
  const extensionRound = state.layers.reduce((max, layer) => Math.max(max, layer.extensionRound ?? 0), 0) + 1;
  const extendedLayers = Array.from({ length: extensionLevels }, (_, index): GridLayer => {
    const extensionIdx = index + 1;
    const idx = progressedLevel + extensionIdx;
    return {
      idx,
      extensionRound,
      extensionIdx,
      buyPrice: Math.round(firstExtendedBuyPrice * (1 - gapPct * index)),
      sellPrice: index === 0
        ? Math.round(firstExtendedBuyPrice / (1 - gapPct))
        : Math.round(firstExtendedBuyPrice * (1 - gapPct * (index - 1))),
      amountKrw: orderAmountKrw,
      qty: 0,
      status: "WAITING",
      buyCount: 0,
      sellCount: 0,
      boughtAt: null,
      soldAt: null,
      buyOrderId: null,
      sellOrderId: null,
    };
  });
  const layers = [...keptLayers, ...extendedLayers];
  await writeJsonAtomic(config.statePath, {
    ...state,
    layers,
    gridInvestmentKrw: layers.reduce((sum, layer) => sum + layer.amountKrw, 0),
    updatedAt: new Date().toISOString(),
  });
  return { progressedLevel, finalLevel: progressedLevel + extensionLevels };
}

function rebuildGridLayers(params: {
  state: BotState;
  entryPrice: number;
  gapPct: number;
  orderAmountKrw: number;
  levels: number;
}): GridLayer[] {
  return Array.from({ length: params.levels }, (_, index) => {
    const idx = index + 1;
    const existing = params.state.layers.find((layer) => layer.idx === idx);
    return {
      ...(existing ?? {
        idx,
        qty: 0,
        status: "WAITING" as const,
        buyCount: 0,
        sellCount: 0,
        boughtAt: null,
        soldAt: null,
        buyOrderId: null,
        sellOrderId: null,
      }),
      buyPrice: Math.round(params.entryPrice * (1 - params.gapPct * idx)),
      sellPrice: Math.round(params.entryPrice * (1 - params.gapPct * (idx - 1))),
      amountKrw: params.orderAmountKrw,
    };
  });
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

function getNextGridEntry(layers: GridLayer[]): number | null {
  const nextLayer = [...layers]
    .filter((layer) => layer.status === "WAITING" || layer.status === "SOLD")
    .sort((left, right) => left.idx - right.idx)[0];
  return nextLayer?.buyPrice ?? null;
}

async function processTradeLogs(
  config: TelegramConfig,
  runtimeState: TelegramRuntimeState,
): Promise<TelegramRuntimeState> {
  const result = await readNewLogLines(config.logPath, runtimeState.logOffset);
  const currentState = await readJsonFile<BotState>(config.statePath);
  const telegramSettings = await readTelegramSettings(config);
  const gridBuyNotificationMode = normalizeGridNotificationMode(
    telegramSettings.gridBuyNotificationMode,
    DEFAULT_GRID_BUY_NOTIFICATION_MODE,
  );
  const gridSellNotificationMode = normalizeGridNotificationMode(
    telegramSettings.gridSellNotificationMode,
    DEFAULT_GRID_SELL_NOTIFICATION_MODE,
  );
  const gridBatchSize = normalizeGridBatchSize(telegramSettings.gridBatchSize, config.gridBatchSize);
  let stages = new Set(runtimeState.gridBatchStages);
  let immediateTradeKeys = new Set(runtimeState.immediateTradeKeys ?? []);
  const batchTrades: TradeLogRecord[] = [];

  for (const trade of result.records) {
    if (trade.action === "BOT_ERROR" || trade.action === "PHASE_CHANGE") {
      if (trade.action === "PHASE_CHANGE") {
        const key = buildImmediateTradeKey(trade);
        if (immediateTradeKeys.has(key)) {
          continue;
        }
        immediateTradeKeys.add(key);
      }
      await sendMessage(config, renderImmediateTrade(trade));
      continue;
    }
    if ((trade.action === "GRID_BUY" || trade.action === "GRID_SELL") && trade.stage != null) {
      const notificationMode = trade.action === "GRID_BUY" ? gridBuyNotificationMode : gridSellNotificationMode;
      if (notificationMode === "off") {
        continue;
      }
      if (notificationMode === "immediate") {
        await sendMessage(config, renderImmediateTrade(trade));
        continue;
      }
      stages.add(trade.stage);
      batchTrades.push(trade);
      if (stages.size >= gridBatchSize) {
        await sendMessage(config, renderGridBatch([...stages], batchTrades, await readJsonFile<BotState>(config.statePath)));
        stages = new Set();
      }
      continue;
    }
    if (trade.action === "FARMER_SIGNAL" && !shouldNotifyFarmerSignal(currentState)) {
      continue;
    }
    if (trade.layerType === "FARMER" || String(trade.layerType) === "TURTLE") {
      await sendMessage(config, renderImmediateTrade(trade));
    }
  }

  return {
    ...runtimeState,
    logOffset: result.offset,
    gridBatchStages:
      gridBuyNotificationMode === "batch" || gridSellNotificationMode === "batch"
        ? [...stages].sort((left, right) => left - right)
        : [],
    immediateTradeKeys: [...immediateTradeKeys].slice(-50),
  };
}

function buildImmediateTradeKey(trade: TradeLogRecord): string {
  return [
    trade.action,
    trade.cycleId,
    trade.message ?? "",
    trade.reason ?? "",
  ].join("|");
}

function shouldNotifyFarmerSignal(state: BotState | null): boolean {
  if (state == null) return false;
  if (state.phase === "FARMING" || state.phase === "HOLDING") return true;
  if (state.phase !== "GRID") return false;
  if (state.farmerStage !== 0 || (state.farmerPositions ?? []).some((position) => position.qty > 0)) return false;
  return state.layers.length > 0 && state.layers.every((layer) => layer.status === "OPEN" && layer.qty > 0);
}

async function processDailyReport(
  config: TelegramConfig,
  runtimeState: TelegramRuntimeState,
): Promise<TelegramRuntimeState> {
  const now = new Date();
  const kst = getKstParts(now);
  const reportKey = `${kst.year}-${pad2(kst.month)}-${pad2(kst.day)}`;
  if (kst.hour !== config.dailyReportHourKst || kst.minute < config.dailyReportMinuteKst) {
    return runtimeState;
  }
  if (runtimeState.lastDailyReportKey === reportKey) {
    return runtimeState;
  }
  await sendMessage(config, renderDailyReport(await readTradeLogs(config.logPath), await readJsonFile<BotState>(config.statePath), getDailyReportWindow(now)));
  return { ...runtimeState, lastDailyReportKey: reportKey };
}

function renderHelp(): string {
  return [
    "Commands",
    "/status - bot status",
    "/grid - grid summary",
    "/pnl - PNL summary",
    "/layers - layer summary",
    "/settings - current settings",
    "/daily - daily report now",
    "/pause [reason] - pause all",
    "/resume - resume all",
    "/pause_buy - pause buys",
    "/resume_buy - resume buys",
    "/pause_sell - pause sells",
    "/resume_sell - resume sells",
    "/set_gap 1.0 - set grid gap percent",
    "/set_levels 30 - set grid levels",
    "/set_amount 79000 - set buy amount",
    "/set_farmer_stages 3 - set farmer stages",
    "/extend_grid 10 - extend grid after progressed stage",
  ].join("\n");
}

function renderStatus(state: BotState | null): string {
  if (state == null) return "State file not found.";
  const counts = countLayers(state.layers);
  return [
    "[Grid Status]",
    `Market: ${state.market}`,
    `Phase: ${state.phase}`,
    `Price: ${formatKrw(state.lastPrice)}`,
    `Layers: OPEN ${counts.open} / WAITING ${counts.waiting} / SOLD ${counts.sold}`,
    `Last Loop: ${formatKstDateTime(state.lastLoopAt)}`,
    `Last Error: ${state.lastError ?? "-"}`,
  ].join("\n");
}

function renderPnl(state: BotState | null, trades: TradeLogRecord[]): string {
  const total = calculateRealizedPnl(trades);
  const todayWindow = getDailyReportWindow(new Date());
  const today = calculateRealizedPnl(filterTradesByWindow(trades, todayWindow));
  const holding = calculateHoldingSummary(state);
  return [
    "[PNL]",
    `Today Realized PNL: ${formatKrw(today.pnlKrw)}`,
    `Total Realized PNL: ${formatKrw(total.pnlKrw)}`,
    `Holding PNL: ${formatKrw(holding.pnlKrw)}`,
    `Holding Return: ${formatPct(holding.pnlPct)}`,
  ].join("\n");
}

function renderSettings(state: BotState | null): string {
  if (state == null) return "State file not found.";
  const gapPct = inferGridGapPct(state);
  return [
    "[Settings]",
    `Gap: ${gapPct == null ? "-" : `${(gapPct * 100).toFixed(2)}%`}`,
    `Buy Amount: ${formatKrw(state.gridOrderAmountKrw)}`,
    `Grid Levels: ${state.layers.length}`,
    `Farmer Stages: ${state.maxFarmerStages ?? 3}`,
  ].join("\n");
}

function renderLayers(state: BotState | null): string {
  if (state == null) return "State file not found.";
  const open = state.layers.filter((layer) => layer.status === "OPEN").map((layer) => layer.idx);
  const waiting = state.layers.filter((layer) => layer.status === "WAITING").map((layer) => layer.idx);
  const sold = state.layers.filter((layer) => layer.status === "SOLD").map((layer) => layer.idx);
  return [
    "[Layers]",
    `OPEN: ${formatStageList(open)}`,
    `WAITING: ${formatStageList(waiting)}`,
    `SOLD: ${formatStageList(sold)}`,
  ].join("\n");
}

function renderImmediateTrade(trade: TradeLogRecord): string {
  if (trade.action === "FARMER_SIGNAL") {
    const lastBuyPrice =
      readMetadataNumber(trade.metadata, "lastBuyPrice") ??
      readMetadataNumber(trade.metadata, "farmerBasePrice");
    const nextFarmerEntryPrice = readMetadataNumber(trade.metadata, "nextFarmerEntryPrice");
    return [
      `[${trade.action}]`,
      `Market: ${trade.market}`,
      trade.stage == null ? null : `Stage: ${trade.stage}`,
      trade.price == null ? null : `Current Price: ${formatKrw(trade.price)}`,
      lastBuyPrice == null ? null : `Last Buy Price: ${formatKrw(lastBuyPrice)}`,
      nextFarmerEntryPrice == null ? null : `Next Farmer Entry: ${formatKrw(nextFarmerEntryPrice)}`,
      trade.message == null ? null : `Message: ${trade.message}`,
    ].filter((line): line is string => line != null).join("\n");
  }

  return [
    `[${trade.action}]`,
    `Market: ${trade.market}`,
    trade.stage == null ? null : `Stage: ${trade.stage}`,
    trade.price == null ? null : `Price: ${formatKrw(trade.price)}`,
    trade.realizedPnlKrw == null ? null : `Realized PNL: ${formatKrw(trade.realizedPnlKrw)}`,
    trade.message == null ? null : `Message: ${trade.message}`,
  ].filter((line): line is string => line != null).join("\n");
}

function readMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function renderGridBatch(stages: number[], trades: TradeLogRecord[], state: BotState | null): string {
  const buyCount = trades.filter((trade) => trade.action === "GRID_BUY").length;
  const sellTrades = trades.filter((trade) => trade.action === "GRID_SELL");
  const realizedPnl = sellTrades.reduce((sum, trade) => sum + (trade.realizedPnlKrw ?? 0), 0);
  const openLayers = state?.layers.filter((layer) => layer.status === "OPEN").length ?? 0;
  return [
    "[Grid Stage Batch]",
    `Market: ${state?.market ?? trades[0]?.market ?? "-"}`,
    `Stages: ${formatStageList(stages)}`,
    "",
    `Buy fills: ${buyCount}`,
    `Sell fills: ${sellTrades.length}`,
    `Realized PNL: ${formatKrw(realizedPnl)}`,
    "",
    `Open Layers: ${openLayers}`,
    `Phase: ${state?.phase ?? "-"}`,
  ].join("\n");
}

function renderDailyReport(trades: TradeLogRecord[], state: BotState | null, window: DateWindow): string {
  const windowTrades = filterTradesByWindow(trades, window);
  const buyCount = windowTrades.filter((trade) => trade.action === "GRID_BUY").length;
  const sellCount = windowTrades.filter((trade) => trade.action === "GRID_SELL").length;
  const today = calculateRealizedPnl(windowTrades);
  const total = calculateRealizedPnl(trades);
  const holding = calculateHoldingSummary(state);
  return [
    "[Daily Grid Report]",
    `Period: ${formatKst(window.start)} - ${formatKst(window.end)} KST`,
    `Market: ${state?.market ?? "-"}`,
    "",
    `Buy fills: ${buyCount}`,
    `Sell fills: ${sellCount}`,
    "",
    `Today Realized PNL: ${formatKrw(today.pnlKrw)}`,
    `Total Realized PNL: ${formatKrw(total.pnlKrw)}`,
    "",
    `Holding PNL: ${formatKrw(holding.pnlKrw)}`,
    `Holding Return: ${formatPct(holding.pnlPct)}`,
  ].join("\n");
}

function countLayers(layers: GridLayer[]): { open: number; waiting: number; sold: number } {
  return {
    open: layers.filter((layer) => layer.status === "OPEN").length,
    waiting: layers.filter((layer) => layer.status === "WAITING").length,
    sold: layers.filter((layer) => layer.status === "SOLD").length,
  };
}

function calculateRealizedPnl(trades: TradeLogRecord[]): { pnlKrw: number } {
  return {
    pnlKrw: trades
      .filter((trade) => trade.action === "GRID_SELL")
      .reduce((sum, trade) => sum + (trade.realizedPnlKrw ?? 0), 0),
  };
}

function calculateHoldingSummary(state: BotState | null): { pnlKrw: number; pnlPct: number | null } {
  if (state == null || state.lastPrice == null) return { pnlKrw: 0, pnlPct: null };
  const openLayers = state.layers.filter((layer) => layer.status === "OPEN" && layer.qty > 0);
  const costKrw = openLayers.reduce((sum, layer) => sum + layer.amountKrw, 0);
  const valueKrw = openLayers.reduce((sum, layer) => sum + layer.qty * (state.lastPrice ?? 0), 0);
  const pnlKrw = Math.round(valueKrw - costKrw);
  return { pnlKrw, pnlPct: costKrw > 0 ? (pnlKrw / costKrw) * 100 : null };
}

function inferGridGapPct(state: BotState): number | null {
  const firstLayer = state.layers.find((layer) => layer.idx === 1);
  if (state.gridEntryPrice == null || firstLayer == null) return null;
  const gapPct = (state.gridEntryPrice - firstLayer.buyPrice) / state.gridEntryPrice;
  return Number.isFinite(gapPct) && gapPct > 0 ? gapPct : null;
}

interface DateWindow {
  start: Date;
  end: Date;
}

function getDailyReportWindow(now: Date): DateWindow {
  const kst = getKstParts(now);
  const endKst = new Date(Date.UTC(kst.year, kst.month - 1, kst.day, 6 - 9, 59, 59, 999));
  const startKst = new Date(endKst.getTime() - 23 * 60 * 60 * 1000 - 58 * 60 * 1000 - 59 * 1000 - 999);
  return { start: startKst, end: endKst };
}

function filterTradesByWindow(trades: TradeLogRecord[], window: DateWindow): TradeLogRecord[] {
  return trades.filter((trade) => {
    const timestamp = new Date(trade.timestamp).getTime();
    return timestamp >= window.start.getTime() && timestamp <= window.end.getTime();
  });
}

function getKstParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Seoul",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function formatKst(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatKstDateTime(value: string | null | undefined): string {
  if (value == null || value === "") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Seoul",
  }).format(date)} KST`;
}

async function readNewLogLines(path: string, offset: number): Promise<{ offset: number; records: TradeLogRecord[] }> {
  try {
    const fileStat = await stat(path);
    const raw = await readFile(path, "utf8");
    if (fileStat.size < offset) offset = 0;
    const text = raw.slice(offset);
    const records = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TradeLogRecord);
    return { offset: raw.length, records };
  } catch (error) {
    if (isMissingFileError(error)) return { offset: 0, records: [] };
    throw error;
  }
}

async function readTradeLogs(path: string): Promise<TradeLogRecord[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TradeLogRecord);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readRequiredState(path: string): Promise<BotState> {
  const state = await readJsonFile<BotState>(path);
  if (state == null) throw new Error("State file does not exist yet. Start the grid bot first.");
  return state;
}

async function readRuntimeState(path: string): Promise<TelegramRuntimeState> {
  return {
    ...defaultRuntimeState,
    ...((await readJsonFile<TelegramRuntimeState>(path)) ?? {}),
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function sendMessage(config: TelegramConfig, text: string): Promise<void> {
  const settings = await readTelegramSettings(config);
  if (settings.enabled === false) return;
  const credentials = readTelegramCredentialsFromSettings(config, settings);
  if (credentials == null) return;
  await telegramApi(config, credentials.token, "sendMessage", {
    chat_id: credentials.chatId,
    text,
    disable_web_page_preview: "true",
  });
}

async function telegramApi<T = unknown>(
  config: TelegramConfig,
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = await response.json();
  if (!response.ok) {
    await appendJsonLine("data/telegram_errors.jsonl", { timestamp: new Date().toISOString(), method, json });
    throw new Error(`Telegram ${method} HTTP ${response.status}`);
  }
  return json as T;
}

async function readTelegramCredentials(config: TelegramConfig): Promise<{ token: string; chatId: string } | null> {
  const settings = await readTelegramSettings(config);
  return readTelegramCredentialsFromSettings(config, settings);
}

async function readTelegramSettings(config: TelegramConfig): Promise<TelegramSettings> {
  return (await readJsonFile<TelegramSettings>(config.telegramSettingsPath)) ?? { enabled: true };
}

function normalizeGridNotificationMode(
  value: unknown,
  fallback: TelegramGridNotificationMode,
): TelegramGridNotificationMode {
  return value === "off" || value === "immediate" || value === "batch" ? value : fallback;
}

function normalizeGridBatchSize(value: unknown, fallback: number): number {
  const numberValue = Number(value ?? fallback);
  if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > 100) {
    return fallback > 0 ? fallback : 10;
  }
  return numberValue;
}

function readTelegramCredentialsFromSettings(
  config: TelegramConfig,
  settings: TelegramSettings,
): { token: string; chatId: string } | null {
  const token = settings.botToken || config.envToken;
  const chatId = settings.chatId || config.envChatId;
  if (token.length === 0 || chatId.length === 0) return null;
  return { token, chatId };
}

function formatKrw(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Math.round(value).toLocaleString("ko-KR")} KRW`;
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatStageList(stages: number[]): string {
  return stages.length === 0 ? "-" : [...stages].sort((left, right) => left - right).join(", ");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: number | string;
    };
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
