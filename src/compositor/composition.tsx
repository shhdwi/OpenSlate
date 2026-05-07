/**
 * The Remotion composition. Reads:
 *   - manifest.json   — source recording metadata (frames, viewport, timestamps)
 *   - events.json     — for click bounce + halo at the right output time
 *   - cursor.json     — for spring-smoothed cursor trajectory
 *   - edit-plan.json  — segments + camera keyframes (NEW)
 *
 * The edit plan is the single source of truth for camera state. The renderer
 * does NOT recompute zoom envelopes from events; it interpolates between the
 * keyframes already placed on the OUTPUT timeline.
 *
 * Layer stack (bottom → top):
 *   1. Background (gradient/wallpaper/solid + grain)
 *   2. Frame chrome (laptop/phone/browser/window)
 *   3. Recording playback (frame sequence, transformed by camera keyframes)
 *   4. Cursor overlay (resolved from cursor.json via spring, output-time aligned)
 *   5. Click bounce / motion blur effects on cursor
 *   6. Captions (lower_third, optional)
 *   7. Flourishes (logo outro, click highlight, etc.)
 */

import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import type { PolishProfile } from "../core/types.js";
import type { CursorSample, RecordedEvent, RecordingManifest } from "../recorder/events.js";
import { applyEase } from "../utils/easings.js";
import { injectArcWaypoints, resolveSpringTrajectory } from "../utils/springs.js";
import { type EditPlan, outToSrc, srcToOut } from "../plan/edit-plan.js";
import { Background } from "./background.js";
import { Captions } from "./captions.js";
import { Cursor } from "./cursor.js";
import { Frame } from "./frame.js";
import { Stage } from "./stage.js";
import { Flourishes } from "../flourishes/index.js";
import { ClickHighlight } from "../flourishes/click-highlight.js";
import {
  HighlightTreatment,
  isHighlightActive,
} from "../flourishes/highlight-treatment.js";

export interface CompositionProps {
  manifest: RecordingManifest;
  events: RecordedEvent[];
  cursor_samples: CursorSample[];
  /** absolute file:// URL prefix for the frames dir (Remotion can't read fs) */
  frames_url_prefix: string;
  profile: PolishProfile;
  /** Camera plan + segment trim, produced by buildEditPlan (src/plan/edit-plan.ts) */
  edit_plan: EditPlan;
  /**
   * Render the framed (and possibly tilted) screen on TRANSPARENT —
   * skip the gradient/wallpaper bg layer entirely. Set by the renderer
   * from `ExportPreset.transparent_bg`. The render pipeline pairs this
   * with an alpha-capable codec (VP9/yuva420p for webm, ProRes 4444 for
   * mov) so the output carries actual alpha, ready to composite.
   */
  transparent_bg?: boolean;
}

