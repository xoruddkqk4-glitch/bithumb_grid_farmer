import type { BotPhase } from "../../../../packages/shared/src/types";

export function canBuyGrid(phase: BotPhase): boolean {
  return phase === "GRID";
}

export function canSellGrid(phase: BotPhase): boolean {
  return phase === "GRID";
}
