/**
 * Edit plan: the deterministic intermediate artifact between recording and
 * rendering. Built once by `buildEditPlan`, written to disk as
 * `<recording_dir>/edit-plan.json`, and consumed verbatim by the compositor.
 *
 * The contract: nothing about the camera is recomputed at render time.
 * Same `events.json` + same profile → byte-identical `edit-plan.json` →
 * pixel-identical output.
 *
 * Pipeline shape (Steel.dev pattern, openSlate quality):
 *
 *   record → events.json + cursor.json + manifest.json
 *          ↓
 *   plan   → edit-plan.json  ← this module
 *          ↓
 *   export → demo.mp4
 */

import type { EaseName } from "../core/principles.js";
import type { PolishProfile } from "../core/types.js";
import type { RecordedEvent, RecordingManifest } from "../recorder/events.js";

/** A contiguous window of source-recording time included in the output. */
export interface Segment {
  /** Source-recording time, ms (matches event.t_ms / cursor sample t_ms). */
  src_start_ms: number;
  src_end_ms: number;
}

/**
 * Camera state at one moment of the OUTPUT timeline. The compositor
 * interpolates between consecutive keyframes using `ease` (applied from
 * the previous keyframe to this one).
 */
export interface CameraKeyframe {
  /** Output time, ms (post-segment-trim, post-playback-rate). */
  out_t_ms: number;
  /** 1.0 = wide. peak typically 1.5–2.0. */
  zoom: number;
  /** Focal point as fraction of viewport (0..1). 0.5,0.5 = center. */
  focal_x: number;
  focal_y: number;
  /** Ease curve from the PREVIOUS keyframe to this one. */
  ease: EaseName;
}

export interface EditPlan {
  schema_version: 1;
  recording_id: string;
  /** Time multiplier (matches profile.playback.rate at build time). */
  playback_rate: number;
  /**
   * Output dimensions. Carried in the plan so the renderer doesn't need
   * to look at the export preset for camera math.
   */
  viewport: { width: number; height: number };
  /** Trimmed source windows, in order. Their durations sum to the
   *  pre-rate output duration; output_duration_ms = sum / playback_rate. */
  segments: Segment[];
  /** Camera state on the OUTPUT timeline. Always begins at out_t_ms=0
   *  and ends at out_t_ms=output_duration_ms. */
  keyframes: CameraKeyframe[];
}

// ─── Time mapping ────────────────────────────────────────────────────────────

/**
 * Map a source-recording time to its output time (post-trim, post-rate).
 * Returns null if the source time falls in a dropped (trimmed) gap.
 *
 * Used in two directions:
 *  - building keyframes (event.t_ms in source → keyframe out_t_ms)
 *  - render time (output frame → cursor sample / source frame to display)
 */
export function srcToOut(
  src_t_ms: number,
  segments: Segment[],
  rate: number,
): number | null {
  let acc_pre_dur = 0;
  for (const s of segments) {
    if (src_t_ms < s.src_start_ms) return null; // in a dropped gap
    if (src_t_ms <= s.src_end_ms) {
      return (acc_pre_dur + (src_t_ms - s.src_start_ms)) / rate;
    }
    acc_pre_dur += s.src_end_ms - s.src_start_ms;
  }
  return null; // past the last segment
}

/**
 * Inverse: given an output time, return the source time it maps to.
 * The compositor uses this to look up which source frame / cursor sample
 * to show at a given output frame.
 */
export function outToSrc(
  out_t_ms: number,
  segments: Segment[],
  rate: number,
): number | null {
  const src_offset_in_segments = out_t_ms * rate;
  let acc = 0;
  for (const s of segments) {
    const dur = s.src_end_ms - s.src_start_ms;
    if (src_offset_in_segments <= acc + dur) {
      return s.src_start_ms + (src_offset_in_segments - acc);
    }
    acc += dur;
  }
  return null;
}

/** Total output duration after trim + rate. */
export function outputDurationMs(segments: Segment[], rate: number): number {
  let total = 0;
  for (const s of segments) total += s.src_end_ms - s.src_start_ms;
  return total / rate;
}

// ─── Segment computation (Steel.dev rules, openSlate-tuned) ─────────────────

/** Events that drive a segment around them ("salient" — visible on output). */
const SALIENT_KINDS = new Set(["click", "type", "scroll", "hover"]);

/**
 * Compute segments from events using the lead/trail/merge/split rules:
 *   - Around each salient event, create [event_t - lead, event_t + trail]
 *   - Sort by start, merge any pair with gap < merge_below_ms
 *   - Drop any gap >= split_above_ms (already done by construction)
 *   - Always include 1s after the final action (handled by trail)
 *   - Clamp to [0, recording_duration]
 *
 * Synthetic clicks are treated like real clicks for segment purposes —
 * they ARE the meaningful interaction (the recorder dwells on them on
 * purpose so the click animation can play). The pre-click dwell IS the
 * trail, not separate.
 *
 * Exported for unit testing.
 */
