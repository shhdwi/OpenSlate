/**
 * Renderer-agnostic frame-picking math.
 *
 * Recordings are captured via CDP screencast, which is delta-emitted —
 * frames only land when the page changes. So `manifest.frame_timestamps_ms`
 * is non-uniform and `manifest.frame_indices` is the sparse list of
 * indices that actually exist on disk. The renderer can't just do
 * `frames/frame_<round(t * fps / 1000)>.png` — it would 404 on every
 * static second of the recording.
 *
 * `pickFrame()` is the binary-searched lookup that both the Remotion
 * offline path and the PixiJS live preview consume. Same input → same
 * frame, byte-for-byte.
 */

import { outToSrc } from "./camera.js";
import type { EditPlan } from "../plan/edit-plan.js";
import type { RecordingManifest } from "../recorder/events.js";

export interface PickedFrame {
  /** The actual frame index on disk (frames/frame_<NNNNNN>.png). */
  frame_index: number;
  /** Where in `frame_indices` it lived (useful for prefetch heuristics). */
  ordinal: number;
  /** The timestamp on disk — typically <= src_t_ms; equal at exact hits. */
  frame_t_ms: number;
}

/**
 * Find the frame to display at a given SOURCE-recording time. Strategy:
 * highest frame whose capture time is <= src_t_ms (don't show a frame
 * before it was captured). For src_t_ms before the first frame, returns
 * frame 0. For src_t_ms past the last frame, returns the last frame.
 *
 * O(log n) — binary search over the sorted frame_timestamps_ms.
 *
 * Returns null when the recording has no frames on disk (e.g. the synthetic
 * fixture). Callers should fall back to a placeholder.
 */
export function pickFrameAtSrcTime(
  manifest: Pick<RecordingManifest, "frame_indices" | "frame_timestamps_ms">,
  src_t_ms: number,
): PickedFrame | null {
  const { frame_indices, frame_timestamps_ms } = manifest;
  const n = frame_indices.length;
  if (n === 0 || frame_timestamps_ms.length !== n) return null;

  // Clamp to range. The first frame is the right answer for "before
  // recording started" because that's all we can show.
  if (src_t_ms <= frame_timestamps_ms[0]!) {
    return {
      frame_index: frame_indices[0]!,
      ordinal: 0,
      frame_t_ms: frame_timestamps_ms[0]!,
    };
  }
  if (src_t_ms >= frame_timestamps_ms[n - 1]!) {
    return {
      frame_index: frame_indices[n - 1]!,
      ordinal: n - 1,
      frame_t_ms: frame_timestamps_ms[n - 1]!,
    };
  }

  // Highest i with frame_timestamps_ms[i] <= src_t_ms.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (frame_timestamps_ms[mid]! <= src_t_ms) lo = mid;
    else hi = mid;
  }
  return {
    frame_index: frame_indices[lo]!,
    ordinal: lo,
    frame_t_ms: frame_timestamps_ms[lo]!,
  };
}

/** Convenience: same picker, but takes OUTPUT time via the edit-plan. */
export function pickFrameAtOutTime(
  manifest: Pick<RecordingManifest, "frame_indices" | "frame_timestamps_ms">,
  out_t_ms: number,
  segments: EditPlan["segments"],
  playback_rate: number,
): PickedFrame | null {
  const src_t = outToSrc(out_t_ms, segments, playback_rate);
  if (src_t == null) return null;
  return pickFrameAtSrcTime(manifest, src_t);
}

/**
 * Zero-padded file name for a frame index, matching the recorder's
 * write convention (frames/frame_000123.png for index 123). Centralizing
 * the padding here means both renderers + tests + any future packing
 * tool use the same naming.
 */
export function frameFileName(frame_index: number): string {
  return `frame_${String(frame_index).padStart(6, "0")}.png`;
}
