import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BOT_STATE_SCHEMA_VERSION,
  DEFAULT_FARMER_ENTRY_PCT,
  DEFAULT_FARMER_ENTRY_PCTS,
  STRATEGY_VERSION,
} from "../../../../packages/shared/src/constants";
import type { BotState } from "../../../../packages/shared/src/types";

export interface CreateInitialStateInput {
  botId: string;
  market: string;
  totalCapitalKrw: number;
}

export class LocalStateStore {
  constructor(private readonly statePath: string) {}

  async readOrCreate(input: CreateInitialStateInput): Promise<BotState> {
    try {
      return await this.read();
    } catch (error) {
      if (!isFileMissingError(error)) {
        throw error;
      }
      const state = createInitialState(input);
      await this.writeAtomic(state);
      return state;
    }
  }

  async read(): Promise<BotState> {
    const raw = await readFile(this.statePath, "utf8");
    const parsed = JSON.parse(raw) as BotState;
    validateState(parsed);
    return parsed;
  }

  async writeAtomic(state: BotState): Promise<void> {
    const nextState: BotState = {
      ...state,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }
}

export function createInitialState(input: CreateInitialStateInput): BotState {
  const now = new Date().toISOString();
  return {
    schemaVersion: BOT_STATE_SCHEMA_VERSION,
    strategyVersion: STRATEGY_VERSION,
    botId: input.botId,
    market: input.market,
    phase: "GRID",
    cycleId: createCycleId(now),
    gridEntryPrice: null,
    gridEntryReferencePrice: null,
    gridEntryNValue: null,
    gridEntryNCalculatedForKstDate: null,
    gridFirstBuyMode: "N_MULTIPLE",
    gridFirstBuyNMultiplier: 0.5,
    gridInvestmentKrw: 0,
    gridOrderAmountKrw: 0,
    totalCapitalKrw: input.totalCapitalKrw,
    accountCapitalKrw: null,
    accountCapitalUpdatedAt: null,
    accountKrwBalance: null,
    accountKrwLocked: null,
    accountAssetBalance: null,
    accountAssetLocked: null,
    accountAssetValueKrw: null,
    layers: [],
    farmerStage: 0,
    farmerEntryPct: DEFAULT_FARMER_ENTRY_PCT,
    farmerEntryPcts: DEFAULT_FARMER_ENTRY_PCTS,
    farmerMax3dDrawdownPct: -0.25,
    farmerStage2CooldownDays: 3,
    farmerStage3CooldownDays: 5,
    farmerUsePriceReachedFilter: true,
    farmerUseLongTrendFilter: true,
    farmerUseTurnoverRatioFilter: true,
    farmerUseMa5TrendFilter: true,
    farmerUseClosePositionFilter: true,
    farmerUseBullishDailyFilter: true,
    farmerUseTwoBullishDailyFilter: true,
    farmerUseVolatilityExplosionFilter: true,
    farmerAnchorPrice: null,
    farmerLastBuyAt: null,
    farmerLastBuyPrice: null,
    farmerDefenseStatus: null,
    farmerSignal: null,
    farmerPositions: [],
    gridLoopIntervalMs: 60_000,
    farmingLoopIntervalMs: 300_000,
    recoveryExitSignal: null,
    enableRecoveryTurtleSell: false,
    recoveryTurtleNPeriod: 20,
    recoveryTurtleLowBreakoutPeriod: 20,
    recoveryTurtleNMultiplier: 2,
    recoveryTurtleMinOrderKrw: 5_000,
    recoveryUseSliceOrder: true,
    recoveryTurtleSliceOrderKrw: 1_000_000,
    recoveryTurtleSliceIntervalSeconds: 10,
    recoveryUse2NTrailExit: true,
    recoveryUseMa5Exit: true,
    recoveryUseLowBreakoutExit: true,
    recoveryTrailingActivationMode: "TP1",
    partialTakeProfitEnabled: false,
    takeProfit1ReturnPct: 0.1,
    takeProfit1SellRatio: 0.33,
    takeProfit1Done: false,
    takeProfit2ReturnPct: 0.2,
    takeProfit2SellRatio: 0.33,
    takeProfit2Done: false,
    gridResetRequestedAt: null,
    gridResetCompletedAt: null,
    gridResetLastError: null,
    highestPrice: 0,
    nValue: null,
    cooldownUntil: null,
    lastExitTime: null,
    lastPrice: null,
    lastLoopAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createCycleId(isoTimestamp: string): string {
  return `${isoTimestamp.replace(/[:.]/g, "-")}-001`;
}

function validateState(state: BotState): void {
  if (state.schemaVersion !== BOT_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported bot_state schemaVersion ${state.schemaVersion}. Expected ${BOT_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (!state.botId || !state.market || !state.phase || !state.cycleId) {
    throw new Error("bot_state.json is missing required fields.");
  }
}

function isFileMissingError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
