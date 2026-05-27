/**
 * Percentile calculation utilities.
 */

export function computePercentile(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.floor((sorted.length - 1) * percentile);
  return sorted[index] ?? null;
}
