/**
 * The Remotion composition. Consumes a polish profile + a recording (frames +
 * events + cursor samples) and renders the polished video.
 *
 * Layer stack (bottom → top):
 *   1. Background (gradient/wallpaper/solid + grain)
 *   2. Frame chrome (laptop/phone/browser/window)
 *   3. Recording playback (frame sequence, transformed by auto-zoom)
 *   4. Cursor overlay (resolved from cursor.json via spring)
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
import { resolveZoomEnvelopes, zoomStateAt } from "./auto-zoom.js";
import { Background } from "./background.js";
import { Captions } from "./captions.js";
import { Cursor } from "./cursor.js";
import { Frame } from "./frame.js";
import { Stage } from "./stage.js";
import { Flourishes } from "../flourishes/index.js";
import { ClickHighlight } from "../flourishes/click-highlight.js";

export interface CompositionProps {
  manifest: RecordingManifest;
  events: RecordedEvent[];
  cursor_samples: CursorSample[];
  /** absolute file:// URL prefix for the frames dir (Remotion can't read fs) */
  frames_url_prefix: string;
  profile: PolishProfile;
}

export const PolishComposition: React.FC<CompositionProps> = ({
  manifest,
  events,
  cursor_samples,
  frames_url_prefix,
  profile,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Output timeline starts at 0; recording timeline is offset by
  // manifest.start_offset_ms (the recorder trimmed the page-load period).
  // Output t_ms maps to recording_t_ms = t_ms + start_offset_ms.
  const start_offset = manifest.start_offset_ms ?? 0;
  const t_ms = (frame / fps) * 1000;
  const visible_duration_ms = manifest.duration_ms - start_offset;

  // Shift events + cursor samples by -start_offset; filter out anything
  // before the offset so it doesn't influence the visible output.
  const visibleEvents = React.useMemo(
    () =>
      events
        .filter((e) => e.t_ms >= start_offset)
        .map((e) => ({ ...e, t_ms: e.t_ms - start_offset })),
    [events, start_offset],
  );
  const visibleCursorSamples = React.useMemo(
    () =>
      cursor_samples
        .filter((s) => s.t_ms >= start_offset)
        .map((s) => ({ ...s, t_ms: s.t_ms - start_offset })),
    [cursor_samples, start_offset],
  );

  const zoomEnvelopes = React.useMemo(
    () =>
      resolveZoomEnvelopes(visibleEvents, profile.auto_zoom, {
        viewport_width: manifest.viewport.width,
        viewport_height: manifest.viewport.height,
      }),
    [visibleEvents, profile.auto_zoom, manifest.viewport.width, manifest.viewport.height],
  );

  const cursorTrajectory = React.useMemo(() => {
    const raw = visibleCursorSamples.map((s) => ({ t_ms: s.t_ms, x: s.x, y: s.y }));
    // principle 5 (arcs): inject upward bezier midpoints on long traversals.
    // The spring's natural overshoot gives micro-arcs; this gives macro-arcs.
    const arced = injectArcWaypoints(raw, profile.cursor.path_arc_amount ?? 0);
    return resolveSpringTrajectory(arced, profile.cursor.smoothing, fps);
  }, [visibleCursorSamples, profile.cursor.smoothing, profile.cursor.path_arc_amount, fps]);

  // Kind is sampled (not springed): take the most recent sample at or
  // before current t_ms. Hard-swap behavior — the cursor changes shape
  // the instant the page would have changed it natively. Falls back to
  // "arrow" for older recordings without `kind` per sample.
  const currentCursorKind = React.useMemo(() => {
    if (!profile.cursor.contextual_swap) return "arrow" as const;
    let kind: CursorSample["kind"] = "arrow";
    for (const s of visibleCursorSamples) {
      if (s.t_ms > t_ms) break;
      if (s.kind) kind = s.kind;
    }
    return kind ?? "arrow";
  }, [visibleCursorSamples, t_ms, profile.cursor.contextual_swap]);

  const zoom = zoomStateAt(t_ms, zoomEnvelopes, profile.auto_zoom);

  // ── Camera transform via Recordly's progress-blended formulation. ─────
  // With transform-origin at TOP-LEFT (0 0), the camera transform is:
  //   scale = 1 + (peak − 1) * progress
  //   translate = (0.5 − fx*peak) * 100% * progress  (and same for y)
  // At progress=0 this is identity (recording covers scene exactly).
  // At progress=1 the focal lands at scene center.
  // The focal-clamp upstream guarantees fx ∈ [1/(2*peak), 1 − 1/(2*peak)],
  // which makes this formula coverage-safe at every intermediate progress
  // — no black bars during the in/out animation.
  //
  // (Center-origin transforms decouple scale and translate during
  // intermediate scales, producing visible gaps. Don't go back to that.)
  let progress = 0;
  if (zoom.active && zoom.envelope) {
    const env = zoom.envelope;
    const last_sub_t = env.sub_clicks[env.sub_clicks.length - 1]?.t_ms ?? env.peak_ms;
    const out_start = last_sub_t + profile.auto_zoom.hold_after_ms;
    if (t_ms < env.peak_ms) {
      progress = applyEase(profile.auto_zoom.ease_in, zoom.in_progress);
    } else if (t_ms < out_start) {
      progress = 1;
    } else if (t_ms < env.end_ms) {
      progress = 1 - applyEase(profile.auto_zoom.ease_out, zoom.out_progress);
    } else {
      progress = 0;
    }
  }

  const peakScale = profile.auto_zoom.scale;
  const easedScale = 1 + (peakScale - 1) * progress;

  const viewport_w = manifest.viewport.width;
  const viewport_h = manifest.viewport.height;

  // Focal — initial value from zoom state; cursor-follow may revise after
  // the cursor trajectory is resolved (see below). translate/parallax
  // calcs happen AFTER the cursor-follow update so they consume the
  // final focal value.
  let focalPctX = zoom.focal_x;
  let focalPctY = zoom.focal_y;

  // Cursor position for this frame (spring-smoothed, in viewport coords).
  const frameIndex = Math.min(cursorTrajectory.length - 1, frame);
  const cur = cursorTrajectory[frameIndex] ?? {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed_px_per_s: 0,
  };

  // ── Cursor-follow camera (Recordly's cursorFollowCamera pattern). ─────
  // During the HOLD phase of an active zoom (and only when the envelope
  // has a single sub-click — i.e., NOT during a connected-pan transition,
  // which already has its own focal interpolation), nudge the focal
  // toward the live cursor position. Makes long pauses inside a zoom
  // feel responsive instead of static.
  const FOLLOW_RATIO = 0.35;
  const isHoldPhase =
    zoom.active &&
    zoom.envelope !== null &&
    t_ms > zoom.envelope.peak_ms &&
    zoom.envelope.sub_clicks.length === 1 &&
    progress === 1 &&
    cur.x !== 0 &&
    cur.y !== 0;
  if (isHoldPhase) {
    const targetFx = cur.x / viewport_w;
    const targetFy = cur.y / viewport_h;
    const cursorFollowFx = lerp(zoom.focal_x, targetFx, FOLLOW_RATIO);
    const cursorFollowFy = lerp(zoom.focal_y, targetFy, FOLLOW_RATIO);
    // Re-clamp the followed focal so it stays within the bounds where the
    // recording covers the frame at the current scale.
    const margin = 1 / (2 * profile.auto_zoom.scale);
    focalPctX = clamp(cursorFollowFx, margin, 1 - margin);
    focalPctY = clamp(cursorFollowFy, margin, 1 - margin);
  }

  // Now compute camera transform from the (possibly cursor-follow-adjusted) focal.
  const translatePctX = profile.auto_zoom.pan_to_target
    ? (0.5 - focalPctX * peakScale) * 100 * progress
    : 0;
  const translatePctY = profile.auto_zoom.pan_to_target
    ? (0.5 - focalPctY * peakScale) * 100 * progress
    : 0;

  // principle 9 (secondary animation): bg drifts opposite to zoom motion.
  const bgParallaxX = zoom.active
    ? -(focalPctX - 0.5) * viewport_w * profile.background.parallax_factor * (easedScale - 1)
    : 0;
  const bgParallaxY = zoom.active
    ? -(focalPctY - 0.5) * viewport_h * profile.background.parallax_factor * (easedScale - 1)
    : 0;

  // Map output time → source frame using actual recording timestamps.
  // CDP screencast is delta-emitted (no frame on static pages), so a
  // ratio-based mapping would skip from page-load frames to mid-typing
  // frames. With timestamps, we can find the most-recent frame whose
  // capture time ≤ recording_t_ms and display it (correct: a static page
  // shows the last-emitted frame until the next visual change).
  const allIndices = manifest.frame_indices?.length
    ? manifest.frame_indices
    : Array.from({ length: manifest.frame_count }, (_, i) => i);
  const allTimestamps =
    manifest.frame_timestamps_ms?.length === allIndices.length
      ? manifest.frame_timestamps_ms
      : // Fallback for older manifests: assume uniform distribution.
        allIndices.map((_, i) =>
          (i / Math.max(1, allIndices.length - 1)) * manifest.duration_ms,
        );

  const recording_t_ms = t_ms + start_offset;
  // Binary search for the latest frame with timestamp ≤ recording_t_ms.
  let lo = 0;
  let hi = allTimestamps.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((allTimestamps[mid] ?? 0) <= recording_t_ms) lo = mid;
    else hi = mid - 1;
  }
  const sourceFrameIndex = allIndices[lo] ?? 0;
  const relPath = `${frames_url_prefix}/frame_${String(sourceFrameIndex).padStart(6, "0")}.png`;
  const sourceFrameUrl =
    frames_url_prefix.startsWith("http") || frames_url_prefix.startsWith("file:")
      ? relPath
      : staticFile(relPath);

  // Combined scene transform — Recordly-style: translate then scale, with
  // transform-origin at top-left (0 0). CSS reads right-to-left so this
  // applies scale first, then translate.
  const sceneTransform = `translate(${translatePctX}%, ${translatePctY}%) scale(${easedScale})`;

  // Use width/height to mark them as referenced (Remotion's video config
  // dimensions; useful for future per-canvas math).
  void width;
  void height;

  return (
    <AbsoluteFill>
      {/* L1: Background */}
      <Background
        profile={profile.background}
        brand={profile.brand}
        parallax_x={bgParallaxX}
        parallax_y={bgParallaxY}
      />

      {/* L2 + L3 + L4 + L5: Frame chrome wrapping a Stage that contains
          the recording, cursor, AND click-positioned flourishes (halo,
          arrow callout, etc) — all in shared viewport coordinate space.
          See compositor/stage.tsx for the architectural invariant. */}
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
            <Cursor
              x={cur.x}
              y={cur.y}
              vx={cur.vx ?? 0}
              vy={cur.vy ?? 0}
              viewport_width={viewport_w}
              viewport_height={viewport_h}
              speed_px_per_s={cur.speed_px_per_s ?? 0}
              events={visibleEvents}
              t_ms={t_ms}
              profile={profile.cursor}
              kind={currentCursorKind}
            />
            {/* Click highlight is in-stage so it tracks the recording
                under any frame size or zoom transform. */}
            <ClickHighlight
              config={profile.flourishes.click_highlight}
              ctx={{
                brand: profile.brand,
                events: visibleEvents,
                t_ms,
                total_duration_ms: visible_duration_ms,
              }}
              viewport_width={viewport_w}
              viewport_height={viewport_h}
            />
          </Stage>
        </div>
      </Frame>

      {/* L6: Captions, optional */}
      {profile.captions.mode !== "off" && (
        <Captions profile={profile.captions} events={visibleEvents} t_ms={t_ms} />
      )}

      {/* L7: Flourishes (outro logo reveal, click highlight, etc.) */}
      <Flourishes
        profile={profile.flourishes}
        brand={profile.brand}
        events={visibleEvents}
        t_ms={t_ms}
        total_duration_ms={visible_duration_ms}
      />

      {/* Outro fade is OFF by default. Only mount the Sequence when the
          user explicitly opted in via profile.outro.duration_ms > 0. */}
      {profile.outro.duration_ms > 0 && profile.outro.style !== "none" && (
        <Sequence
          from={Math.max(
            0,
            fps * (visible_duration_ms / 1000) - fps * (profile.outro.duration_ms / 1000),
          )}
          durationInFrames={Math.ceil(fps * (profile.outro.duration_ms / 1000))}
        >
          <OutroFade profile={profile} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
