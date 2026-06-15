export function roundKrw(value: number): number {
  return Math.round(value);
}

export function roundQty(value: number): number {
  return Math.floor(value * 100_000_000) / 100_000_000;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function assertPositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number. Received: ${value}`);
  }
}
