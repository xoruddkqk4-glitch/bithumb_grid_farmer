import { DEFAULT_GRID_GAP_PCT, DEFAULT_GRID_LEVELS, DEFAULT_GRID_RATIO } from "./constants";
import { assertPositiveNumber, roundKrw, roundQty } from "./money";
import type { GridLayer, GridLevelSetting } from "./types";

export interface GridSizingInput {
  totalCapitalKrw: number;
  gridRatio?: number;
  levels?: number;
  levelSettings?: GridLevelSetting[] | undefined;
}

export interface GridSizing {
  gridInvestmentKrw: number;
  orderAmountKrw: number;
  multiplierTotal: number;
}

export function calculateGridSizing(input: GridSizingInput): GridSizing {
  const gridRatio = input.gridRatio ?? DEFAULT_GRID_RATIO;
  const levels = input.levels ?? DEFAULT_GRID_LEVELS;

  assertPositiveNumber("totalCapitalKrw", input.totalCapitalKrw);
  assertPositiveNumber("gridRatio", gridRatio);
  assertPositiveNumber("levels", levels);

  const gridInvestmentKrw = roundKrw(input.totalCapitalKrw * gridRatio);
  const multiplierTotal = calculateGridMultiplierTotal(levels, input.levelSettings);
  return {
    gridInvestmentKrw,
    orderAmountKrw: roundKrw(gridInvestmentKrw / multiplierTotal),
    multiplierTotal,
  };
}

export function calculateGridMultiplierTotal(
  levels: number,
  levelSettings?: GridLevelSetting[] | undefined,
): number {
  assertPositiveNumber("levels", levels);
  return Array.from({ length: levels }, (_, index) =>
    normalizeGridLevelSetting(
      levelSettings?.find((setting) => setting.level === index + 1),
      index + 1,
    ).buyAmountMultiplier,
  ).reduce((sum, multiplier) => sum + multiplier, 0);
}

export interface GenerateGridLayersInput {
  entryPrice: number;
  orderAmountKrw: number;
  targetInvestmentKrw?: number | undefined;
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
  if (input.targetInvestmentKrw != null) {
    assertPositiveNumber("targetInvestmentKrw", input.targetInvestmentKrw);
  }

  let previousBuyPrice = input.entryPrice;
  const settings = Array.from({ length: levels }, (_, index) => {
    const idx = index + 1;
    return normalizeGridLevelSetting(input.levelSettings?.find((setting) => setting.level === idx), idx, gapPct);
  });
  const roundedAmounts = settings.map((setting) => roundKrw(input.orderAmountKrw * setting.buyAmountMultiplier));
  if (input.targetInvestmentKrw != null && roundedAmounts.length > 0) {
    const previousSum = roundedAmounts.slice(0, -1).reduce((sum, amount) => sum + amount, 0);
    roundedAmounts[roundedAmounts.length - 1] = Math.max(1, roundKrw(input.targetInvestmentKrw - previousSum));
  }

  return settings.map((levelSetting, index) => {
    const idx = index + 1;
    const buyPrice = roundKrw(previousBuyPrice * (1 - levelSetting.buyGapPct));
    const sellPrice = roundKrw(buyPrice * (1 + levelSetting.takeProfitPct));
    previousBuyPrice = buyPrice;
    return {
      idx,
      buyPrice,
      sellPrice,
      amountKrw: roundedAmounts[index] ?? roundKrw(input.orderAmountKrw * levelSetting.buyAmountMultiplier),
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
