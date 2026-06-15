import { DEFAULT_GRID_GAP_PCT, DEFAULT_GRID_LEVELS, DEFAULT_GRID_RATIO } from "./constants";
import { assertPositiveNumber, roundKrw, roundQty } from "./money";
import type { GridLayer } from "./types";

export interface GridSizingInput {
  totalCapitalKrw: number;
  gridRatio?: number;
  levels?: number;
}

export interface GridSizing {
  gridInvestmentKrw: number;
  orderAmountKrw: number;
}

export function calculateGridSizing(input: GridSizingInput): GridSizing {
  const gridRatio = input.gridRatio ?? DEFAULT_GRID_RATIO;
  const levels = input.levels ?? DEFAULT_GRID_LEVELS;

  assertPositiveNumber("totalCapitalKrw", input.totalCapitalKrw);
  assertPositiveNumber("gridRatio", gridRatio);
  assertPositiveNumber("levels", levels);

  const gridInvestmentKrw = roundKrw(input.totalCapitalKrw * gridRatio);
  return {
    gridInvestmentKrw,
    orderAmountKrw: roundKrw(gridInvestmentKrw / levels),
  };
}

export interface GenerateGridLayersInput {
  entryPrice: number;
  orderAmountKrw: number;
  levels?: number;
  gapPct?: number;
}

export function generateGridLayers(input: GenerateGridLayersInput): GridLayer[] {
  const levels = input.levels ?? DEFAULT_GRID_LEVELS;
  const gapPct = input.gapPct ?? DEFAULT_GRID_GAP_PCT;

  assertPositiveNumber("entryPrice", input.entryPrice);
  assertPositiveNumber("orderAmountKrw", input.orderAmountKrw);
  assertPositiveNumber("levels", levels);
  assertPositiveNumber("gapPct", gapPct);

  return Array.from({ length: levels }, (_, index) => {
    const idx = index + 1;
    const buyPrice = roundKrw(input.entryPrice * (1 - gapPct * idx));
    const sellPrice = roundKrw(input.entryPrice * (1 - gapPct * (idx - 1)));
    return {
      idx,
      buyPrice,
      sellPrice,
      amountKrw: input.orderAmountKrw,
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
}

export function calculateBuyQty(amountKrw: number, price: number): number {
  assertPositiveNumber("amountKrw", amountKrw);
  assertPositiveNumber("price", price);
  return roundQty(amountKrw / price);
}

export function shouldBuyLayer(currentPrice: number, layer: Pick<GridLayer, "buyPrice" | "status">): boolean {
  return (layer.status === "WAITING" || layer.status === "SOLD") && currentPrice <= layer.buyPrice;
}

export function shouldSellLayer(currentPrice: number, layer: Pick<GridLayer, "sellPrice" | "status" | "qty">): boolean {
  return layer.status === "OPEN" && layer.qty > 0 && currentPrice >= layer.sellPrice;
}

export function allLayersBoughtAtLeastOnce(layers: Pick<GridLayer, "buyCount">[]): boolean {
  return layers.length > 0 && layers.every((layer) => layer.buyCount > 0);
}
