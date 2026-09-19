/**
 * Helpers shared by the gesture detectors. The Detector contract itself lives
 * in core/types.ts.
 */

/** Clamp a number into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Map a crossing speed (h/s) to an intensity in [floor, 1] with a perceptual
 * curve: `u = (v − vMin) / (vMax − vMin)` clamped, then `floor + (1 − floor)·u^0.7`.
 * Drums use floor 0.3, strums 0.35 (see the plan's appendix).
 */
export function speedToIntensity(v: number, vMin: number, vMax: number, floor = 0.3): number {
  const u = clamp((v - vMin) / Math.max(1e-6, vMax - vMin), 0, 1);
  return floor + (1 - floor) * Math.pow(u, 0.7);
}
