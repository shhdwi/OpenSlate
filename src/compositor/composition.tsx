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
import { resolveSpringTrajectory } from "../utils/springs.js";
import { resolveZoomEnvelopes, zoomStateAt } from "./auto-zoom.js";
import { Background } from "./background.js";
import { Captions } from "./captions.js";
import { Cursor } from "./cursor.js";
import { Frame } from "./frame.js";
import { Flourishes } from "../flourishes/index.js";

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

  const t_ms = (frame / fps) * 1000;

  const zoomEnvelopes = React.useMemo(
    () =>
      resolveZoomEnvelopes(events, profile.auto_zoom, {
        viewport_width: manifest.viewport.width,
        viewport_height: manifest.viewport.height,
      }),
    [events, profile.auto_zoom, manifest.viewport.width, manifest.viewport.height],
  );

  const cursorTrajectory = React.useMemo(
    () =>
      resolveSpringTrajectory(
        cursor_samples.map((s) => ({ t_ms: s.t_ms, x: s.x, y: s.y })),
        profile.cursor.smoothing,
        fps,
      ),
    [cursor_samples, profile.cursor.smoothing, fps],
  );

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

  // Focal is already clamped in zoomStateAt; just consume.
  const focalPctX = zoom.focal_x;
  const focalPctY = zoom.focal_y;
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

  // Cursor position for this frame (spring-smoothed, in viewport coords).
  const frameIndex = Math.min(cursorTrajectory.length - 1, frame);
  const cur = cursorTrajectory[frameIndex] ?? { x: 0, y: 0, speed_px_per_s: 0 };

  // Map timeline frame → existing source frame index, with neighbor fallback.
  const indices = manifest.frame_indices?.length
    ? manifest.frame_indices
    : Array.from({ length: manifest.frame_count }, (_, i) => i);
  const ratio = manifest.duration_ms > 0 ? t_ms / manifest.duration_ms : 0;
  const sliceIdx = Math.min(
    indices.length - 1,
    Math.max(0, Math.round(ratio * (indices.length - 1))),
  );
  const sourceFrameIndex = indices[sliceIdx] ?? 0;
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

      {/* L2 + L3 + L4 + L5: Frame chrome wrapping a single SCENE group that
          contains the recording AND the cursor in shared viewport coords.
          Auto-zoom transforms the whole group, so cursor stays glued to
          the right pixel of the recording during zoom. */}
      <Frame profile={profile.frame} layout={profile.layout} brand={profile.brand}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: sceneTransform,
            transformOrigin: "0 0",
            willChange: "transform",
            overflow: "hidden",
          }}
        >
          <Img
            src={sourceFrameUrl}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          {/* Cursor lives inside the scene; positioned in viewport % so it
              tracks the recording under any frame size or zoom transform. */}
          <Cursor
            x={cur.x}
            y={cur.y}
            viewport_width={viewport_w}
            viewport_height={viewport_h}
            speed_px_per_s={cur.speed_px_per_s ?? 0}
            events={events}
            t_ms={t_ms}
            profile={profile.cursor}
          />
        </div>
      </Frame>

      {/* L6: Captions, optional */}
      {profile.captions.mode !== "off" && (
        <Captions profile={profile.captions} events={events} t_ms={t_ms} />
      )}

      {/* L7: Flourishes (outro logo reveal, click highlight, etc.) */}
      <Flourishes profile={profile.flourishes} brand={profile.brand} events={events} t_ms={t_ms} />

      {/* Outro fade overlay */}
      {profile.outro.duration_ms > 0 && (
        <Sequence
          from={Math.max(
            0,
            fps * (manifest.duration_ms / 1000) - fps * (profile.outro.duration_ms / 1000),
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
