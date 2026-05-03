/**
 * Auto-zoom resolver. Takes the event log + auto-zoom profile and produces a
 * sparse list of zoom envelopes (start_ms, peak_ms, end_ms, scale, focal point).
 * The composition consumes these to drive the zoom transform per-frame.
 *
 * v1.1 design (taste cues from Recordly's videoPlayback/zoomRegionUtils):
 *   - Focal coords are NORMALIZED (0..1) within viewport, not pixels. Cleaner
 *     to reason about, frame-size-independent.
 *   - Focal is CLAMPED via getFocusBoundsForScale() so the recording always
 *     covers the frame at any zoom level (no exposed black edges).
 *   - "Connected pan": when two zooms are close in time (< CHAINED_GAP_MS),
 *     they merge into one sustained zoom with the focal interpolating between
 *     the click points instead of zooming-out then zooming-in.
 *   - Asymmetric durations: zoom-in slower than zoom-out (calibrated taste).
 *
 * principle 8 (exaggeration restraint): suppresses zooms within skip_if_within_ms
 * principle 7 (follow_through): cursor_recover_ms extends the envelope's tail
 * principle 4 (anticipation): connected pan honors the user's intent to stay
 *   "in" the zoomed view across consecutive related actions.
 */

import type { AutoZoomProfile } from "../core/types.js";
import type { RecordedEvent } from "../recorder/events.js";

/**
 * Time threshold for connecting consecutive zooms. If gap from envelope A's
 * end_ms to envelope B's start_ms is below this, the two are "connected" and
 * we run a sustained zoom with focal+scale lerp instead of zoom-out+zoom-in.
 *
 * Recordly uses 1350ms; we adopt the same.
 */
const CHAINED_GAP_MS = 1350;

/**
 * Duration of the sub-click → sub-click pan inside a connected zoom. After
 * this many ms have passed since the previous sub-click's peak, the focal
 * has finished moving to the next sub-click's location.
 */
const CONNECTED_PAN_MS = 800;

export interface SubClick {
  /** time in ms (recording timeline) when this sub-click registered */
  t_ms: number;
  /** normalized focal in [0, 1] within viewport */
  focal_x: number;
  focal_y: number;
  /** source event index, for traceability */
  source_event_index: number;
}

export interface ZoomEnvelope {
  /** zoom-in start (ms from recording start) */
  start_ms: number;
  /** when the peak scale of the FIRST sub-click is reached */
  peak_ms: number;
  /** when zoom-out begins (after LAST sub-click's hold) */
  end_ms: number;
  /** when the cursor has fully re-synced */
  recover_end_ms: number;
  /** the peak scale */
  scale: number;
  /** all clicks in this envelope. length 1 = pure; 2+ = connected pan */
  sub_clicks: SubClick[];
  /** source event index of the FIRST sub-click, for traceability */
  source_event_index: number;
}

/**
 * For a given zoom scale, the focal point must lie within these bounds in
 * normalized [0, 1] coords — otherwise the zoomed view extends past the
 * recording edge, exposing the underlying frame background.
 *
 * Math: at scale s, the visible rectangle after zoom is 1/s of the original.
 * The focal can range from 1/(2s) (so the left edge of the visible window
 * lines up with the recording's left edge) to 1 - 1/(2s) (right edge lines
 * up). This is the focusUtils.getFocusBoundsForScale formula from Recordly,
 * implemented here independently.
 */
export function getFocusBoundsForScale(scale: number): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  if (scale <= 1) return { minX: 0.5, maxX: 0.5, minY: 0.5, maxY: 0.5 };
  const margin = 1 / (2 * scale);
  return { minX: margin, maxX: 1 - margin, minY: margin, maxY: 1 - margin };
}

