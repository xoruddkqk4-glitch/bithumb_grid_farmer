import type { BotPhase, BotState, GridLayer } from "./types";

export interface ReconciliationResult {
  ok: boolean;
  warnings: string[];
}

export function reconcileBotState(state: BotState): ReconciliationResult {
  const warnings: string[] = [];
  const duplicateIndexes = findDuplicateLayerIndexes(state.layers);

  if (duplicateIndexes.length > 0) {
    warnings.push(`Duplicate grid layer indexes found: ${duplicateIndexes.join(", ")}`);
  }

  for (const layer of state.layers) {
    warnings.push(...reconcileLayer(layer));
  }

  if (state.phase !== "GRID") {
    const neverBoughtIndexes = state.layers
      .filter((layer) => layer.buyCount === 0)
      .map((layer) => layer.idx);
    if (neverBoughtIndexes.length > 0) {
      warnings.push(
        `${state.phase} phase has layers that were never bought: ${neverBoughtIndexes.join(", ")}`,
      );
    }
  }

  const invalidPhase = reconcilePhase(state.phase);
  if (invalidPhase != null) {
    warnings.push(invalidPhase);
  }

  return {
    ok: warnings.length === 0,
    warnings,
  };
}

export function reconcilePaperState(state: BotState): ReconciliationResult {
  return reconcileBotState(state);
}

function reconcileLayer(layer: GridLayer): string[] {
  const warnings: string[] = [];

  if (!Number.isInteger(layer.idx) || layer.idx <= 0) {
    warnings.push(`Layer has invalid idx: ${layer.idx}`);
  }
  if (layer.amountKrw <= 0) {
    warnings.push(`Layer ${layer.idx} has non-positive amountKrw: ${layer.amountKrw}.`);
  }
  if (layer.buyPrice <= 0 || layer.sellPrice <= 0) {
    warnings.push(`Layer ${layer.idx} has non-positive buy/sell price.`);
  }
  if (layer.buyPrice >= layer.sellPrice) {
    warnings.push(`Layer ${layer.idx} buyPrice must be below sellPrice.`);
  }
  if (layer.buyCount < layer.sellCount) {
    warnings.push(`Layer ${layer.idx} sellCount exceeds buyCount.`);
  }
  if (layer.buyCount > 0 && layer.buyOrderId == null) {
    warnings.push(`Layer ${layer.idx} has buyCount=${layer.buyCount} but no buyOrderId.`);
  }
  if (layer.sellCount > 0 && layer.sellOrderId == null) {
    warnings.push(`Layer ${layer.idx} has sellCount=${layer.sellCount} but no sellOrderId.`);
  }
  if (layer.status === "OPEN" && layer.qty <= 0) {
    warnings.push(`Layer ${layer.idx} is OPEN but qty is ${layer.qty}.`);
  }
  if (layer.status === "WAITING" && layer.qty !== 0) {
    warnings.push(`Layer ${layer.idx} is WAITING but qty is ${layer.qty}.`);
  }
  if (layer.status === "SOLD" && layer.qty !== 0) {
    warnings.push(`Layer ${layer.idx} is SOLD but qty is ${layer.qty}.`);
  }

  return warnings;
}

function reconcilePhase(phase: BotPhase): string | null {
  return ["GRID", "FARMING", "HOLDING", "COOLDOWN"].includes(phase)
    ? null
    : `Invalid bot phase: ${String(phase)}`;
}

function findDuplicateLayerIndexes(layers: GridLayer[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const layer of layers) {
    if (seen.has(layer.idx)) {
      duplicates.add(layer.idx);
    }
    seen.add(layer.idx);
  }
  return [...duplicates];
}
