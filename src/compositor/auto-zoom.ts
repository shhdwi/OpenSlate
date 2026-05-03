/**
 * Auto-zoom resolver. Takes the event log + auto-zoom profile and produces a
 * sparse list of zoom envelopes (start_ms, peak_ms, end_ms, scale, focal point).
 * The composition consumes these to drive the zoom transform per-frame.
 *
 * principle 8 (exaggeration restraint): suppresses zooms within skip_if_within_ms
 * principle 7 (follow_through): cursor_recover_ms extends the envelope's tail
 * principle 4 (anticipation): in v1.5+, anticipation_drift adds a pre-roll
 */

import type { AutoZoomProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";

export interface ZoomEnvelope {
  /** zoom-in start (ms from recording start) */
  start_ms: number;
  /** when the peak scale is reached */
  peak_ms: number;
  /** when zoom-out completes */
  end_ms: number;
  /** when the cursor has fully re-synced */
  recover_end_ms: number;
  /** the peak scale (always profile.scale unless capped) */
  scale: number;
  /** focal point in viewport space */
  focal_x: number;
  focal_y: number;
  /** the source event index, for traceability */
  source_event_index: number;
}

export function resolveZoomEnvelopes(
  events: RecordedEvent[],
  profile: AutoZoomProfile,
): ZoomEnvelope[] {
  if (profile.trigger !== "click_event" && profile.trigger !== "manual") return [];

  const envelopes: ZoomEnvelope[] = [];

  for (const [i, ev] of events.entries()) {
    if (ev.kind !== "click") continue;
    if (ev.no_zoom) continue;

    // restraint: skip if last envelope's peak was within skip_if_within_ms
    const last = envelopes[envelopes.length - 1];
    if (last && ev.t_ms - last.peak_ms < profile.skip_if_within_ms) continue;

    const click_ms = ev.t_ms;
    const start_ms = Math.max(0, click_ms - profile.duration_in_ms / 2);
    const peak_ms = click_ms + 50; // peak just after the click registers
    const end_ms = peak_ms + profile.hold_after_ms + profile.duration_out_ms;
    const recover_end_ms = end_ms + profile.cursor_recover_ms;

    envelopes.push({
      start_ms,
      peak_ms,
      end_ms,
      recover_end_ms,
      scale: Math.min(profile.scale, profile.max_scale_per_video),
      focal_x: ev.x ?? 0,
      focal_y: ev.y ?? 0,
      source_event_index: i,
    });
  }

  return envelopes;
}

/**
 * For a given time t_ms, return the active zoom envelope (if any) and the
 * normalized progress through it. Composition uses this to apply a transform.
 */
export interface ZoomState {
  active: boolean;
  envelope: ZoomEnvelope | null;
  /** 0..1 progress through the in-phase */
  in_progress: number;
  /** 0..1 progress through the hold phase */
  hold_progress: number;
  /** 0..1 progress through the out-phase */
  out_progress: number;
  /** 0..1 progress through the cursor-recover phase */
  recover_progress: number;
  /** the current effective scale (1.0 outside envelope) */
  current_scale: number;
}

export function zoomStateAt(
  t_ms: number,
  envelopes: ZoomEnvelope[],
  profile: AutoZoomProfile,
): ZoomState {
  const env = envelopes.find((e) => t_ms >= e.start_ms && t_ms <= e.recover_end_ms);
  if (!env) {
    return {
      active: false,
      envelope: null,
      in_progress: 0,
      hold_progress: 0,
      out_progress: 0,
      recover_progress: 0,
      current_scale: 1.0,
    };
  }

  const out_start = env.peak_ms + profile.hold_after_ms;
  const in_progress = clamp01((t_ms - env.start_ms) / Math.max(1, env.peak_ms - env.start_ms));
  const hold_progress = clamp01((t_ms - env.peak_ms) / Math.max(1, out_start - env.peak_ms));
  const out_progress = clamp01((t_ms - out_start) / Math.max(1, env.end_ms - out_start));
  const recover_progress = clamp01(
    (t_ms - env.end_ms) / Math.max(1, env.recover_end_ms - env.end_ms),
  );

  // Effective scale per phase. We don't apply easing here; the composition
  // will apply ease_in / ease_out via interpolate(); we just give the raw
  // 0..1 progress and let Remotion's interpolate resolve.
  let scale = 1.0;
  if (t_ms < env.peak_ms) {
    scale = 1 + (env.scale - 1) * in_progress;
  } else if (t_ms < out_start) {
    scale = env.scale;
  } else if (t_ms < env.end_ms) {
    scale = env.scale - (env.scale - 1) * out_progress;
  } else {
    scale = 1.0;
  }

  return {
    active: true,
    envelope: env,
    in_progress,
    hold_progress,
    out_progress,
    recover_progress,
    current_scale: scale,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
