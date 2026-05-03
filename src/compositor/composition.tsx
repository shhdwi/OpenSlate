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
import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

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
    () => resolveZoomEnvelopes(events, profile.auto_zoom),
    [events, profile.auto_zoom],
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

  // principle 2 (easings): apply named eases on top of raw zoom progress.
  let easedScale = 1;
  if (zoom.active && zoom.envelope) {
    const peak_scale = zoom.envelope.scale;
    if (t_ms < zoom.envelope.peak_ms) {
      easedScale = 1 + (peak_scale - 1) * applyEase(profile.auto_zoom.ease_in, zoom.in_progress);
    } else if (t_ms >= zoom.envelope.end_ms) {
      easedScale = 1;
    } else if (t_ms >= zoom.envelope.peak_ms + profile.auto_zoom.hold_after_ms) {
      easedScale =
        peak_scale - (peak_scale - 1) * applyEase(profile.auto_zoom.ease_out, zoom.out_progress);
    } else {
      easedScale = peak_scale;
    }
  }

  // principle 9 (secondary animation): bg drifts opposite to zoom focal motion.
  const bgParallaxX = zoom.active
    ? -((zoom.envelope?.focal_x ?? width / 2) - width / 2) *
      profile.background.parallax_factor *
      (easedScale - 1)
    : 0;
  const bgParallaxY = zoom.active
    ? -((zoom.envelope?.focal_y ?? height / 2) - height / 2) *
      profile.background.parallax_factor *
      (easedScale - 1)
    : 0;

  // Compute cursor position for this frame (with spring smoothing applied).
  const frameIndex = Math.min(cursorTrajectory.length - 1, frame);
  const cur = cursorTrajectory[frameIndex] ?? { x: 0, y: 0, speed_px_per_s: 0 };

  // Frame index for the recording playback. Map timeline frame → source frame.
  const sourceFrameIndex = Math.min(
    manifest.frame_count - 1,
    Math.round((t_ms / manifest.duration_ms) * (manifest.frame_count - 1)),
  );
  const sourceFrameUrl = `${frames_url_prefix}/frame_${String(sourceFrameIndex).padStart(6, "0")}.png`;

  // Auto-zoom translate: pan focal point into the center of the framed area.
  const focalX = zoom.envelope?.focal_x ?? width / 2;
  const focalY = zoom.envelope?.focal_y ?? height / 2;
  const translateX = profile.auto_zoom.pan_to_target ? (width / 2 - focalX) * (easedScale - 1) : 0;
  const translateY = profile.auto_zoom.pan_to_target ? (height / 2 - focalY) * (easedScale - 1) : 0;

  return (
    <AbsoluteFill>
      {/* L1: Background */}
      <Background
        profile={profile.background}
        brand={profile.brand}
        parallax_x={bgParallaxX}
        parallax_y={bgParallaxY}
      />

      {/* L2 + L3: Frame chrome wrapping the recording */}
      <Frame profile={profile.frame} layout={profile.layout} brand={profile.brand}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `scale(${easedScale}) translate(${translateX / easedScale}px, ${translateY / easedScale}px)`,
            transformOrigin: "center center",
            willChange: "transform",
          }}
        >
          <Img
            src={sourceFrameUrl}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
      </Frame>

      {/* L4 + L5: Cursor overlay with bounce + motion blur */}
      <Cursor
        x={cur.x}
        y={cur.y}
        speed_px_per_s={cur.speed_px_per_s ?? 0}
        events={events}
        t_ms={t_ms}
        profile={profile.cursor}
      />

      {/* L6: Captions, optional */}
      {profile.captions.mode !== "off" && (
        <Captions profile={profile.captions} events={events} t_ms={t_ms} />
      )}

      {/* L7: Flourishes (outro logo reveal, click highlight, etc.) */}
      <Flourishes profile={profile.flourishes} brand={profile.brand} events={events} t_ms={t_ms} />

      {/* Outro fade overlay */}
      {profile.outro.duration_ms > 0 && (
        <Sequence
          from={Math.max(0, fps * (manifest.duration_ms / 1000) - fps * (profile.outro.duration_ms / 1000))}
          durationInFrames={Math.ceil(fps * (profile.outro.duration_ms / 1000))}
        >
          <OutroFade profile={profile} />
        </Sequence>
      )}
    </AbsoluteFill>
  );
};

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
