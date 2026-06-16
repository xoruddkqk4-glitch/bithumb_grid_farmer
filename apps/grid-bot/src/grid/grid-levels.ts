import {
  calculateGridSizing,
  generateGridLayers,
  type GridSizing,
} from "../../../../packages/shared/src/grid-math";
import type { GridLayer, GridLevelSetting } from "../../../../packages/shared/src/types";

export interface BuildGridInput {
  entryPrice: number;
  totalCapitalKrw: number;
  gridRatio: number;
  levels: number;
  gapPct: number;
  levelSettings?: GridLevelSetting[] | undefined;
}

export interface BuiltGrid {
  sizing: GridSizing;
  layers: GridLayer[];
}

export function buildGrid(input: BuildGridInput): BuiltGrid {
  const sizing = calculateGridSizing({
    totalCapitalKrw: input.totalCapitalKrw,
    gridRatio: input.gridRatio,
    levels: input.levels,
    levelSettings: input.levelSettings,
  });

  return {
    sizing,
    layers: generateGridLayers({
      entryPrice: input.entryPrice,
      orderAmountKrw: sizing.orderAmountKrw,
      targetInvestmentKrw: sizing.gridInvestmentKrw,
      levels: input.levels,
      gapPct: input.gapPct,
      levelSettings: input.levelSettings,
    }),
  };
}
