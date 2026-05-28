/**
 * Renderer-agnostic cursor sampling math. Shared between the Remotion
 * offline compositor and the PixiJS live preview so the cursor position
 * at any output time is identical across both render paths.
 *
 * Scope: linear interpolation between cursor.json samples to produce a
 * raw (vx, vy) at time t. The Remotion path layers spring smoothing,
 * arc waypoints, sway, and click bounce on top via separate modules
 * (utils/springs.ts, compositor/cursor.tsx) — those will be ported to
 * PixiJS iteratively, each with its own parity test. This module is the
 * floor: matching the raw trajectory.
 *
 * Why a separate module from compositor/camera.ts: cursor math reads
 * cursor.json which the camera math doesn't, and grouping unrelated
 * primitives in one file makes per-layer parity tests harder to scope.
 */

import type { CursorSample } from "../recorder/events.js";
import { outToSrc } from "./camera.js";
import type { EditPlan } from "../plan/edit-plan.js";

export interface RawCursorPosition {
  /** Viewport-space x in pixels. */
  x: number;
  /** Viewport-space y in pixels. */
  y: number;
  /** Source-time used to sample (ms from recording start). null = past end. */
  src_t_ms: number | null;
  /** Whichever CursorKind was active at the sample we interpolated to. */
  kind: CursorSample["kind"];
}

/**
 * Find the cursor position at a given source-recording time by linear
 * interpolation between the two surrounding samples. Returns the kind
 * of the destination sample (the "next" one) so the renderer can swap
 * sprites at the right instant.
 *
 * O(log n) — binary search over the sorted samples.
 *
 * Out of range:
 *   - t before first sample: returns the first sample's position
 *   - t after last sample:  returns the last sample's position
 *   - empty samples:         returns (0, 0)
 */
export function sampleCursorAtSrcTime(
  samples: CursorSample[],
  src_t_ms: number,
): RawCursorPosition {
  if (samples.length === 0) {
    return { x: 0, y: 0, src_t_ms: null, kind: undefined };
  }
  const first = samples[0]!;
  if (src_t_ms <= first.t_ms) {
    return { x: first.x, y: first.y, src_t_ms: first.t_ms, kind: first.kind };
  }
  const last = samples[samples.length - 1]!;
  if (src_t_ms >= last.t_ms) {
    return { x: last.x, y: last.y, src_t_ms: last.t_ms, kind: last.kind };
  }

  // Binary search for the highest index where samples[i].t_ms <= src_t_ms.
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid]!.t_ms <= src_t_ms) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const span = Math.max(0.001, b.t_ms - a.t_ms);
  const u = (src_t_ms - a.t_ms) / span;
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    src_t_ms,
    kind: b.kind,
  };
}

/**
 * Sample the cursor at an OUTPUT time. Convenience: maps output → source
 * via the edit-plan, then samples. Returns null when the output time is
 * past the end of all segments (caller should hold last position).
 */
export function sampleCursorAtOutTime(
  samples: CursorSample[],
  out_t_ms: number,
  segments: EditPlan["segments"],
  playback_rate: number,
): RawCursorPosition | null {
  const src_t = outToSrc(out_t_ms, segments, playback_rate);
  if (src_t == null) return null;
  return sampleCursorAtSrcTime(samples, src_t);
}
