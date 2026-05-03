/**
 * Named easing curves as cubic-bezier control points.
 *
 * Reference shapes follow the Penner/CSS easing tradition. We export both the
 * bezier control points (for Remotion / CSS / SVG consumers) and a pure-JS
 * `applyEase(name, t)` for our own interpolation paths.
 *
 * principle 2 (easings): every animated property uses a name from this table;
 * never `linear` outside of test/control comparisons.
 */

import type { EaseName } from "../core/principles.js";

/** Cubic-bezier control points: [p1x, p1y, p2x, p2y] in 0..1. */
export const EASE_BEZIERS: Record<EaseName, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  quad_in: [0.55, 0.085, 0.68, 0.53],
  quad_out: [0.25, 0.46, 0.45, 0.94],
  quad_in_out: [0.455, 0.03, 0.515, 0.955],
  cubic_in: [0.55, 0.055, 0.675, 0.19],
  cubic_out: [0.215, 0.61, 0.355, 1.0],
  cubic_in_out: [0.645, 0.045, 0.355, 1.0],
  quart_in: [0.895, 0.03, 0.685, 0.22],
  quart_out: [0.165, 0.84, 0.44, 1.0],
  quart_in_out: [0.77, 0.0, 0.175, 1.0],
  quint_in: [0.755, 0.05, 0.855, 0.06],
  quint_out: [0.23, 1.0, 0.32, 1.0],
  expo_in: [0.95, 0.05, 0.795, 0.035],
  expo_out: [0.19, 1.0, 0.22, 1.0],
  back_in: [0.6, -0.28, 0.735, 0.045],
  back_out: [0.175, 0.885, 0.32, 1.275],
  back_in_out: [0.68, -0.55, 0.265, 1.55],
  sine_in: [0.47, 0.0, 0.745, 0.715],
  sine_out: [0.39, 0.575, 0.565, 1.0],
  sine_in_out: [0.445, 0.05, 0.55, 0.95],
};

/**
 * Cubic bezier value at t for control points (p1x, p1y, p2x, p2y).
 * Uses the standard parametric form, with t recovered from x via Newton-Raphson.
 */
function bezierY(p1x: number, p1y: number, p2x: number, p2y: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Solve for t such that bezierX(t) = x; use Newton-Raphson then bisection fallback.
  const ax = 3 * p1x - 3 * p2x + 1;
  const bx = 3 * p2x - 6 * p1x;
  const cx = 3 * p1x;
  const ay = 3 * p1y - 3 * p2y + 1;
  const by = 3 * p2y - 6 * p1y;
  const cy = 3 * p1y;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const xt = ((ax * t + bx) * t + cx) * t - x;
    const dxt = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(dxt) < 1e-6) break;
    t -= xt / dxt;
  }

  // Clamp t back into [0,1] in case of overshoot during Newton iteration.
  t = Math.max(0, Math.min(1, t));

  return ((ay * t + by) * t + cy) * t;
}

export function applyEase(name: EaseName, t: number): number {
  if (name === "linear") return t;
  const [p1x, p1y, p2x, p2y] = EASE_BEZIERS[name];
  return bezierY(p1x, p1y, p2x, p2y, t);
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function easedLerp(from: number, to: number, t: number, ease: EaseName): number {
  return lerp(from, to, applyEase(ease, t));
}