export function computeSegments(
  events: RecordedEvent[],
  recording_duration_ms: number,
  profile: PolishProfile,
): Segment[] {
  const lead = profile.playback.segment_lead_ms;
  const trail = profile.playback.segment_trail_ms;
  const mergeBelow = profile.playback.segment_merge_below_ms;

  const salient = events.filter(
    (e) => SALIENT_KINDS.has(e.kind) && typeof e.step_index === "number",
  );

  if (salient.length === 0) {
    // No salient events → include the whole recording (rare; e.g. plan
    // had only navigates). The user will likely tune this case manually.
    return [{ src_start_ms: 0, src_end_ms: recording_duration_ms }];
  }

  // Initial windows.
  let segments: Segment[] = salient.map((e) => ({
    src_start_ms: Math.max(0, e.t_ms - lead),
    src_end_ms: Math.min(recording_duration_ms, e.t_ms + trail),
  }));
  segments.sort((a, b) => a.src_start_ms - b.src_start_ms);

  // Merge close segments.
  const merged: Segment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && s.src_start_ms - last.src_end_ms < mergeBelow) {
      last.src_end_ms = Math.max(last.src_end_ms, s.src_end_ms);
    } else {
      merged.push({ ...s });
    }
  }
  segments = merged;

  return segments;
}

// ─── Keyframe generation (action-type templates) ────────────────────────────

/**
 * For each salient event with a non-1.0 template, emit the per-action
 * keyframe quad on the OUTPUT timeline:
 *
 *   pre_in   (out_t = action_out - duration_in)        zoom = 1.0
 *   peak_in  (out_t = action_out)                      zoom = peak
 *   peak_out (out_t = action_out + hold_ms)            zoom = peak
 *   post_out (out_t = action_out + hold_ms + dur_out)  zoom = 1.0
 *
 * Connected-pan post-pass collapses adjacent peak_out → peak_in pairs
 * that are close in OUTPUT time, replacing them with a single PAN at
 * peak between focal_a and focal_b.
 *
 * Exported for unit testing.
 */
export function computeKeyframes(
  events: RecordedEvent[],
  segments: Segment[],
  profile: PolishProfile,
  viewport: { width: number; height: number },
): CameraKeyframe[] {
  const rate = profile.playback.rate;
  const keyframes: CameraKeyframe[] = [];
  // Always anchor a wide-view keyframe at output t=0.
  keyframes.push({
    out_t_ms: 0,
    zoom: 1.0,
    focal_x: 0.5,
    focal_y: 0.5,
    ease: "linear",
  });

  for (const ev of events) {
    if (!SALIENT_KINDS.has(ev.kind) || typeof ev.step_index !== "number") continue;
    if (ev.no_zoom) continue;
    const tpl = profile.zoom.templates[ev.kind as keyof typeof profile.zoom.templates];
    if (!tpl || tpl.peak <= 1.0) continue; // wide-view kinds skip

    const out_t = srcToOut(ev.t_ms, segments, rate);
    if (out_t == null) continue; // event was trimmed out

    const peak = Math.min(tpl.peak, profile.zoom.max_peak);
    const fx =
      profile.zoom.pan_to_target && typeof ev.x === "number"
        ? ev.x / viewport.width
        : 0.5;
    const fy =
      profile.zoom.pan_to_target && typeof ev.y === "number"
        ? ev.y / viewport.height
        : 0.5;
    const focal = clampFocalForCoverage(fx, fy, peak);

    const dur_in_out = tpl.duration_in_ms / rate;
    const hold_out = tpl.hold_ms / rate;
    const dur_out_out = tpl.duration_out_ms / rate;

    keyframes.push({
      out_t_ms: Math.max(0, out_t - dur_in_out),
      zoom: 1.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease: "linear",
    });
    keyframes.push({
      out_t_ms: out_t,
      zoom: peak,
      focal_x: focal.x,
      focal_y: focal.y,
      ease: tpl.ease_in,
    });
    keyframes.push({
      out_t_ms: out_t + hold_out,
      zoom: peak,
      focal_x: focal.x,
      focal_y: focal.y,
      ease: "linear",
    });
    keyframes.push({
      out_t_ms: out_t + hold_out + dur_out_out,
      zoom: 1.0,
      focal_x: 0.5,
      focal_y: 0.5,
      ease: tpl.ease_out,
    });
  }

  // Final keyframe: anchor wide at output_end so the very last frame
  // always has a defined camera state.
  const output_end = outputDurationMs(segments, rate);
  keyframes.push({
    out_t_ms: output_end,
    zoom: 1.0,
    focal_x: 0.5,
    focal_y: 0.5,
    ease: "linear",
  });

  // Sort + de-dup exact-time collisions (last write wins).
  keyframes.sort((a, b) => a.out_t_ms - b.out_t_ms);
  const dedup: CameraKeyframe[] = [];
  for (const k of keyframes) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.out_t_ms - k.out_t_ms) < 0.01) {
      dedup[dedup.length - 1] = k;
    } else {
      dedup.push(k);
    }
  }
  return dedup;
}

