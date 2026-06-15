import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface SafetySwitchState {
  paused: boolean;
  buyPaused: boolean;
  sellPaused: boolean;
  reason: string | null;
}

interface ControlFileState {
  paused?: boolean;
  buyPaused?: boolean;
  sellPaused?: boolean;
  reason?: string | null;
}

export async function readSafetySwitch(): Promise<SafetySwitchState> {
  const envState = readSafetySwitchFromEnv();
  const fileState = await readSafetySwitchFromFile();
  return {
    paused: envState.paused || fileState.paused,
    buyPaused: envState.buyPaused || fileState.buyPaused,
    sellPaused: envState.sellPaused || fileState.sellPaused,
    reason: envState.reason ?? fileState.reason,
  };
}

function readSafetySwitchFromEnv(): SafetySwitchState {
  const rawPaused = process.env.GRID_BOT_PAUSED;
  const paused = rawPaused != null && ["1", "true", "yes", "on"].includes(rawPaused.toLowerCase());
  const rawBuyPaused = process.env.GRID_BOT_BUY_PAUSED;
  const buyPaused = rawBuyPaused != null && ["1", "true", "yes", "on"].includes(rawBuyPaused.toLowerCase());
  const rawSellPaused = process.env.GRID_BOT_SELL_PAUSED;
  const sellPaused = rawSellPaused != null && ["1", "true", "yes", "on"].includes(rawSellPaused.toLowerCase());
  return {
    paused,
    buyPaused,
    sellPaused,
    reason: paused || buyPaused || sellPaused ? process.env.GRID_BOT_PAUSE_REASON || "Paused by environment" : null,
  };
}

async function readSafetySwitchFromFile(): Promise<SafetySwitchState> {
  const path = resolve(process.cwd(), process.env.GRID_BOT_CONTROL_PATH || "data/control/grid_control.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ControlFileState;
    return {
      paused: parsed.paused === true,
      buyPaused: parsed.buyPaused === true,
      sellPaused: parsed.sellPaused === true,
      reason: parsed.reason ?? null,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { paused: false, buyPaused: false, sellPaused: false, reason: null };
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
