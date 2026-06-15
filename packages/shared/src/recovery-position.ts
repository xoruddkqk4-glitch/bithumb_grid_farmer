import { roundKrw, roundQty } from "./money";
import type { GridLayer } from "./types";

export type RecoveryPositionLegType = "GRID" | "FARMER";

export interface RecoveryPositionLeg {
  type: RecoveryPositionLegType;
  stage: number;
  qty: number;
  costKrw: number;
  sourceOrderId: string | null;
  openedAt: string | null;
}

export interface FarmerPositionLegInput {
  stage: number;
  qty: number;
  costKrw: number;
  sourceOrderId?: string | null;
  openedAt?: string | null;
}

export interface RecoveryPosition {
  legs: RecoveryPositionLeg[];
  totalQty: number;
  totalCostKrw: number;
  averageCostKrw: number | null;
  marketValueKrw: number | null;
  unrealizedPnlKrw: number | null;
  unrealizedPnlPct: number | null;
}

export function buildRecoveryPosition(input: {
  gridLayers: GridLayer[];
  farmerLegs?: FarmerPositionLegInput[];
  lastPrice?: number | null;
}): RecoveryPosition {
  const gridLegs = input.gridLayers
    .filter((layer) => layer.status === "OPEN" && layer.qty > 0)
    .map((layer): RecoveryPositionLeg => ({
      type: "GRID",
      stage: layer.idx,
      qty: layer.qty,
      costKrw: layer.amountKrw,
      sourceOrderId: layer.buyOrderId,
      openedAt: layer.boughtAt,
    }));
  const farmerLegs = (input.farmerLegs ?? [])
    .filter((leg) => leg.qty > 0 && leg.costKrw > 0)
    .map((leg): RecoveryPositionLeg => ({
      type: "FARMER",
      stage: leg.stage,
      qty: leg.qty,
      costKrw: leg.costKrw,
      sourceOrderId: leg.sourceOrderId ?? null,
      openedAt: leg.openedAt ?? null,
    }));
  const legs = [...gridLegs, ...farmerLegs];
  const totalQty = roundQty(legs.reduce((sum, leg) => sum + leg.qty, 0));
  const totalCostKrw = legs.reduce((sum, leg) => sum + leg.costKrw, 0);
  const averageCostKrw = totalQty > 0 ? roundKrw(totalCostKrw / totalQty) : null;
  const marketValueKrw = input.lastPrice != null && totalQty > 0
    ? roundKrw(totalQty * input.lastPrice)
    : null;
  const unrealizedPnlKrw = marketValueKrw == null ? null : roundKrw(marketValueKrw - totalCostKrw);
  const unrealizedPnlPct = unrealizedPnlKrw != null && totalCostKrw > 0
    ? (unrealizedPnlKrw / totalCostKrw) * 100
    : null;

  return {
    legs,
    totalQty,
    totalCostKrw: roundKrw(totalCostKrw),
    averageCostKrw,
    marketValueKrw,
    unrealizedPnlKrw,
    unrealizedPnlPct,
  };
}