export const PolishComposition: React.FC<CompositionProps> = ({
  manifest,
  events,
  cursor_samples,
  frames_url_prefix,
  profile,
  edit_plan,
  transparent_bg,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const out_t_ms = (frame / fps) * 1000;

  const segments = edit_plan.segments;
  const rate = edit_plan.playback_rate;
  const viewport_w = manifest.viewport.width;
  const viewport_h = manifest.viewport.height;

  // ── Cursor + events: align to OUTPUT timeline via segments ──────────────
  // Each cursor sample / event has a source t_ms. We map it through the
  // segments + rate to get its output t_ms; samples in dropped gaps get
  // dropped here. Spring physics then runs on the output-time sequence so
  // the smoothing cadence matches the rendered fps.
  const visibleCursorSamples = React.useMemo(
    () =>
      cursor_samples
        .map((s) => {
          const out = srcToOut(s.t_ms, segments, rate);
          return out == null ? null : { ...s, t_ms: out };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null),
    [cursor_samples, segments, rate],
  );

  const visibleEvents = React.useMemo(
    () =>
      events
        .map((e) => {
          const out = srcToOut(e.t_ms, segments, rate);
          return out == null ? null : { ...e, t_ms: out };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null),
    [events, segments, rate],
  );

  const cursorTrajectory = React.useMemo(() => {
    const raw = visibleCursorSamples.map((s) => ({ t_ms: s.t_ms, x: s.x, y: s.y }));
    // principle 5 (arcs): inject upward bezier midpoints on long traversals.
    const arced = injectArcWaypoints(raw, profile.cursor.path_arc_amount ?? 0);
    return resolveSpringTrajectory(arced, profile.cursor.smoothing, fps);
  }, [visibleCursorSamples, profile.cursor.smoothing, profile.cursor.path_arc_amount, fps]);

  // Cursor kind: hard-swap based on most-recent sample at or before now.
  const currentCursorKind = React.useMemo(() => {
    if (!profile.cursor.contextual_swap) return "arrow" as const;
    let kind: CursorSample["kind"] = "arrow";
    for (const s of visibleCursorSamples) {
      if (s.t_ms > out_t_ms) break;
      if (s.kind) kind = s.kind;
    }
    return kind ?? "arrow";
  }, [visibleCursorSamples, out_t_ms, profile.cursor.contextual_swap]);

  // ── Camera state: interpolate keyframes at out_t_ms ─────────────────────
  const camera = sampleCamera(edit_plan.keyframes, out_t_ms);

  // Use Recordly's progress-blended camera formulation with transform-origin
  // top-left. The keyframes already encode (zoom, focal); we only need to
  // map them into the (translate, scale) transform.
  // The focal-clamp upstream (clampFocalForCoverage in edit-plan.ts) ensures
  // the recording stays covering the frame at the keyframe's zoom; we
  // re-clamp here at the interpolated zoom in case interpolation moved
  // through a tighter bound.
  const peakScale = camera.zoom;
  const margin = peakScale > 1 ? 1 / (2 * peakScale) : 0;
  const focalPctX = clamp(camera.focal_x, margin, 1 - margin);
  const focalPctY = clamp(camera.focal_y, margin, 1 - margin);

  // For an active zoom (>1.0), translate is (0.5 − fx*scale)*100; scale=1
  // implies zero translate so the wide-view formula is identity.
  const translatePctX = profile.zoom.pan_to_target
    ? (0.5 - focalPctX * peakScale) * 100
    : 0;
  const translatePctY = profile.zoom.pan_to_target
    ? (0.5 - focalPctY * peakScale) * 100
    : 0;

  // principle 9 (secondary animation): bg drifts opposite to zoom motion.
  const bgParallaxX =
    peakScale > 1
      ? -(focalPctX - 0.5) * viewport_w * profile.background.parallax_factor * (peakScale - 1)
      : 0;
  const bgParallaxY =
    peakScale > 1
      ? -(focalPctY - 0.5) * viewport_h * profile.background.parallax_factor * (peakScale - 1)
      : 0;

  // ── Source frame mapping: out_t_ms → src_t_ms → frame index ─────────────
  const allIndices = manifest.frame_indices?.length
    ? manifest.frame_indices
    : Array.from({ length: manifest.frame_count }, (_, i) => i);
  const allTimestamps =
    manifest.frame_timestamps_ms?.length === allIndices.length
      ? manifest.frame_timestamps_ms
      : allIndices.map((_, i) =>
          (i / Math.max(1, allIndices.length - 1)) * manifest.duration_ms,
        );

  // out_t_ms → src_t_ms via segments+rate. If past the end, hold the last
  // frame (Remotion will just stop rendering once durationInFrames is hit).
  const total_out_ms = (() => {
    let acc = 0;
    for (const s of segments) acc += s.src_end_ms - s.src_start_ms;
    return acc / rate;
  })();
  const clamped_out = Math.min(out_t_ms, total_out_ms);
  const src_t_ms = outToSrc(clamped_out, segments, rate) ?? 0;

  // Binary search for the latest frame with timestamp ≤ src_t_ms.
  let lo = 0;
  let hi = allTimestamps.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((allTimestamps[mid] ?? 0) <= src_t_ms) lo = mid;
    else hi = mid - 1;
  }
  const sourceFrameIndex = allIndices[lo] ?? 0;
  const relPath = `${frames_url_prefix}/frame_${String(sourceFrameIndex).padStart(6, "0")}.png`;
  const sourceFrameUrl =
    frames_url_prefix.startsWith("http") || frames_url_prefix.startsWith("file:")
      ? relPath
      : staticFile(relPath);

  // Cursor position for this output frame (spring-smoothed in output time).
  // BUT: when a click is active, override with the click event's exact x/y.
  // The spring has lag — for fast cursor moves into a click target, the
  // spring may be 20-40px short at the click moment. The click event is
  // authoritative for "where the click happened", so we snap during the
  // click window so the cursor visually lands ON the click target while
  // the bounce + halo flourishes are firing. Outside the window the
  // spring drives smoothly as before.
  const frameIndex = Math.min(cursorTrajectory.length - 1, frame);
  const springCur = cursorTrajectory[frameIndex] ?? {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed_px_per_s: 0,
  };
  // Find the most recent click whose snap window includes this frame.
  // SNAP_LEAD_MS: how far before the click t to start blending in (so the
  // cursor settles onto the target exactly as the click fires).
  // SNAP_TAIL_MS: how long after the click to keep snapping (covers the
  // bounce + halo so they always anchor pixel-perfect).
  const SNAP_LEAD_MS = 200;
  const SNAP_TAIL_MS = 1100; // = CLICK_FX_DELAY_MS (250) + bounce (260) + halo (700) - cushion
  let cur: typeof springCur = springCur;
  for (let i = visibleEvents.length - 1; i >= 0; i--) {
    const ev = visibleEvents[i]!;
    if (ev.kind !== "click") continue;
    if (typeof ev.x !== "number" || typeof ev.y !== "number") continue;
    const dt = out_t_ms - ev.t_ms;
    if (dt < -SNAP_LEAD_MS || dt > SNAP_TAIL_MS) continue;
    // Blend between spring and exact click point. During lead window blend
    // FROM spring TO click; during tail window stay snapped, then ease back.
    let snapWeight: number;
    if (dt < 0) {
      // Lead-in: 0 at -SNAP_LEAD_MS, 1 at 0
      snapWeight = (dt + SNAP_LEAD_MS) / SNAP_LEAD_MS;
    } else if (dt < SNAP_TAIL_MS - SNAP_LEAD_MS) {
      // Hold: fully snapped
      snapWeight = 1;
    } else {
      // Tail-out: 1 at (SNAP_TAIL_MS - SNAP_LEAD_MS), 0 at SNAP_TAIL_MS
      snapWeight = 1 - (dt - (SNAP_TAIL_MS - SNAP_LEAD_MS)) / SNAP_LEAD_MS;
    }
    snapWeight = Math.max(0, Math.min(1, snapWeight));
    cur = {
      x: springCur.x + (ev.x - springCur.x) * snapWeight,
      y: springCur.y + (ev.y - springCur.y) * snapWeight,
      vx: springCur.vx * (1 - snapWeight),
      vy: springCur.vy * (1 - snapWeight),
      speed_px_per_s: springCur.speed_px_per_s * (1 - snapWeight),
    };
    break;
  }

  const sceneTransform = `translate(${translatePctX}%, ${translatePctY}%) scale(${peakScale})`;

  void width;
  void height;

  // 3D tilt: when any axis is non-zero, wrap the Frame in a perspective
  // container + rotation. Identity (all zeros) skips the wrapper entirely
  // so the default flat path has no extra DOM and no perspective overhead.
  const tilt = profile.layout.tilt;
  const tiltActive =
    tilt.rotate_x_deg !== 0 ||
    tilt.rotate_y_deg !== 0 ||
    tilt.rotate_z_deg !== 0;

  // Auto-fit: when tilted, perspective foreshortening pushes the near
  // edge of the screen TOWARD the viewer, which projects to a LARGER
  // visible size. Without compensation the near edge extends past the
  // canvas border and crops — the user sees the browser tab cut off on
  // one side. We pre-multiply by a uniform scale so the projected
  // bounding box always fits inside the canvas with a small safety
  // margin. The scale is derived from the actual angles + perspective:
  //
  //   for each axis, the near edge moves toward the viewer by
  //   d ≈ (canvas_dim/2) * sin(angle), and the projected size grows by
  //   P/(P-d). We invert the worst-case growth and add 5% breathing
  //   room. This is a deliberate over-correction — the Frame's drop
  //   shadow also extends past its bounds in 3D space, so a 5% margin
  //   keeps the shadow visible too.
  const tiltFitScale = tiltActive
    ? computeTiltFitScale(tilt, height || 1080)
    : 1;
  const tiltWrapStyle: React.CSSProperties = tiltActive
    ? {
        position: "absolute",
        inset: 0,
        perspective: `${tilt.perspective_px}px`,
        // Perspective-origin = where the camera (vanishing point) sits
        // in screen space. Default 50% 50% (center) makes rotations
        // look like they're viewed straight-on. The `flat` preset moves
        // this UP (e.g. 15%) so the camera is "above" the canvas
        // looking down — that's what makes a strong rotateX read as
        // "lying flat on a table" rather than "edge-on view of a door."
        perspectiveOrigin: `50% ${tilt.perspective_origin_y_pct ?? 50}%`,
      }
    : { position: "absolute", inset: 0 };
  // Ground shadow — `filter: drop-shadow` is computed in SCREEN SPACE
  // after projection (unlike box-shadow which lives in element space and
  // tilts WITH the element). For strong tilts this is what sells the
  // "screen sitting on a surface" feel — the shadow lands on the
  // imaginary floor beneath the rotated screen, not stuck to the back
  // of it. Magnitude scales with the strength of the tilt; barely-tilted
  // screens get a barely-visible extra shadow.
  const tiltMagnitude = Math.max(
    Math.abs(tilt.rotate_x_deg),
    Math.abs(tilt.rotate_y_deg),
  );
  const groundShadowBlur = Math.round(40 + tiltMagnitude * 1.2);
  const groundShadowY = Math.round(20 + tiltMagnitude * 0.8);
  const groundShadowAlpha = Math.min(0.55, 0.25 + tiltMagnitude * 0.005);
  const tiltInnerStyle: React.CSSProperties = tiltActive
    ? {
        position: "absolute",
        inset: 0,
        // Transform stack (read right-to-left, applied to element-space):
        //   1. rotateZ → rotateY → rotateX: 3D orientation
        //   2. scale: pre-rotate auto-fit so projection stays in canvas
        //   3. translateY: post-rotate screen-space offset, used by
        //      "lying on a table" presets to push the tilted screen
        //      into the lower portion of the canvas (leaves room above
        //      for the "viewer is standing in front of a table" feel)
        transform: `translate(0, ${tilt.translate_y_pct ?? 0}%) scale(${tiltFitScale}) rotateX(${tilt.rotate_x_deg}deg) rotateY(${tilt.rotate_y_deg}deg) rotateZ(${tilt.rotate_z_deg}deg)`,
        transformStyle: "preserve-3d",
        // Screen-space ground shadow. drop-shadow is applied AFTER the
        // 3D projection, so it stays on the imaginary "floor" — gives
        // the tilted screen a place to sit. Without this, even the most
        // physically correct rotation reads as "floating" rather than
        // "sitting on a surface."
        filter: `drop-shadow(0 ${groundShadowY}px ${groundShadowBlur}px rgba(0, 0, 0, ${groundShadowAlpha}))`,
        // willChange hints to the compositor; matters only at runtime, not
        // during Remotion's deterministic render. Cheap to leave on.
        willChange: "transform, filter",
      }
    : { position: "absolute", inset: 0 };

  return (
    <AbsoluteFill>
      {/* Skip the background layer when exporting transparent — the
          composition renders to alpha and the consumer composites their
          own background. The Frame's own drop-shadow still renders, so
          the output carries a tasteful shadow against the transparent
          backdrop (useful for stacking on a colored landing page). */}
      {!transparent_bg && (
        <Background
          profile={profile.background}
          brand={profile.brand}
          parallax_x={bgParallaxX}
          parallax_y={bgParallaxY}
        />
      )}

      <div style={tiltWrapStyle}>
        <div style={tiltInnerStyle}>
          <Frame profile={profile.frame} layout={profile.layout} brand={profile.brand}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Stage
            viewport_width={viewport_w}
            viewport_height={viewport_h}
            transform={sceneTransform}
          >
            <Img
              src={sourceFrameUrl}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "fill",
                display: "block",
              }}
            />
            {/* Hide the cursor during a highlight envelope — the
                spotlight + lifted bbox is the protagonist of the shot;
                the cursor would distract from it. */}
            {!isHighlightActive(visibleEvents, out_t_ms, profile.zoom) && (
              <Cursor
                x={cur.x}
                y={cur.y}
                vx={cur.vx ?? 0}
                vy={cur.vy ?? 0}
                viewport_width={viewport_w}
                viewport_height={viewport_h}
                speed_px_per_s={cur.speed_px_per_s ?? 0}
                events={visibleEvents}
                t_ms={out_t_ms}
                profile={profile.cursor}
                kind={currentCursorKind}
              />
            )}
            <ClickHighlight
              config={profile.flourishes.click_highlight}
              ctx={{
                brand: profile.brand,
                events: visibleEvents,
                t_ms: out_t_ms,
                total_duration_ms: total_out_ms,
              }}
              viewport_width={viewport_w}
              viewport_height={viewport_h}
            />
            {/* Highlight treatment (spotlight by default): dims regions
                outside the bbox + adds a subtle lift outline. Or pulsing
                border (border_glow) if configured. In-Stage so it
                tracks the camera transform. */}
            <HighlightTreatment
              events={visibleEvents}
              t_ms={out_t_ms}
              viewport_width={viewport_w}
              viewport_height={viewport_h}
              zoom={profile.zoom}
              brand={profile.brand}
              config={profile.flourishes.highlight_treatment}
              source_frame_url={sourceFrameUrl}
            />
          </Stage>
        </div>
      </Frame>
        </div>
      </div>

      {profile.captions.mode !== "off" && (
        <Captions profile={profile.captions} events={visibleEvents} t_ms={out_t_ms} />
      )}

      <Flourishes
        profile={profile.flourishes}
        brand={profile.brand}
        events={visibleEvents}
        t_ms={out_t_ms}
        total_duration_ms={total_out_ms}
      />

      {profile.outro.duration_ms > 0 && profile.outro.style !== "none" && (
        <Sequence
          from={Math.max(
            0,
            fps * (total_out_ms / 1000) - fps * (profile.outro.duration_ms / 1000),
          )}
          durationInFrames={Math.ceil(fps * (profile.outro.duration_ms / 1000))}
        >
          <OutroFade profile={profile} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

/**
 * Sample the camera state at output time `t_ms` by interpolating between
 * the two surrounding keyframes. Uses the destination keyframe's `ease`
 * for the curve from previous → current. Outside the keyframe range,
 * holds the boundary state.
 */
function sampleCamera(
  keyframes: EditPlan["keyframes"],
  t_ms: number,
): { zoom: number; focal_x: number; focal_y: number } {
  if (keyframes.length === 0) return { zoom: 1, focal_x: 0.5, focal_y: 0.5 };
  if (t_ms <= keyframes[0]!.out_t_ms) {
    const k = keyframes[0]!;
    return { zoom: k.zoom, focal_x: k.focal_x, focal_y: k.focal_y };
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

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Compute a uniform pre-rotate scale that ensures the rotated +
 * perspective-projected element stays within its original bounds — i.e.
 * the WHOLE browser tab remains visible after the tilt is applied.
 *
 * The math: for each rotation axis with angle θ, the near edge moves
 * toward the viewer by approximately (h/2) * sin(θ), where h is the
 * canvas dimension. CSS perspective then magnifies that edge by
 * P / (P - d). We invert the worst-case growth and add a 5% safety
 * margin so the Frame's drop shadow also stays visible.
 *
 * Returns a number in (0, 1]. For `none` (no tilt) the caller skips
 * this and uses 1 directly; we still handle the all-zeros case here as
 * a safety net.
 */
export function computeTiltFitScale(
  tilt: { rotate_x_deg: number; rotate_y_deg: number; rotate_z_deg: number; perspective_px: number },
  canvasH: number,
): number {
  const rx = (Math.abs(tilt.rotate_x_deg) * Math.PI) / 180;
  const ry = (Math.abs(tilt.rotate_y_deg) * Math.PI) / 180;
  // No perspective foreshortening when there's no tilt — return 1
  // exactly so the no-tilt path is a true identity.
  if (rx === 0 && ry === 0) return 1;
  // rotate_z_deg is a pure 2D rotation around the screen normal — no
  // perspective foreshortening — so it doesn't contribute to the near-
  // edge growth. (It can clip corners against the canvas, but the Frame
  // is much narrower than the canvas, so realistic z-rotations stay
  // safe.) Z is intentionally ignored here.
  const halfH = canvasH / 2;
  const dx = halfH * Math.sin(rx);
  const dy = halfH * Math.sin(ry);
  const P = Math.max(1, tilt.perspective_px);
  const growX = P / Math.max(1, P - dy); // rotateY pushes the L/R edge
  const growY = P / Math.max(1, P - dx); // rotateX pushes the T/B edge
  const maxGrow = Math.max(growX, growY);
  // Hard floor at 0.5 — beyond that the recording is too small to read.
  // The schema clamps angles at 45° anyway, so we won't hit this in
  // practice for sane inputs.
  return Math.max(0.5, Math.min(1, 0.95 / maxGrow));
}

const OutroFade: React.FC<{ profile: PolishProfile }> = ({ profile }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = (profile.outro.duration_ms / 1000) * fps;
  const opacity = interpolate(frame, [0, dur], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: profile.brand.neutral_dark,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};