/** Clamp a normalized focal point to the bounds achievable at the given scale. */
export function clampFocusToScale(
  fx: number,
  fy: number,
  scale: number,
): { fx: number; fy: number } {
  const b = getFocusBoundsForScale(scale);
  return {
    fx: Math.max(b.minX, Math.min(b.maxX, fx)),
    fy: Math.max(b.minY, Math.min(b.maxY, fy)),
  };
}

export interface ResolveZoomOptions {
  viewport_width: number;
  viewport_height: number;
}

export function resolveZoomEnvelopes(
  events: RecordedEvent[],
  profile: AutoZoomProfile,
  opts: ResolveZoomOptions = { viewport_width: 1280, viewport_height: 800 },
): ZoomEnvelope[] {
  if (profile.trigger !== "click_event" && profile.trigger !== "manual") return [];

  const scale = Math.min(profile.scale, profile.max_scale_per_video);
  const envelopes: ZoomEnvelope[] = [];

  for (const [i, ev] of events.entries()) {
    if (ev.kind !== "click") continue;
    if (ev.no_zoom) continue;

    // Convert viewport pixels → normalized [0,1].
    const fx_raw = (ev.x ?? opts.viewport_width / 2) / opts.viewport_width;
    const fy_raw = (ev.y ?? opts.viewport_height / 2) / opts.viewport_height;
    const { fx, fy } = clampFocusToScale(fx_raw, fy_raw, scale);

    const click_ms = ev.t_ms;
    const last = envelopes[envelopes.length - 1];

    // restraint: skip if last envelope's peak was within skip_if_within_ms
    if (last && click_ms - last.peak_ms < profile.skip_if_within_ms) continue;

    // CONNECTED PAN — if the previous envelope ended recently enough, we extend
    // it with another sub-click instead of starting a new envelope. The
    // recording stays zoomed during the bridge; focal pans smoothly.
    if (last && click_ms - last.end_ms < CHAINED_GAP_MS) {
      last.sub_clicks.push({
        t_ms: click_ms,
        focal_x: fx,
        focal_y: fy,
        source_event_index: i,
      });
      // Extend the envelope to cover the new sub-click's hold.
      const new_end = click_ms + profile.hold_after_ms + profile.duration_out_ms;
      last.end_ms = Math.max(last.end_ms, new_end);
      last.recover_end_ms = last.end_ms + profile.cursor_recover_ms;
      continue;
    }

    // Otherwise start a new envelope.
    const start_ms = Math.max(0, click_ms - profile.duration_in_ms);
    const peak_ms = click_ms;
    const end_ms = peak_ms + profile.hold_after_ms + profile.duration_out_ms;
    const recover_end_ms = end_ms + profile.cursor_recover_ms;

    envelopes.push({
      start_ms,
      peak_ms,
      end_ms,
      recover_end_ms,
      scale,
      sub_clicks: [
        {
          t_ms: click_ms,
          focal_x: fx,
          focal_y: fy,
          source_event_index: i,
        },
      ],
      source_event_index: i,
    });
  }

  return envelopes;
}

/**
 * The state at a given time inside (or outside) any zoom envelope. Composition
 * uses focal_x/focal_y (already clamped) directly to compute the transform.
 */
export interface ZoomState {
  active: boolean;
  envelope: ZoomEnvelope | null;
  /** 0..1 progress through the in-phase (only valid during zoom-in) */
  in_progress: number;
  /** 0..1 progress through the hold phase */
  hold_progress: number;
  /** 0..1 progress through the out-phase */
  out_progress: number;
  /** 0..1 progress through the cursor-recover phase */
  recover_progress: number;
  /** Current normalized focal in [0, 1]. Already clamped. */
  focal_x: number;
  focal_y: number;
  /** Current effective scale (1.0 outside envelope). */
  current_scale: number;
}

const NEUTRAL_STATE: ZoomState = {
  active: false,
  envelope: null,
  in_progress: 0,
  hold_progress: 0,
  out_progress: 0,
  recover_progress: 0,
  focal_x: 0.5,
  focal_y: 0.5,
  current_scale: 1.0,
};