/**
 * Connected-pan post-pass: when two consecutive zoom envelopes (peak_out
 * dropping to 1.0 then peak_in going back up) are within
 * `connected_gap_ms` on the OUTPUT timeline, replace the dip with a
 * sustained zoom that pans focal_a → focal_b. This is openSlate's
 * Recordly-pattern smoothness preserved against the new keyframe model.
 *
 * Exported for unit testing.
 */
export function applyConnectedPan(
  keyframes: CameraKeyframe[],
  profile: PolishProfile,
): CameraKeyframe[] {
  const gap = profile.zoom.connected_gap_ms / profile.playback.rate;
  const out: CameraKeyframe[] = [];
  let i = 0;
  while (i < keyframes.length) {
    const k = keyframes[i]!;
    out.push(k);
    // Look ahead for: this is peak_out (zoom>1, next is post zoom=1, then
    // pre zoom=1, then peak_in zoom>1). If the post→pre gap is within `gap`
    // and the two zooms are equal, drop the post + pre and insert a hold.
    const nA = keyframes[i + 1]; // post (zoom=1)
    const nB = keyframes[i + 2]; // pre  (zoom=1)
    const nC = keyframes[i + 3]; // peak_in
    if (
      nA &&
      nB &&
      nC &&
      k.zoom > 1.0 &&
      nA.zoom === 1.0 &&
      nB.zoom === 1.0 &&
      nC.zoom > 1.0 &&
      Math.abs(k.zoom - nC.zoom) < 0.001 &&
      nB.out_t_ms - nA.out_t_ms <= gap
    ) {
      // Replace nA + nB with a single PAN keyframe at nA's time, holding
      // peak zoom; we'll also overwrite k.ease for nC to be a "pan" ease.
      out.push({
        out_t_ms: nA.out_t_ms,
        zoom: k.zoom,
        focal_x: k.focal_x,
        focal_y: k.focal_y,
        ease: "linear",
      });
      // Skip the dropped pair; nC stays in the iteration.
      i += 3;
      continue;
    }
    i++;
  }
  return out;
}

// ─── Focal clamp (preserves coverage at peak zoom) ──────────────────────────

/**
 * The focal-clamp pattern from compositor/auto-zoom.ts, preserved here
 * for the planner. With transform-origin top-left, the achievable focal
 * window for a given peak scale `s` is [1/(2s), 1 - 1/(2s)]. Clamping
 * the focal into this window keeps the recording covering the frame
 * (no black bars) at peak zoom.
 */
export function clampFocalForCoverage(
  fx: number,
  fy: number,
  peak: number,
): { x: number; y: number } {
  if (peak <= 1.0) return { x: 0.5, y: 0.5 };
  const margin = 1 / (2 * peak);
  return {
    x: Math.min(Math.max(fx, margin), 1 - margin),
    y: Math.min(Math.max(fy, margin), 1 - margin),
  };
}

// ─── Top-level builder ──────────────────────────────────────────────────────

export function buildEditPlan(opts: {
  recording_id: string;
  manifest: RecordingManifest;
  events: RecordedEvent[];
  profile: PolishProfile;
}): EditPlan {
  const { recording_id, manifest, events, profile } = opts;
  const segments = computeSegments(events, manifest.duration_ms, profile);
  const rawKeyframes = computeKeyframes(events, segments, profile, manifest.viewport);
  const keyframes = applyConnectedPan(rawKeyframes, profile);
  return {
    schema_version: 1,
    recording_id,
    playback_rate: profile.playback.rate,
    viewport: manifest.viewport,
    segments,
    keyframes,
  };
}

/**
 * Pretty-print a one-screen summary of the plan for the user to confirm
 * before render. Used by the CLI `plan` step and the MCP tool.
 */
export function summarizeEditPlan(plan: EditPlan): string {
  const out_dur = outputDurationMs(plan.segments, plan.playback_rate);
  const lines: string[] = [];
  lines.push(`Edit plan for ${plan.recording_id}`);
  lines.push(`  output: ${(out_dur / 1000).toFixed(2)}s @ ${plan.playback_rate}× rate`);
  lines.push(`  segments (${plan.segments.length}):`);
  for (const s of plan.segments) {
    lines.push(
      `    ${(s.src_start_ms / 1000).toFixed(2)}s → ${(s.src_end_ms / 1000).toFixed(2)}s (${((s.src_end_ms - s.src_start_ms) / 1000).toFixed(2)}s)`,
    );
  }
  lines.push(`  keyframes (${plan.keyframes.length}):`);
  for (const k of plan.keyframes) {
    lines.push(
      `    @ ${(k.out_t_ms / 1000).toFixed(2)}s  zoom=${k.zoom.toFixed(2)}  focal=(${k.focal_x.toFixed(2)},${k.focal_y.toFixed(2)})  ease=${k.ease}`,
    );
  }
  return lines.join("\n");
}
