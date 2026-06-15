import {
  calculateGridSizing,
  generateGridLayers,
  type GridSizing,
} from "../../../../packages/shared/src/grid-math";
import type { GridLayer } from "../../../../packages/shared/src/types";

export interface BuildGridInput {
  entryPrice: number;
  totalCapitalKrw: number;
  gridRatio: number;
  levels: number;
  gapPct: number;
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
  });

  return {
    sizing,
    layers: generateGridLayers({
      entryPrice: input.entryPrice,
      orderAmountKrw: sizing.orderAmountKrw,
      levels: input.levels,
      gapPct: input.gapPct,
    }),
  };
}
