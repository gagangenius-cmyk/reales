/**
 * Money is handled in integer minor units (fils) so sums never drift. DECIMAL(18,2) columns arrive from MySQL as strings.
 * Safe range: up to ~90 trillion AED as a JS integer, far beyond any single transaction.
 */
export const toMinor = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error("Invalid money amount");
  return Math.round(n * 100);
};

export const fromMinor = (m: number): string => (m / 100).toFixed(2);

/** Split `totalMinor` by percentages with the largest-remainder method: parts always sum exactly to the total. */
export function allocateByPct(totalMinor: number, pcts: number[]): number[] {
  const sum = pcts.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1e-9) throw new Error("Percentages must sum to 100");
  const raw = pcts.map((p) => (totalMinor * p) / 100);
  const floors = raw.map(Math.floor);
  let remainder = totalMinor - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i]! += 1;
    remainder -= 1;
  }
  return floors;
}

/** VAT on a net amount, half-up to the fils. */
export const vatOf = (netMinor: number, ratePct: number): number => Math.round((netMinor * ratePct) / 100);

/** Split a total into `n` near-equal parts that sum exactly to the total (the first parts take the remainder fils). */
export function allocateEqual(totalMinor: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
  const base = Math.floor(totalMinor / n);
  const extra = totalMinor - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
