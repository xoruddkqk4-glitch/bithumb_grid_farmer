import { DEFAULT_GRID_GAP_PCT, DEFAULT_GRID_LEVELS, DEFAULT_GRID_RATIO } from "./constants";
import { assertPositiveNumber, roundKrw, roundQty } from "./money";
import type { GridLayer, GridLevelSetting } from "./types";

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
  levelSettings?: GridLevelSetting[] | undefined;
}

export function generateGridLayers(input: GenerateGridLayersInput): GridLayer[] {
  const levels = input.levels ?? DEFAULT_GRID_LEVELS;
  const gapPct = input.gapPct ?? DEFAULT_GRID_GAP_PCT;

  assertPositiveNumber("entryPrice", input.entryPrice);
  assertPositiveNumber("orderAmountKrw", input.orderAmountKrw);
  assertPositiveNumber("levels", levels);
  assertPositiveNumber("gapPct", gapPct);

  let previousBuyPrice = input.entryPrice;
  return Array.from({ length: levels }, (_, index) => {
    const idx = index + 1;
    const levelSetting = normalizeGridLevelSetting(input.levelSettings?.find((setting) => setting.level === idx), idx, gapPct);
    const buyPrice = roundKrw(previousBuyPrice * (1 - levelSetting.buyGapPct));
    const sellPrice = roundKrw(buyPrice * (1 + levelSetting.takeProfitPct));
    const amountKrw = roundKrw(input.orderAmountKrw * levelSetting.buyAmountMultiplier);
    previousBuyPrice = buyPrice;
    return {
      idx,
      buyPrice,
      sellPrice,
      amountKrw,
      buyGapPct: levelSetting.buyGapPct,
      buyAmountMultiplier: levelSetting.buyAmountMultiplier,
      takeProfitPct: levelSetting.takeProfitPct,
      trailingPullbackPct: levelSetting.trailingPullbackPct,
      trailingActive: false,
      trailingHighPrice: null,
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

export function buildDefaultGridLevelSettings(levels: number, gapPct = DEFAULT_GRID_GAP_PCT): GridLevelSetting[] {
  assertPositiveNumber("levels", levels);
  assertPositiveNumber("gapPct", gapPct);
  return Array.from({ length: levels }, (_, index) => normalizeGridLevelSetting(null, index + 1, gapPct));
}

export function normalizeGridLevelSetting(
  setting: Partial<GridLevelSetting> | null | undefined,
  level: number,
  fallbackGapPct = DEFAULT_GRID_GAP_PCT,
): GridLevelSetting {
  const buyGapPct = Number(setting?.buyGapPct ?? fallbackGapPct);
  const buyAmountMultiplier = Number(setting?.buyAmountMultiplier ?? 1);
  const takeProfitPct = Number(setting?.takeProfitPct ?? fallbackGapPct);
  const trailingPullbackPct = Number(setting?.trailingPullbackPct ?? 0);

  if (!Number.isInteger(level) || level < 1) {
    throw new Error(`Grid level must be a positive integer. Received: ${level}`);
  }
  assertPositiveNumber("buyGapPct", buyGapPct);
  assertPositiveNumber("buyAmountMultiplier", buyAmountMultiplier);
  assertPositiveNumber("takeProfitPct", takeProfitPct);
  if (!Number.isFinite(trailingPullbackPct) || trailingPullbackPct < 0) {
    throw new Error(`trailingPullbackPct must be zero or positive. Received: ${trailingPullbackPct}`);
  }

  return {
    level,
    buyGapPct,
    buyAmountMultiplier,
    takeProfitPct,
    trailingPullbackPct,
  };
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