export function zoomStateAt(
  t_ms: number,
  envelopes: ZoomEnvelope[],
  profile: AutoZoomProfile,
): ZoomState {
  const env = envelopes.find((e) => t_ms >= e.start_ms && t_ms <= e.recover_end_ms);
  if (!env) return NEUTRAL_STATE;

  // Find the active sub-click (or interpolation between two sub-clicks).
  const { focal_x, focal_y } = focalAt(env, t_ms);

  const last_sub = env.sub_clicks[env.sub_clicks.length - 1];
  const out_start = (last_sub?.t_ms ?? env.peak_ms) + profile.hold_after_ms;

  const in_progress = clamp01((t_ms - env.start_ms) / Math.max(1, env.peak_ms - env.start_ms));
  const hold_progress = clamp01(
    (t_ms - env.peak_ms) / Math.max(1, out_start - env.peak_ms),
  );
  const out_progress = clamp01((t_ms - out_start) / Math.max(1, env.end_ms - out_start));
  const recover_progress = clamp01(
    (t_ms - env.end_ms) / Math.max(1, env.recover_end_ms - env.end_ms),
  );

  let current_scale = 1.0;
  if (t_ms < env.peak_ms) {
    current_scale = 1 + (env.scale - 1) * in_progress;
  } else if (t_ms < out_start) {
    current_scale = env.scale;
  } else if (t_ms < env.end_ms) {
    current_scale = env.scale - (env.scale - 1) * out_progress;
  } else {
    current_scale = 1.0;
  }

  return {
    active: true,
    envelope: env,
    in_progress,
    hold_progress,
    out_progress,
    recover_progress,
    focal_x,
    focal_y,
    current_scale,
  };
}

/**
 * Focal at time t inside an envelope. Single-click envelopes return the
 * single focal. Connected envelopes interpolate between consecutive
 * sub-clicks with cubicBezier(0.1, 0, 0.2, 1) ease (Recordly's pan curve).
 */
function focalAt(
  env: ZoomEnvelope,
  t_ms: number,
): { focal_x: number; focal_y: number } {
  const subs = env.sub_clicks;
  if (subs.length === 0) return { focal_x: 0.5, focal_y: 0.5 };
  if (subs.length === 1) {
    const s = subs[0]!;
    return { focal_x: s.focal_x, focal_y: s.focal_y };
  }

  // Find the bracketing sub-clicks.
  if (t_ms <= subs[0]!.t_ms) {
    const s = subs[0]!;
    return { focal_x: s.focal_x, focal_y: s.focal_y };
  }
  for (let i = 0; i < subs.length - 1; i++) {
    const a = subs[i]!;
    const b = subs[i + 1]!;
    if (t_ms >= a.t_ms && t_ms <= b.t_ms) {
      // Pan starts at A.t_ms, ends at min(B.t_ms, A.t_ms + CONNECTED_PAN_MS).
      const pan_end = Math.min(b.t_ms, a.t_ms + CONNECTED_PAN_MS);
      const raw_t = clamp01((t_ms - a.t_ms) / Math.max(1, pan_end - a.t_ms));
      const eased = cubicBezier01(0.1, 0, 0.2, 1, raw_t);
      return {
        focal_x: a.focal_x + (b.focal_x - a.focal_x) * eased,
        focal_y: a.focal_y + (b.focal_y - a.focal_y) * eased,
      };
    }
  }
  const last = subs[subs.length - 1]!;
  return { focal_x: last.focal_x, focal_y: last.focal_y };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Cubic Bezier on [0,1]². Same Newton-Raphson approach as utils/easings.ts but
 * inlined here to avoid a circular import. Used for the connected-pan ease.
 */
function cubicBezier01(p1x: number, p1y: number, p2x: number, p2y: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
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
  t = Math.max(0, Math.min(1, t));
  return ((ay * t + by) * t + cy) * t;
}
