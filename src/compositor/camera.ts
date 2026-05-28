/**
 * Renderer-agnostic camera math. Shared between the Remotion offline
 * compositor and the PixiJS live preview so they stay pixel-aligned.
 *
 * The contract: both renderers call `sampleCamera(edit_plan.keyframes, t_ms)`
 * to get the camera state, then call `cameraTransform(state, viewport)` to
 * get the same translate/scale to apply to the recording layer. Any drift
 * is a bug — the parity test (`tests/camera-parity.test.ts`) is the gate.
 *
 * Why a separate module from the React composition:
 *   - PixiJS code can't import React-laden modules.
 *   - The PixiJS preview ships in the Mac app + webapp where React is
 *     present but Remotion's render machinery is not.
 *   - Keeping camera math in plain TS means we can unit-test it without
 *     spinning up a Remotion bundle.
 */

import { applyEase } from "../utils/easings.js";
import type { EditPlan } from "../plan/edit-plan.js";

export interface CameraState {
  /** 1.0 = wide; peak is typically 1.5–2.0. */
  zoom: number;
  /** Focal point as a fraction of the viewport (0..1). */
  focal_x: number;
  focal_y: number;
}

const DEFAULT_CAMERA: CameraState = { zoom: 1, focal_x: 0.5, focal_y: 0.5 };

/**
 * Sample the camera state at output time `t_ms` by interpolating between
 * the two surrounding keyframes. Uses the destination keyframe's `ease`
 * for the curve from previous → current. Outside the keyframe range,
 * holds the boundary state.
 *
 * Pure: same input → identical output, byte-for-byte.
 */
export function sampleCamera(
  keyframes: EditPlan["keyframes"],
  t_ms: number,
): CameraState {
  if (keyframes.length === 0) return { ...DEFAULT_CAMERA };
  const first = keyframes[0]!;
  if (t_ms <= first.out_t_ms) {
    return { zoom: first.zoom, focal_x: first.focal_x, focal_y: first.focal_y };
  }
  for (let i = 1; i < keyframes.length; i++) {
    const a = keyframes[i - 1]!;
    const b = keyframes[i]!;
    if (t_ms <= b.out_t_ms) {
      const span = Math.max(0.001, b.out_t_ms - a.out_t_ms);
      const u = (t_ms - a.out_t_ms) / span;
      const eased = applyEase(b.ease, Math.max(0, Math.min(1, u)));
      return {
        zoom: a.zoom + (b.zoom - a.zoom) * eased,
        focal_x: a.focal_x + (b.focal_x - a.focal_x) * eased,
        focal_y: a.focal_y + (b.focal_y - a.focal_y) * eased,
      };
    }
  }
  const last = keyframes[keyframes.length - 1]!;
  return { zoom: last.zoom, focal_x: last.focal_x, focal_y: last.focal_y };
}

export interface CameraTransform {
  /** Uniform scale to apply to the recording layer. */
  scale: number;
  /** Translation in viewport pixels (positive = shift right / down). */
  translate_x: number;
  translate_y: number;
}

/**
 * Convert a CameraState + viewport dimensions into a concrete
 * translate-then-scale transform anchored at the top-left of the
 * recording layer. Both renderers consume this identically.
 *
 * Math: the focal point (focal_x, focal_y) is the source-space position
 * that should appear in the OUTPUT center after the transform. We scale
 * the recording by `zoom`, then translate so the scaled focal point lands
 * at the viewport center.
 *
 *   x' = scale * x + translate_x
 *   center_x = scale * (focal_x * viewport_w) + translate_x
 *   ⇒ translate_x = center_x - scale * focal_x * viewport_w
 */
export function cameraTransform(
  state: CameraState,
  viewport: { width: number; height: number },
): CameraTransform {
  const scale = state.zoom;
  const center_x = viewport.width / 2;
  const center_y = viewport.height / 2;
  const translate_x = center_x - scale * state.focal_x * viewport.width;
  const translate_y = center_y - scale * state.focal_y * viewport.height;
  return { scale, translate_x, translate_y };
}

/**
 * Convenience: directly compute the source-time that should be displayed
 * at a given output time, accounting for segment trims + playback rate.
 *
 * Mirrors `srcToOut` from edit-plan.ts but inverted. Both renderers need
 * this to pick the right source frame / cursor sample for the current
 * output frame.
 *
 * Returns null when the output time falls past the end of all segments
 * (caller should hold the last frame).
 */
export function outToSrc(
  out_t_ms: number,
  segments: EditPlan["segments"],
  playback_rate: number,
): number | null {
  if (segments.length === 0) return null;
  const src_offset = out_t_ms * playback_rate;
  let acc = 0;
  for (const seg of segments) {
    const dur = seg.src_end_ms - seg.src_start_ms;
    if (src_offset <= acc + dur) {
      return seg.src_start_ms + (src_offset - acc);
    }
    acc += dur;
  }
  return null;
}
