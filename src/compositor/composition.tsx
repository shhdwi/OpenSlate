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
}

export const PolishComposition: React.FC<CompositionProps> = ({
  manifest,
  events,
  cursor_samples,
  frames_url_prefix,
  profile,
  edit_plan,
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

  return (
    <AbsoluteFill>
      <Background
        profile={profile.background}
        brand={profile.brand}
        parallax_x={bgParallaxX}
        parallax_y={bgParallaxY}
      />

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
