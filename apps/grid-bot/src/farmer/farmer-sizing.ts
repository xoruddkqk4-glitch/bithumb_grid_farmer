import { buildRecoveryPosition, roundKrw } from "../../../../packages/shared/src";
import type { BotState } from "../../../../packages/shared/src/types";
import type { GridBotConfig } from "../config";
import type { FarmerSizingResult } from "./farmer-types";

export function calculateFarmerSizing(params: {
  state: BotState;
  price: number;
  config: GridBotConfig;
}): FarmerSizingResult {
  const recoveryPosition = buildRecoveryPosition({
    gridLayers: params.state.layers,
    farmerLegs: (params.state.farmerPositions ?? []).map((position) => ({
      stage: position.stage,
      qty: position.qty,
      costKrw: position.costKrw,
      sourceOrderId: position.orderId,
      openedAt: position.boughtAt,
    })),
    lastPrice: params.price,
  });
  const recoveryPositionValueKrw = recoveryPosition.marketValueKrw ?? 0;
  const availableKrw = estimateAvailableKrw(params.state);
  const targetOrderKrw = roundKrw(recoveryPositionValueKrw);
  const cappedOrderKrw = roundKrw(Math.min(targetOrderKrw, Math.max(0, availableKrw)));
  const stage = params.state.farmerStage + 1;
  const defenseStatus = cappedOrderKrw >= targetOrderKrw
    ? "FULL_DEFENSE"
    : stage >= 3 && params.config.farmerAllowFinalCapBuy && cappedOrderKrw >= params.config.farmerMinOrderKrw
      ? "PARTIAL_DEFENSE"
      : "CASH_SHORTAGE";

  return {
    targetOrderKrw,
    cappedOrderKrw,
    defenseStatus,
    recoveryPositionValueKrw,
  };
}

function estimateAvailableKrw(state: BotState): number {
  const investedGridKrw = state.layers
    .filter((layer) => layer.status === "OPEN" && layer.qty > 0)
    .reduce((sum, layer) => sum + layer.amountKrw, 0);
  const investedFarmerKrw = (state.farmerPositions ?? []).reduce((sum, position) => sum + position.costKrw, 0);
  return Math.max(0, state.totalCapitalKrw - investedGridKrw - investedFarmerKrw);
}
